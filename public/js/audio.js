import { api } from './net.js';

const SAMPLE_RATE = 48000;
const MAX_PENDING_CHUNKS = 60;

const clamp01 = (value) => Math.min(1, Math.max(0, Number(value) || 0));

/**
 * Plays the live audio stream from /ws/audio and exposes mute/volume for the
 * toolbar and settings drawer.
 *
 * Two transports are supported and the server announces which one it uses in
 * `audio:status`:
 *   - `pcm`: raw 16-bit stereo PCM played through Web Audio (an AudioWorklet
 *     ring buffer, 10 ms server chunks, ~200 ms worst-case backlog). The server
 *     does no encoding, so it costs far less CPU; a ScriptProcessor fallback
 *     keeps it working if worklets are unavailable.
 *   - `webm`: ffmpeg's Opus/WebM stream fed to Media Source Extensions, kept for
 *     DirectShow capture and for servers configured with AUDIO_CAPTURE=webm.
 *
 * Audio only starts after a user gesture, so a visitor who never interacts
 * never causes the server to open a capture.
 */
class AudioEngine extends EventTarget {
  constructor() {
    super();
    this.el = new Audio();
    this.el.preload = 'auto';
    this.el.autoplay = true;
    this.el.crossOrigin = 'anonymous';
    this.el.id = 'audio-sink';
    this.el.hidden = true;
    this.el.setAttribute('aria-hidden', 'true');
    this.volume = 0.8;
    this.muted = false;
    this.status = 'idle';
    this.reason = '';
    this.backend = null;
    this.transport = 'webm';
    this.format = null;
    this.available = true;
    this.blocked = false;
    this.started = false;
    this.ws = null;
    this.retry = 0;
    this.retryTimer = null;
    this.ms = null;
    this.sb = null;
    this.queue = [];
    this.objectUrl = null;
    this.lastTrim = 0;
    // Web Audio (raw PCM) state.
    this.ctx = null;
    this.gain = null;
    this.worklet = null;
    this.fallback = null;
    this.pcmReady = false;
    this.pcmActive = false;
    this.pcmPending = [];
    this.rawQueue = [];
    this.bufferedMs = 0;
    if (document.body) document.body.appendChild(this.el);
  }

  snapshot() {
    const playing =
      this.transport === 'pcm'
        ? Boolean(this.pcmReady && this.pcmActive && this.ctx && this.ctx.state === 'running')
        : !this.el.paused;
    return {
      status: this.status,
      reason: this.reason,
      backend: this.backend,
      transport: this.transport,
      available: this.available,
      blocked: this.blocked,
      muted: this.muted,
      volume: this.volume,
      started: this.started,
      playing,
      latencyMs: this.bufferedMs,
    };
  }

  emit(type = 'state') {
    this.dispatchEvent(new CustomEvent(type, { detail: this.snapshot() }));
  }

  /* --------------------------------------------------------- WebM (ffmpeg) */

  ensureMse() {
    if (this.ms) return;
    if (typeof window.MediaSource !== 'function') {
      this.available = false;
      this.reason = 'This browser cannot play live audio (Media Source Extensions are unavailable).';
      return;
    }
    try {
      this.ms = new MediaSource();
      this.objectUrl = URL.createObjectURL(this.ms);
      this.el.src = this.objectUrl;
      this.el.dataset.pipeline = 'loading';
      this.ms.addEventListener(
        'sourceopen',
        () => {
          try {
            this.sb = this.ms.addSourceBuffer('audio/webm; codecs="opus"');
            this.sb.mode = 'sequence';
            this.sb.addEventListener('updateend', () => {
              this.trim();
              this.pump();
            });
            this.el.dataset.pipeline = 'open';
          } catch (error) {
            this.available = false;
            this.reason = 'This browser cannot decode Opus audio.';
            this.el.dataset.pipeline = `buffer-error:${error.name}`;
            this.emit();
          }
          this.pump();
        },
        { once: true },
      );
    } catch {
      this.available = false;
      this.reason = 'The audio player could not be initialised.';
    }
    this.el.addEventListener('playing', () => this.emit('playing'));
    this.el.addEventListener('waiting', () => this.emit());
  }

  /** Rebuilds the WebM pipeline after a reconnect; a new stream has new headers. */
  resetSource() {
    this.queue.length = 0;
    this.sb = null;
    this.ms = null;
    try {
      if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    } catch {
      /* already revoked */
    }
    this.objectUrl = null;
    try {
      this.el.pause();
      this.el.removeAttribute('src');
      this.el.load();
    } catch {
      /* ignore */
    }
    // The PCM pipeline survives reconnects: the ring simply runs dry and refills.
    this.pcmPending.length = 0;
    this.rawQueue.length = 0;
    this.pcmActive = false;
    this.bufferedMs = 0;
  }

