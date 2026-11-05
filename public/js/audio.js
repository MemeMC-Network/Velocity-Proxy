import { api } from './net.js';

const clamp01 = (value) => Math.min(1, Math.max(0, Number(value) || 0));

/**
 * Plays the live WebM/Opus stream from /ws/audio through Media Source
 * Extensions, and exposes mute/volume for the toolbar and settings drawer.
 *
 * The audio element is only connected after a user gesture, so we never start
 * ffmpeg capture for a visitor who has not interacted with the page.
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
    this.attachSource();
    // Some Chromium builds pause MediaSource playback for detached elements.
    if (document.body) document.body.appendChild(this.el);
  }

  snapshot() {
    return {
      status: this.status,
      reason: this.reason,
      backend: this.backend,
      available: this.available,
      blocked: this.blocked,
      muted: this.muted,
      volume: this.volume,
      started: this.started,
      playing: !this.el.paused,
    };
  }

  emit(type = 'state') {
    this.dispatchEvent(new CustomEvent(type, { detail: this.snapshot() }));
  }

  attachSource() {
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

  /** Rebuilds the pipeline after a reconnect; a new ffmpeg stream has new headers. */
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
    this.attachSource();
  }

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
    this.backend = info.backendLabel || info.backend || null;
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
      this.enqueue(event.data);
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
    try {
      await this.el.play();
      this.blocked = false;
    } catch {
      this.blocked = true;
    }
    this.emit();
    return this.snapshot();
  }

  enqueue(buffer) {
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
    if (this.volume > 0 && this.muted) {
      this.muted = false;
      this.el.muted = false;
    }
    if (!silent) this.emit();
  }

  setMuted(value) {
    this.muted = Boolean(value);
    this.el.muted = this.muted;
    this.emit();
  }
}

export const audioEngine = new AudioEngine();
