import { execFile, spawn } from 'node:child_process';
import { log } from '../logger.js';

const MAX_BUFFERED = 1_200_000;
const IDLE_STOP_MS = 12_000;
// EBML Cluster id: everything before it is the WebM header a late client needs.
const CLUSTER_ID = Buffer.from([0x1f, 0x43, 0xb6, 0x75]);

/**
 * Captures the audio that Chromium sends to the server's sound system and
 * streams it as live WebM/Opus to the browser.
 *
 * Chromium renders page audio into one output device (a PulseAudio null sink on
 * Linux, a DirectShow loopback device on Windows, or a generated tone for
 * transport tests). ffmpeg reads that device and writes WebM/Opus to stdout;
 * each connected client receives the same stream over `/ws/audio` and plays it
 * through Media Source Extensions. Per-tab muting happens inside the page, so
 * the mix only ever contains the active tab's media.
 */
export class AudioService {
  constructor(config) {
    this.config = config;
    this.proc = null;
    this.sockets = new Set();
    this.backend = null;
    this.reason = '';
    this.status = 'idle';
    this.starting = null;
    this.stderr = '';
    this.stopTimer = null;
    this.ffmpegChecked = null;
    this.bytes = 0;
    this.startedAt = 0;
    this.header = null;
    this.headerBuf = null;
  }

  get enabled() {
    return Boolean(this.config.audioEnabled) && this.config.audioSource !== 'off';
  }

  info() {
    return {
      enabled: this.enabled,
      status: this.enabled ? this.status : 'disabled',
      backend: this.backend?.id || null,
      backendLabel: this.backend?.label || null,
      reason: this.enabled ? this.reason || '' : 'Audio is disabled on this server (AUDIO_ENABLED=0 or AUDIO_SOURCE=off).',
      bitrateKbps: this.config.audioBitrateKbps,
      listeners: this.sockets.size,
      platform: process.platform,
    };
  }

  ffmpegAvailable() {
    if (this.ffmpegChecked) return this.ffmpegChecked;
    this.ffmpegChecked = new Promise((resolve) => {
      execFile(this.config.audioFfmpegPath, ['-version'], { timeout: 5000 }, (error) => resolve(!error));
    });
    return this.ffmpegChecked;
  }

  resolveBackend() {
    if (this.backend) return this.backend;
    if (!this.enabled) return null;
    const source = this.config.audioSource;
    const device = this.config.audioDevice;
    const input = (kind, target) => (kind === 'dshow' ? ['-f', 'dshow', '-i', `audio=${target}`] : ['-f', kind, '-i', target]);

    const dshow = () => {
      if (!device) {
        this.reason = 'AUDIO_DEVICE must name a Windows audio capture device (Stereo Mix, VB-Cable Output, …).';
        return null;
      }
      this.backend = { id: 'dshow', label: `DirectShow · ${device}`, input: input('dshow', device) };
      return this.backend;
    };

    const pulse = () => {
      const target = device || 'default';
      this.backend = { id: 'pulse', label: `PulseAudio · ${target}`, input: ['-f', 'pulse', '-i', target] };
      return this.backend;
    };

    if (source === 'tone') {
      this.backend = {
        id: 'tone',
        label: 'Generated test tone (440 Hz)',
        input: ['-re', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000'],
      };
      return this.backend;
    }
    if (source === 'dshow') return dshow();
    if (source === 'pulse') return pulse();

    if (process.platform === 'win32') {
      if (device) return dshow();
      this.reason =
        'No audio capture device configured. Set AUDIO_DEVICE to a Windows loopback device, or AUDIO_SOURCE=tone to test the audio transport.';
      return null;
    }
    if (process.platform === 'linux') return pulse();
    this.reason = `Audio capture is not implemented for ${process.platform}.`;
    return null;
  }

  setStatus(status, reason = this.reason) {
    this.status = status;
    this.reason = reason;
    this.broadcastStatus();
  }

  broadcastStatus() {
    const payload = JSON.stringify({ t: 'audio:status', ...this.info() });
    for (const ws of this.sockets) {
      try {
        if (ws.readyState === 1) ws.send(payload);
      } catch {
        /* socket closing */
      }
    }
  }

  attach(ws) {
    this.sockets.add(ws);
    ws.synced = false;
    ws.carry = null;
    clearTimeout(this.stopTimer);
    this.stopTimer = null;
    const sendStatus = () => {
      try {
        if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'audio:status', ...this.info() }));
      } catch {
        /* closing */
      }
    };
    sendStatus();
    this.start()
      .then(sendStatus)
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
    if (!this.enabled) return this.info();
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
    if (!(await this.ffmpegAvailable())) {
      this.setStatus('unavailable', `ffmpeg was not found (${this.config.audioFfmpegPath}). Install ffmpeg to enable audio.`);
      return;
    }
    const backend = this.resolveBackend();
    if (!backend) {
      this.setStatus('unavailable', this.reason || 'No audio capture device is available on this server.');
      return;
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
