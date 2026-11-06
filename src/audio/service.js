import { execFile, spawn } from 'node:child_process';
import { log } from '../logger.js';
import { shortHash } from '../util.js';

const MAX_BUFFERED = 1_200_000;
const IDLE_STOP_MS = 12_000;
// EBML Cluster id: everything before it is the WebM header a late client needs.
const CLUSTER_ID = Buffer.from([0x1f, 0x43, 0xb6, 0x75]);
const SHARED_KEY = 'shared';
const SINK_RETRY_MS = 60_000;

/**
 * Streams the audio of a browser session to the people watching that session.
 *
 * Chromium only chooses its output device per process, so per-session audio
 * means one Chromium process per signed-in visitor (`WorkspaceManager`) playing
 * into a PulseAudio null sink of its own (`velocity_<session>`). ffmpeg records
 * that sink's monitor and only sockets carrying the same session key receive
 * it, so two visitors never hear each other's tabs.
 *
 * `AUDIO_SOURCE=tone` also gets one capture per session, which keeps the
 * transport testable without a sound card. DirectShow on Windows exposes a
 * single system-wide loopback device, so it stays one shared capture.
 */
export class AudioService {
  constructor(config) {
    this.config = config;
    this.streams = new Map(); // capture key -> AudioStream
    this.sinks = new Map(); // capture key -> { name, moduleId }
    this.sinkFailure = null; // { message, at }
    this.ffmpegChecked = null;
  }

  get enabled() {
    return Boolean(this.config.audioEnabled) && this.config.audioSource !== 'off';
  }

  /** The backend `AUDIO_SOURCE` resolves to, without spawning anything. */
  get backendKind() {
    if (!this.enabled) return null;
    const source = this.config.audioSource;
    if (source === 'pulse' || source === 'dshow' || source === 'tone') return source;
    if (process.platform === 'win32') return this.config.audioDevice ? 'dshow' : null;
    if (process.platform === 'linux') return 'pulse';
    return null;
  }

  /** True when every session can have a capture of its own. */
  get perSession() {
    const kind = this.backendKind;
    return Boolean(this.config.audioPerSession) && (kind === 'pulse' || kind === 'tone');
  }

  get streamCount() {
    return this.streams.size;
  }

  ffmpegAvailable() {
    if (this.ffmpegChecked) return this.ffmpegChecked;
    this.ffmpegChecked = new Promise((resolve) => {
      execFile(this.config.audioFfmpegPath, ['-version'], { timeout: 5000 }, (error) => resolve(!error));
    });
    return this.ffmpegChecked;
  }

  /* ---------------------------------------------------------------- sinks */

  /** PulseAudio sink name for a session; short and hex-only. */
  sinkName(key) {
    return `velocity_${shortHash(key, 16)}`;
  }

  sinkFor(key) {
    return this.sinks.get(key)?.name || null;
  }

  pulseEnv() {
    return this.config.audioPulseServer
      ? { ...process.env, PULSE_SERVER: this.config.audioPulseServer }
      : process.env;
  }

  /**
   * Creates the session's sink (idempotent) and returns its name, or null when
   * the sink could not be created - in that case the capture falls back to the
   * shared device so audio still works, just not per session.
   */
  async prepareSink(key) {
    if (!this.perSession || this.backendKind !== 'pulse') return null;
    const existing = this.sinks.get(key);
    if (existing) return existing.name;
    if (this.sinkFailure && Date.now() - this.sinkFailure.at < SINK_RETRY_MS) return null;

    const name = this.sinkName(key);
    const moduleId = await this.loadSink(name);
    if (!moduleId) return null;
    this.sinkFailure = null;
    this.sinks.set(key, { name, moduleId });
    return name;
  }

  loadSink(name) {
    return new Promise((resolve) => {
      execFile(
        this.config.audioPactlPath,
        [
          'load-module',
          'module-null-sink',
          `sink_name=${name}`,
          'rate=48000',
          'channels=2',
          'sink_properties=device.description=VelocityProxy-Session',
        ],
        { timeout: 5000, env: this.pulseEnv() },
        (error, stdout) => {
          if (error) {
            const message = `Could not create a per-session audio sink (${String(error.message).split('\n')[0]}); falling back to one shared capture.`;
            if (!this.sinkFailure) log.warn(message);
            this.sinkFailure = { message, at: Date.now() };
            resolve(null);
            return;
          }
          resolve(String(stdout).trim().split(/\s+/)[0] || null);
        },
      );
    });
  }

  releaseSink(key) {
    const entry = this.sinks.get(key);
    if (!entry) return;
    this.sinks.delete(key);
    if (!entry.moduleId) return;
    execFile(
      this.config.audioPactlPath,
      ['unload-module', String(entry.moduleId)],
      { timeout: 5000, env: this.pulseEnv() },
      () => {},
    );
  }

  /* -------------------------------------------------------------- streams */

  /** Session keys are only honoured when each session can be routed apart. */
  keyFor(key) {
    return this.perSession ? String(key || 'default') : SHARED_KEY;
  }

