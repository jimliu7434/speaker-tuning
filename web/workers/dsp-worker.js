// Worker 2: DSP Web Worker (Dedicated Computation Thread)
// Loads Go WebAssembly (dsp.wasm), receives raw PCM directly from AudioWorklet
// via MessageChannel, runs Sweet Spot / Toe-in OR Bass Room Mode DSP,
// and generates standard test WAV files off the main thread.

importScripts('../wasm/wasm_exec.js');

let wasmReady = false;
let audioPort = null;
let sampleRate = 48000;
let mode = 'sweetspot'; // 'sweetspot' | 'bass'
let bassFMinHz = 40;
let samplesSinceAnalyze = 0;
let analyzeIntervalSamples = 16800; // ~350ms for sweetspot, ~900ms for bass
let isRunning = false;

async function initWasm() {
  const go = new Go();
  const wasmUrl = '../wasm/dsp.wasm';
  let result;

  if (typeof WebAssembly.instantiateStreaming === 'function') {
    try {
      result = await WebAssembly.instantiateStreaming(fetch(wasmUrl), go.importObject);
    } catch {
      const resp = await fetch(wasmUrl);
      const bytes = await resp.arrayBuffer();
      result = await WebAssembly.instantiate(bytes, go.importObject);
    }
  } else {
    const resp = await fetch(wasmUrl);
    const bytes = await resp.arrayBuffer();
    result = await WebAssembly.instantiate(bytes, go.importObject);
  }

  go.run(result.instance);
  wasmReady = true;
  self.postMessage({ type: 'wasm-ready' });
}

function configureMode() {
  samplesSinceAnalyze = 0;
  if (mode === 'bass') {
    analyzeIntervalSamples = Math.round(sampleRate * 0.90);
    if (wasmReady) {
      globalThis.dspBassInit(sampleRate, bassFMinHz);
    }
  } else {
    analyzeIntervalSamples = Math.round(sampleRate * 0.35);
    if (wasmReady) {
      globalThis.dspInit(sampleRate);
    }
  }
}

function handlePcmChunk(samples) {
  if (!wasmReady || !isRunning || !samples) {
    return;
  }
  const u8 = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);

  if (mode === 'bass') {
    globalThis.dspBassPushSamples(u8);
  } else {
    globalThis.dspPushSamples(u8);
  }

  samplesSinceAnalyze += samples.length;
  if (samplesSinceAnalyze >= analyzeIntervalSamples) {
    samplesSinceAnalyze = 0;
    const rawJson = mode === 'bass'
      ? globalThis.dspBassAnalyze()
      : globalThis.dspAnalyze();
    try {
      const data = JSON.parse(rawJson);
      self.postMessage({
        type: mode === 'bass' ? 'bass-analysis' : 'analysis',
        data,
      });
    } catch (err) {
      self.postMessage({ type: 'error', message: `DSP JSON parse error: ${err.message}` });
    }
  }
}

self.onmessage = (event) => {
  const msg = event.data;
  if (!msg) return;

  switch (msg.type) {
    case 'start': {
      sampleRate = msg.sampleRate || 48000;
      mode = msg.mode === 'bass' ? 'bass' : 'sweetspot';
      if (typeof msg.bassFMinHz === 'number') {
        bassFMinHz = msg.bassFMinHz;
      }
      configureMode();
      if (event.ports?.[0]) {
        if (audioPort) {
          audioPort.onmessage = null;
          audioPort.close();
        }
        audioPort = event.ports[0];
        audioPort.onmessage = (e) => {
          if (e.data?.type === 'pcm') {
            handlePcmChunk(e.data.samples);
          }
        };
      }
      isRunning = true;
      break;
    }
    case 'set-mode': {
      const nextMode = msg.mode === 'bass' ? 'bass' : 'sweetspot';
      if (nextMode !== mode) {
        mode = nextMode;
        if (isRunning) {
          configureMode();
        }
      }
      break;
    }
    case 'set-bass-fmin': {
      if (typeof msg.fMinHz === 'number') {
        bassFMinHz = msg.fMinHz;
        if (wasmReady) {
          globalThis.dspBassSetFMin(bassFMinHz);
        }
      }
      break;
    }
    case 'stop': {
      isRunning = false;
      if (audioPort) {
        audioPort.onmessage = null;
        audioPort.close();
        audioPort = null;
      }
      if (wasmReady) {
        globalThis.dspReset();
        globalThis.dspBassReset();
      }
      break;
    }
    case 'generate-wav': {
      if (!wasmReady) {
        self.postMessage({
          type: 'wav-error',
          requestId: msg.requestId,
          message: 'WASM 尚未載入完成',
        });
        return;
      }
      try {
        const sr = msg.sampleRate || 48000;
        const kind = msg.kind === 'bass' ? 'bass' : 'sweetspot';
        const loops = msg.loops || (kind === 'bass' ? 6 : 15);
        const wavBytes = kind === 'bass'
          ? globalThis.dspGenerateBassWav(sr, loops)
          : globalThis.dspGenerateTestWav(sr, loops);
        const copy = new Uint8Array(wavBytes.length);
        copy.set(wavBytes);
        self.postMessage(
          { type: 'wav-ready', requestId: msg.requestId, buffer: copy.buffer },
          [copy.buffer],
        );
      } catch (err) {
        self.postMessage({
          type: 'wav-error',
          requestId: msg.requestId,
          message: err.message || 'WAV 產生失敗',
        });
      }
      break;
    }
  }
};

initWasm().catch((err) => {
  self.postMessage({ type: 'error', message: `WASM 載入失敗: ${err.message}` });
});
