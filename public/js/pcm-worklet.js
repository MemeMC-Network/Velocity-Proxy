/**
 * Decodes the proxy's raw PCM stream on the audio thread.
 *
 * The server sends 16-bit little-endian stereo chunks (48 kHz). They are
 * converted to float and played from a small ring buffer so playback survives
 * jitter without adding latency: playback starts as soon as one chunk arrives,
 * and if the buffer would exceed 200 ms the oldest frames are dropped, which
 * keeps the listener near live instead of drifting.
 */
const CHANNELS = 2;
const MAX_BUFFER_SECONDS = 0.2;

class VelocityPcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.capacity = Math.max(2048, Math.round(sampleRate * MAX_BUFFER_SECONDS));
    this.left = new Float32Array(this.capacity);
    this.right = new Float32Array(this.capacity);
    this.read = 0;
    this.write = 0;
    this.frames = 0;
    this.reported = 0;
    this.port.onmessage = (event) => this.push(event.data);
  }

  push(buffer) {
    const samples = new Int16Array(buffer);
    const frames = samples.length >> 1;
    if (!frames) return;
    const overflow = this.frames + frames - this.capacity;
    if (overflow > 0) {
      // Too far behind: throw away the oldest audio rather than queue it.
      this.read = (this.read + overflow) % this.capacity;
      this.frames -= overflow;
    }
    for (let frame = 0; frame < frames; frame += 1) {
      this.left[this.write] = samples[frame * CHANNELS] / 32768;
      this.right[this.write] = samples[frame * CHANNELS + 1] / 32768;
      this.write = (this.write + 1) % this.capacity;
    }
    this.frames += frames;
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const left = output[0];
    const right = output[1] || output[0];
    const count = left.length;
    let index = 0;
    for (; index < count && this.frames > 0; index += 1) {
      left[index] = this.left[this.read];
      right[index] = this.right[this.read];
      this.read = (this.read + 1) % this.capacity;
      this.frames -= 1;
    }
    if (index < count) {
      left.fill(0, index);
      if (right !== left) right.fill(0, index);
    }
    this.reported += count;
    if (this.reported >= sampleRate / 4) {
      this.reported = 0;
      this.port.postMessage({ bufferedMs: Math.round((this.frames / sampleRate) * 1000) });
    }
    return true;
  }
}

registerProcessor('velocity-pcm', VelocityPcmPlayer);