  /* ------------------------------------------------------- PCM (Web Audio) */

  async ensurePcm() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) {
        this.available = false;
        this.reason = 'This browser has no Web Audio support.';
        this.emit();
        return null;
      }
      this.ctx = new Ctx({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this.muted ? 0 : this.volume;
      this.gain.connect(this.ctx.destination);
    }
    if (this.started && this.ctx.state === 'suspended') {
      await this.ctx.resume().catch(() => {});
    }
    if (this.worklet || this.fallback) {
      this.pcmReady = true;
      return this.ctx;
    }
    try {
      await this.ctx.audioWorklet.addModule('/js/pcm-worklet.js');
      this.worklet = new AudioWorkletNode(this.ctx, 'velocity-pcm', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      this.worklet.port.onmessage = (event) => {
        this.bufferedMs = Number(event.data?.bufferedMs) || 0;
      };
      this.worklet.connect(this.gain);
      this.el.dataset.pipeline = 'pcm-worklet';
    } catch {
      this.startFallback();
    }
    this.pcmReady = true;
    return this.ctx;
  }

  /** ScriptProcessor path for browsers without AudioWorklet. */
  startFallback() {
    if (this.fallback) return;
    this.fallback = this.ctx.createScriptProcessor(2048, 0, 2);
    this.fallback.onaudioprocess = (event) => {
      const output = event.outputBuffer;
      const left = output.getChannelData(0);
      const right = output.numberOfChannels > 1 ? output.getChannelData(1) : left;
      let index = 0;
      while (index < left.length) {
        const chunk = this.rawQueue[0];
        if (!chunk) break;
        const frames = Math.min(chunk.length >> 1, left.length - index);
        for (let frame = 0; frame < frames; frame += 1) {
          left[index + frame] = chunk[frame * 2] / 32768;
          right[index + frame] = chunk[frame * 2 + 1] / 32768;
        }
        index += frames;
        if (frames === chunk.length >> 1) this.rawQueue.shift();
        else this.rawQueue[0] = chunk.subarray(frames * 2);
      }
      if (index < left.length) {
        left.fill(0, index);
        if (right !== left) right.fill(0, index);
      }
      let queued = 0;
      for (const chunk of this.rawQueue) queued += chunk.length >> 1;
      this.bufferedMs = Math.round((queued / SAMPLE_RATE) * 1000);
    };
    this.fallback.connect(this.gain);
    this.el.dataset.pipeline = 'pcm-scriptprocessor';
  }

  pushPcm(buffer) {
    if (!this.pcmReady) {
      this.pcmPending.push(buffer);
      if (this.pcmPending.length > MAX_PENDING_CHUNKS) this.pcmPending.shift();
      if (this.started && this.available) this.ensurePcm().then(() => this.drainPcm()).catch(() => {});
      return;
    }
    this.deliverPcm(buffer);
  }

  drainPcm() {
    const pending = this.pcmPending;
    this.pcmPending = [];
    for (const buffer of pending) this.deliverPcm(buffer);
  }

  deliverPcm(buffer) {
    this.pcmActive = true;
    if (this.worklet) {
      try {
        this.worklet.port.postMessage(buffer, [buffer]);
        return;
      } catch {
        /* detached or closed */
      }
    }
    const samples = new Int16Array(buffer);
    this.rawQueue.push(samples);
    // Keep at most ~400 ms queued; drop the oldest audio instead of drifting.
    let frames = this.rawQueue.reduce((total, chunk) => total + (chunk.length >> 1), 0);
    while (frames > SAMPLE_RATE * 0.4 && this.rawQueue.length > 1) {
      frames -= this.rawQueue[0].length >> 1;
      this.rawQueue.shift();
    }
  }

  /* ------------------------------------------------------------- lifecycle */

  async init() {
    try {
      const info = await api.get('/api/audio');
      this.applyStatus(info);
    } catch {
      /* older server or offline; keep optimistic defaults */
    }
    return this.snapshot();
  }

  applyStatus(info) {
    if (!info) return;
    if (info.enabled === false || info.status === 'disabled') {
      this.available = false;
      this.status = 'disabled';
      this.reason = info.reason || 'Audio is disabled on this server.';
    } else if (info.status === 'unavailable') {
      this.available = false;
      this.status = 'unavailable';
      this.reason = info.reason || 'Audio capture is unavailable on this server.';
    } else {
      this.available = true;
      this.status = info.status || 'idle';
      this.reason = info.reason || '';
    }
    const transport = info.transport === 'pcm' ? 'pcm' : 'webm';
    if (transport !== this.transport) {
      this.transport = transport;
      this.bufferedMs = 0;
      this.pcmActive = false;
      this.pcmPending.length = 0;
      this.rawQueue.length = 0;
      if (transport === 'pcm') {
        try {
          this.el.pause();
        } catch {
          /* ignore */
        }
      } else if (this.ctx) {
        this.ctx.suspend().catch(() => {});
      }
    }
    this.format = info.format || null;
    this.backend = info.backendLabel || info.backend || null;
    if (this.transport === 'pcm' && this.started && this.available) {
      this.ensurePcm().catch(() => {});
    }
    this.emit();
  }

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) return;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    let socket;
    try {
      socket = new WebSocket(`${protocol}//${window.location.host}/ws/audio`);
    } catch {
      this.scheduleRetry();
      return;
    }
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('open', () => {
      this.retry = 0;
      this.emit();
    });
    socket.addEventListener('message', (event) => {
      if (typeof event.data === 'string') {
        try {
          const message = JSON.parse(event.data);
          if (message?.t === 'audio:status') this.applyStatus(message);
        } catch {
          /* ignore */
        }
        return;
      }
      if (this.transport === 'pcm') this.pushPcm(event.data);
      else this.enqueue(event.data);
    });
    socket.addEventListener('close', () => {
      this.ws = null;
      if (!this.started) return;
      this.el.dataset.pipeline = 'closed';
      this.resetSource();
      this.status = 'reconnecting';
      this.emit();
      this.scheduleRetry();
    });
    socket.addEventListener('error', () => {
      /* close handles retry */
    });
    this.ws = socket;
  }

  scheduleRetry() {
    clearTimeout(this.retryTimer);
    const delay = Math.min(8000, 700 * 2 ** Math.min(this.retry, 4));
    this.retry += 1;
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  /**
   * Called from a user gesture. Opens the audio socket and starts playback.
   * If the browser still refuses, `blocked` is set so the UI can offer a button.
   */
  async enable() {
    this.started = true;
    if (this.available) this.connect();
    if (this.transport === 'pcm') {
      try {
        await this.ensurePcm();
        this.blocked = this.ctx?.state !== 'running';
      } catch {
        this.blocked = true;
      }
    } else {
      this.ensureMse();
      try {
        await this.el.play();
        this.blocked = false;
      } catch {
        this.blocked = true;
      }
    }
    this.emit();
    return this.snapshot();
  }

  enqueue(buffer) {
    this.ensureMse();
    this.queue.push(buffer);
    if (this.queue.length > 400) this.queue.splice(0, 200);
    this.pump();
  }

  pump() {
    if (!this.sb || this.sb.updating || !this.queue.length) return;
    if (!this.ms || this.ms.readyState !== 'open') return;
    const chunk = this.queue.shift();
    try {
      this.sb.appendBuffer(new Uint8Array(chunk));
      this.appended = (this.appended || 0) + 1;
      this.el.dataset.pipeline = `appended:${this.appended}:${this.queue.length}`;
      this.playIfNeeded();
    } catch (error) {
      this.queue.length = 0;
      this.el.dataset.pipeline = `append-error:${error.name}`;
      if (error?.name === 'QuotaExceededError') this.trim(true);
    }
  }

  playIfNeeded() {
    if (!this.el.paused) return;
    this.el
      .play()
      .then(() => {
        if (this.blocked) {
          this.blocked = false;
          this.emit();
        }
      })
      .catch(() => {
        this.blocked = true;
        this.emit();
      });
  }

  /** Keeps playback close to live by dropping old buffered media. */
  trim(force = false) {
    const now = Date.now();
    if (!force && now - this.lastTrim < 4000) return;
    this.lastTrim = now;
    try {
      const buffered = this.el.buffered;
      if (!buffered.length) return;
      const end = buffered.end(buffered.length - 1);
      if (this.el.currentTime < end - 3.5) this.el.currentTime = Math.max(0, end - 0.8);
      if (!this.sb || this.sb.updating) return;
      if (buffered.length > 2) {
        this.sb.remove(0, Math.max(0, buffered.start(buffered.length - 1) - 4));
      }
    } catch {
      /* buffer not ready */
    }
  }

  setVolume(value, { silent = false } = {}) {
    this.volume = clamp01(value);
    this.el.volume = this.volume;
    if (this.gain) this.gain.gain.value = this.muted ? 0 : this.volume;
    if (this.volume > 0 && this.muted) {
      this.muted = false;
      this.el.muted = false;
      if (this.gain) this.gain.gain.value = this.volume;
    }
    if (!silent) this.emit();
  }

  setMuted(value) {
    this.muted = Boolean(value);
    this.el.muted = this.muted;
    if (this.gain) this.gain.gain.value = this.muted ? 0 : this.volume;
    this.emit();
  }
}

export const audioEngine = new AudioEngine();
