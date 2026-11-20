// Worker 1: AudioWorkletProcessor (Dedicated Real-Time Audio Thread)
// Only captures raw PCM audio and transfers chunks directly to DSP Web Worker
// via MessageChannel, keeping both the audio thread and UI thread unblocked.

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunkSize = 2048;
    this.buffer = new Float32Array(this.chunkSize);
    this.offset = 0;
    this.dspPort = null;
    this.active = true;

    this.port.onmessage = (event) => {
      const msg = event.data;
      if (msg?.type === 'connect-dsp' && event.ports?.[0]) {
        this.dspPort = event.ports[0];
      } else if (msg?.type === 'stop') {
        this.active = false;
      }
    };
  }

  process(inputs) {
    if (!this.active) {
      return false;
    }

    const input = inputs[0];
    if (!input || input.length === 0 || !input[0]) {
      return true;
    }

    const channel = input[0];
    let readIdx = 0;

    while (readIdx < channel.length) {
      const space = this.chunkSize - this.offset;
      const toCopy = Math.min(space, channel.length - readIdx);
      this.buffer.set(channel.subarray(readIdx, readIdx + toCopy), this.offset);
      this.offset += toCopy;
      readIdx += toCopy;

      if (this.offset >= this.chunkSize) {
        if (this.dspPort) {
          const out = this.buffer;
          this.buffer = new Float32Array(this.chunkSize);
          this.dspPort.postMessage(
            { type: 'pcm', samples: out },
            [out.buffer],
          );
        }
        this.offset = 0;
      }
    }

    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