  streamFor(key) {
    const id = this.keyFor(key);
    let stream = this.streams.get(id);
    if (!stream) {
      stream = new AudioStream(this, id);
      this.streams.set(id, stream);
    }
    return stream;
  }

  attach(key, ws) {
    this.streamFor(key).attach(ws);
  }

  info(key) {
    if (!this.enabled) {
      return {
        enabled: false,
        status: 'disabled',
        backend: null,
        backendLabel: null,
        reason: 'Audio is disabled on this server (AUDIO_ENABLED=0 or AUDIO_SOURCE=off).',
        bitrateKbps: this.config.audioBitrateKbps,
        listeners: 0,
        platform: process.platform,
        perSession: false,
        isolated: false,
      };
    }
    return this.streamFor(key).info();
  }

  overallStatus() {
    if (!this.enabled) return 'disabled';
    if (!this.streams.size) return 'idle';
    const statuses = [...this.streams.values()].map((stream) => stream.status);
    if (statuses.includes('live')) return 'live';
    if (statuses.includes('unavailable')) return 'unavailable';
    if (statuses.includes('starting')) return 'starting';
    return 'idle';
  }

  /** Drops a session's capture and sink, e.g. when its browser goes away. */
  releaseSession(key) {
    const id = this.keyFor(key);
    const stream = this.streams.get(id);
    if (stream) {
      stream.stop();
      this.streams.delete(id);
    }
    this.releaseSink(id);
  }

  stop() {
    for (const stream of this.streams.values()) stream.stop();
    this.streams.clear();
    for (const key of [...this.sinks.keys()]) this.releaseSink(key);
  }
}

/** One ffmpeg capture (and its listeners) for one session. */
class AudioStream {
  constructor(hub, key) {
    this.hub = hub;
    this.config = hub.config;
    this.key = key;
    this.shared = key === SHARED_KEY;
    this.proc = null;
    this.sockets = new Set();
    this.backend = null;
    this.reason = '';
    this.status = 'idle';
    this.starting = null;
    this.stderr = '';
    this.stopTimer = null;
    this.bytes = 0;
    this.startedAt = 0;
    this.header = null;
    this.headerBuf = null;
  }

  info() {
    const backend = this.backend || this.resolveBackend();
    const enabled = this.hub.enabled;
    return {
      enabled,
      status: enabled ? this.status : 'disabled',
      backend: backend?.id || null,
      backendLabel: backend?.label || null,
      reason: enabled
        ? this.reason || ''
        : 'Audio is disabled on this server (AUDIO_ENABLED=0 or AUDIO_SOURCE=off).',
      bitrateKbps: this.config.audioBitrateKbps,
      listeners: this.sockets.size,
      platform: process.platform,
      perSession: this.hub.perSession,
      isolated: Boolean(this.hub.sinkFor(this.key)),
    };
  }

  /** The ffmpeg input for this session, or null when capture is impossible. */
  resolveBackend() {
    const kind = this.hub.backendKind;
    const device = this.config.audioDevice;
    if (!kind) {
      this.reason = this.hub.enabled
        ? 'No audio capture device is available on this server.'
        : 'Audio is disabled on this server (AUDIO_ENABLED=0 or AUDIO_SOURCE=off).';
      return null;
    }
    if (kind === 'tone') {
      return {
        id: 'tone',
        label: 'Generated test tone (440 Hz)',
        input: ['-re', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000'],
      };
    }
    if (kind === 'dshow') {
      if (!device) {
        this.reason = 'AUDIO_DEVICE must name a Windows audio capture device (Stereo Mix, VB-Cable Output, …).';
        return null;
      }
      return { id: 'dshow', label: `DirectShow · ${device}`, input: ['-f', 'dshow', '-i', `audio=${device}`] };
    }
    const sink = this.hub.sinkFor(this.key);
    const target = sink ? `${sink}.monitor` : device || 'default';
    return { id: 'pulse', label: `PulseAudio · ${target}`, input: ['-f', 'pulse', '-i', target] };
  }

  setStatus(status, reason = this.reason) {
    this.status = status;
    this.reason = reason;
    this.broadcastStatus();
  }

  statusPayload() {
    return JSON.stringify({ t: 'audio:status', ...this.info() });
  }

  broadcastStatus() {
    const payload = this.statusPayload();
    for (const ws of this.sockets) {
      try {
        if (ws.readyState === 1) ws.send(payload);
      } catch {
        /* socket closing */
      }
    }
  }

  sendStatus(ws) {
    try {
      if (ws.readyState === 1) ws.send(this.statusPayload());
    } catch {
      /* closing */
    }
  }

  attach(ws) {
    this.sockets.add(ws);
    ws.synced = false;
    ws.carry = null;
    clearTimeout(this.stopTimer);
    this.stopTimer = null;
    this.sendStatus(ws);
    this.start()
      .then(() => this.sendStatus(ws))
      .catch((error) => log.debug('audio start failed', error.message));

    ws.on('close', () => {
      this.sockets.delete(ws);
      this.scheduleStop();
    });
    ws.on('error', () => {
      this.sockets.delete(ws);
    });
  }

  scheduleStop() {
    if (this.sockets.size || !this.proc) return;
    clearTimeout(this.stopTimer);
    this.stopTimer = setTimeout(() => {
      this.stopTimer = null;
      if (this.sockets.size) return;
      log.debug('audio idle - stopping capture');
      this.stop();
    }, IDLE_STOP_MS);
    this.stopTimer.unref?.();
  }

  async start() {
    if (!this.hub.enabled) return this.info();
    if (this.proc) return this.info();
    if (this.starting) {
      await this.starting;
      return this.info();
    }
    this.starting = this.launch();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
    return this.info();
  }

  async launch() {
    if (!(await this.hub.ffmpegAvailable())) {
      this.setStatus('unavailable', `ffmpeg was not found (${this.config.audioFfmpegPath}). Install ffmpeg to enable audio.`);
      return;
    }
    // The sink must exist before Chromium is launched and before ffmpeg reads it.
    if (this.hub.perSession) await this.hub.prepareSink(this.key);
    const backend = this.resolveBackend();
    if (!backend) {
      this.setStatus('unavailable', this.reason || 'No audio capture device is available on this server.');
      return;
    }
    this.backend = backend;
    if (this.hub.perSession && backend.id === 'pulse' && !this.hub.sinkFor(this.key)) {
      log.warn('Audio for this session is sharing the default sink because its own sink is unavailable');
    }

    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      ...backend.input,
      '-ac',
      '2',
      '-ar',
      '48000',
      '-c:a',
      'libopus',
      '-b:a',
      `${this.config.audioBitrateKbps}k`,
      '-application',
      'lowdelay',
      '-f',
      'webm',
      '-cluster_size_limit',
      '2097152',
      '-cluster_time_limit',
      '1000',
      'pipe:1',
    ];

    this.stderr = '';
    this.status = 'starting';
    this.header = null;
    this.headerBuf = null;
    for (const socket of this.sockets) {
      socket.synced = false;
      socket.carry = null;
    }
    this.broadcastStatus();

    let proc;
    try {
      proc = spawn(this.config.audioFfmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      this.setStatus('unavailable', `Could not start ffmpeg: ${error.message}`);
      return;
    }
    this.proc = proc;
    let firstChunk = true;

    proc.stdout.on('data', (chunk) => {
      if (!chunk?.length) return;
      if (firstChunk) {
        firstChunk = false;
        this.startedAt = Date.now();
        this.setStatus('live');
        log.info(`Audio capture live (${backend.label}, ${this.config.audioBitrateKbps} kbps Opus)`);
      }
      this.bytes += chunk.length;
      this.captureHeader(chunk);
      for (const ws of this.sockets) this.sendChunk(ws, chunk);
    });

    proc.stderr.on('data', (chunk) => {
      this.stderr = `${this.stderr}${chunk.toString()}`.slice(-2000);
    });

    proc.on('error', (error) => {
      this.proc = null;
      this.setStatus('unavailable', `ffmpeg could not start: ${error.message}`);
    });

    proc.on('exit', (code) => {
      const expected = this.status === 'stopping';
      this.proc = null;
      this.bytes = 0;
      if (expected) {
        this.status = 'idle';
        return;
      }
      const detail = this.stderr.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300);
      const reason = detail
        ? `Audio capture stopped: ${detail}`
        : `Audio capture stopped (ffmpeg exit ${code}).`;
      if (this.sockets.size) {
        this.setStatus('unavailable', reason);
        log.warn(reason);
      } else {
        this.status = 'idle';
      }
    });
  }

  /** Keeps the WebM header so clients that connect mid-stream can decode. */
  captureHeader(chunk) {
    if (this.header) return;
    const buffer = this.headerBuf ? Buffer.concat([this.headerBuf, chunk]) : chunk;
    const index = buffer.indexOf(CLUSTER_ID);
    if (index === -1) {
      this.headerBuf = buffer.length > 32768 ? buffer.subarray(buffer.length - 32768) : buffer;
      return;
    }
    this.header = Buffer.from(buffer.subarray(0, index));
    this.headerBuf = null;
  }

  sendChunk(ws, chunk) {
    if (ws.readyState !== 1) return;
    if (ws.bufferedAmount > MAX_BUFFERED) return; // drop rather than queue stale audio
    try {
      if (ws.synced) {
        ws.send(chunk, { binary: true });
        return;
      }
      // A fresh listener starts on a cluster boundary so the stream is decodable.
      ws.carry = ws.carry ? Buffer.concat([ws.carry, chunk]) : chunk;
      const index = ws.carry.indexOf(CLUSTER_ID);
      if (index === -1) {
        if (ws.carry.length > 256 * 1024) ws.carry = null;
        return;
      }
      const payload = ws.carry.subarray(index);
      if (this.header?.length) ws.send(this.header, { binary: true });
      ws.send(payload, { binary: true });
      ws.carry = null;
      ws.synced = true;
    } catch {
      /* closing */
    }
  }

  stop() {
    clearTimeout(this.stopTimer);
    this.stopTimer = null;
    if (!this.proc) {
      this.status = 'idle';
      return;
    }
    this.status = 'stopping';
    const proc = this.proc;
    this.proc = null;
    try {
      proc.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    this.status = 'idle';
  }
}
