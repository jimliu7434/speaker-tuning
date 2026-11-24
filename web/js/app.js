import {
  drawStageRadar,
  drawCorrelationWave,
  drawLiveWaveform,
  drawBassResponse,
} from './visuals.js';

const el = {
  wasmStatus: document.getElementById('wasm-status'),
  btnStartMic: document.getElementById('btn-start-mic'),
  btnStopMic: document.getElementById('btn-stop-mic'),
  btnCaptureMode: document.getElementById('btn-capture-mode'),
  btnQuickWav: document.getElementById('btn-quick-wav'),
  btnPlayTest: document.getElementById('btn-play-test'),
  btnDownloadWav: document.getElementById('btn-download-wav'),
  btnPlayBassTest: document.getElementById('btn-play-bass-test'),
  btnDownloadBassWav: document.getElementById('btn-download-bass-wav'),
  btnPlayBassTest2: document.getElementById('btn-play-bass-test-2'),
  btnDownloadBassWav2: document.getElementById('btn-download-bass-wav-2'),
  btnLockBaseline: document.getElementById('btn-lock-baseline'),
  btnClearBaseline: document.getElementById('btn-clear-baseline'),
  btnModeSeat: document.getElementById('btn-mode-seat'),
  btnModeSpeaker: document.getElementById('btn-mode-speaker'),
  speakerActionBox: document.getElementById('speaker-action-box'),
  sweetSpotBadge: document.getElementById('sweet-spot-badge'),
  sweetSpotHint: document.getElementById('sweet-spot-hint'),
  offsetReadout: document.getElementById('offset-readout'),
  deltaMsReadout: document.getElementById('delta-ms-readout'),
  splDiffReadout: document.getElementById('spl-diff-readout'),
  snrReadout: document.getElementById('snr-readout'),
  toeInMini: document.getElementById('toe-in-mini'),
  hfAsymMini: document.getElementById('hf-asym-mini'),
  toeInBadge: document.getElementById('toe-in-badge'),
  toeInHint: document.getElementById('toe-in-hint'),
  hfLeftReadout: document.getElementById('hf-left-readout'),
  hfRightReadout: document.getElementById('hf-right-readout'),
  hfAsymReadout: document.getElementById('hf-asym-readout'),
  clarityReadout: document.getElementById('clarity-readout'),
  baselineInfo: document.getElementById('baseline-info'),
  rmsReadout: document.getElementById('rms-readout'),
  // Bass Room Modes UI
  bassBadge: document.getElementById('bass-badge'),
  bassHint: document.getElementById('bass-hint'),
  selectBassFMin: document.getElementById('select-bass-fmin'),
  toggleBassDetrend: document.getElementById('toggle-bass-detrend'),
  bassSmoothReadout: document.getElementById('bass-smooth-readout'),
  bassSpreadReadout: document.getElementById('bass-spread-readout'),
  bassPeaksReadout: document.getElementById('bass-peaks-readout'),
  bassNullsReadout: document.getElementById('bass-nulls-readout'),
  btnSnapA: document.getElementById('btn-snap-a'),
  btnSnapB: document.getElementById('btn-snap-b'),
  btnSnapClear: document.getElementById('btn-snap-clear'),
  snapCompareInfo: document.getElementById('snap-compare-info'),
  errorBanner: document.getElementById('error-banner'),
  canvasStage: document.getElementById('canvas-stage'),
  canvasCorr: document.getElementById('canvas-corr'),
  canvasWave: document.getElementById('canvas-wave'),
  canvasBass: document.getElementById('canvas-bass'),
  tabButtons: [...document.querySelectorAll('.tab-btn')],
  tabPanels: [...document.querySelectorAll('.tab-panel')],
};

let dspWorker = null;
let wasmReady = false;
let audioCtx = null;
let micStream = null;
let workletNode = null;

let activeTab = 'sweetspot';
let tuningMode = 'seat'; // 'seat' (move listener) | 'speaker' (fixed seat, move/aim speakers)
let oneShotMode = true;  // true: collect N distinct rounds then auto-stop & lock averaged result
let bassFMinHz = 40;
let bassDetrended = true;

// One-shot round accumulator state
const ONE_SHOT_CONFIG = {
  sweetspot: { targetRounds: 4, minIntervalMs: 1600 },
  bass: { targetRounds: 2, minIntervalMs: 4800 },
};
let oneShotSamples = [];
let lastRoundCaptureMs = 0;
let isMeasuring = false;

let activeAudioEl = null;
let activeAudioKind = null; // 'sweetspot' | 'bass' | null
const wavUrls = { sweetspot: null, bass: null };

let latestResult = null;
let latestBassResult = null;
let baseline = null; // { hfRatioL, hfRatioR }
let bassSnapA = null;
let bassSnapB = null;

let wavRequestSeq = 0;
const pendingWavRequests = new Map();

function showError(message) {
  if (!message) {
    el.errorBanner.hidden = true;
    el.errorBanner.replaceChildren();
    return;
  }
  el.errorBanner.hidden = false;
  el.errorBanner.replaceChildren(message);
}

function currentDspMode() {
  return activeTab === 'bass' ? 'bass' : 'sweetspot';
}

function switchTab(targetTab) {
  activeTab = targetTab;
  for (const btn of el.tabButtons) {
    btn.setAttribute('aria-selected', String(btn.dataset.tab === targetTab));
  }
  for (const panel of el.tabPanels) {
    panel.hidden = panel.dataset.panel !== targetTab;
  }

  // Seamlessly switch DSP worker mode when moving between SweetSpot/Toe-in and Bass Room Modes
  if (dspWorker && wasmReady) {
    dspWorker.postMessage({ type: 'set-mode', mode: currentDspMode() });
  }
  oneShotSamples = [];
  lastRoundCaptureMs = 0;

  el.btnQuickWav.textContent = targetTab === 'bass' ? '⬇ 低頻WAV' : '⬇ WAV';

  requestAnimationFrame(() => {
    if (targetTab === 'sweetspot') {
      drawStageRadar(el.canvasStage, latestResult, tuningMode);
      drawCorrelationWave(el.canvasCorr, latestResult);
      drawLiveWaveform(el.canvasWave, latestResult);
    } else if (targetTab === 'bass') {
      redrawBassChart();
    }
  });
}

function setTuningMode(nextMode) {
  tuningMode = nextMode === 'speaker' ? 'speaker' : 'seat';
  el.btnModeSeat.setAttribute('aria-pressed', String(tuningMode === 'seat'));
  el.btnModeSpeaker.setAttribute('aria-pressed', String(tuningMode === 'speaker'));
  if (latestResult) {
    renderAnalysis(latestResult);
  } else {
    el.speakerActionBox.hidden = true;
    el.sweetSpotHint.textContent = tuningMode === 'speaker'
      ? '將手機固定在您實際常坐的位置，點「開始收音量測」，系統會告訴您怎麼調左右喇叭！'
      : '點擊下方「開始量測」並由音響播放皇帝位測試 WAV';
    drawStageRadar(el.canvasStage, null, tuningMode);
  }
}

function buildSpeakerGuideRow(tagText, bodyText) {
  const row = document.createElement('div');
  row.className = 'speaker-guide-row';
  const tag = document.createElement('span');
  tag.className = 'speaker-guide-tag';
  tag.textContent = tagText;
  const body = document.createElement('span');
  body.textContent = bodyText;
  row.append(tag, body);
  return row;
}

function redrawBassChart() {
  drawBassResponse(el.canvasBass, latestBassResult, {
    detrended: bassDetrended,
    snapA: bassSnapA,
    snapB: bassSnapB,
    fMinHz: bassFMinHz,
  });
}

function initDspWorker() {
  const readyGate = Promise.withResolvers();
  dspWorker = new Worker('./workers/dsp-worker.js');

  dspWorker.onmessage = (event) => {
    const msg = event.data;
    if (!msg) return;

    switch (msg.type) {
      case 'wasm-ready':
        wasmReady = true;
        el.wasmStatus.textContent = 'WASM 就緒';
        el.wasmStatus.dataset.state = 'ready';
        el.btnStartMic.disabled = false;
        el.btnQuickWav.disabled = false;
        el.btnPlayTest.disabled = false;
        el.btnDownloadWav.disabled = false;
        el.btnPlayBassTest.disabled = false;
        el.btnDownloadBassWav.disabled = false;
        el.btnPlayBassTest2.disabled = false;
        el.btnDownloadBassWav2.disabled = false;
        readyGate.resolve();
        break;

      case 'analysis':
        handleSweetSpotFrame(msg.data);
        break;

      case 'bass-analysis':
        handleBassFrame(msg.data);
        break;

      case 'wav-ready': {
        const pending = pendingWavRequests.get(msg.requestId);
        if (pending) {
          pendingWavRequests.delete(msg.requestId);
          pending.resolve(msg.buffer);
        }
        break;
      }

      case 'wav-error': {
        const pending = pendingWavRequests.get(msg.requestId);
        if (pending) {
          pendingWavRequests.delete(msg.requestId);
          pending.reject(new Error(msg.message));
        }
        break;
      }

      case 'error':
        showError(msg.message);
        if (!wasmReady) {
          el.wasmStatus.textContent = '載入失敗';
          el.wasmStatus.dataset.state = 'error';
          readyGate.reject(new Error(msg.message));
        }
        break;
    }
  };

  dspWorker.onerror = (err) => {
    const msg = `DSP Worker 錯誤: ${err.message || '未知錯誤'}`;
    showError(msg);
    if (!wasmReady) {
      readyGate.reject(new Error(msg));
    }
  };

  return readyGate.promise;
}

async function requestTestWavBuffer(kind = 'sweetspot') {
  if (!wasmReady) {
    throw new Error('Go WASM 尚未就緒');
  }
  const requestId = ++wavRequestSeq;
  const { promise, resolve, reject } = Promise.withResolvers();
  pendingWavRequests.set(requestId, { resolve, reject });
  dspWorker.postMessage({
    type: 'generate-wav',
    requestId,
    kind,
    sampleRate: 48000,
    loops: kind === 'bass' ? 6 : 60,
  });
  return promise;
}

async function ensureWavUrl(kind) {
  if (wavUrls[kind]) return wavUrls[kind];
  const buffer = await requestTestWavBuffer(kind);
  const blob = new Blob([buffer], { type: 'audio/wav' });
  wavUrls[kind] = URL.createObjectURL(blob);
  return wavUrls[kind];
}

async function handleDownloadWav(kind, triggerBtn) {
  showError('');
  const originalText = triggerBtn?.textContent;
  if (triggerBtn) {
    triggerBtn.disabled = true;
    triggerBtn.textContent = '產生 WAV 中...';
  }
  try {
    const url = await ensureWavUrl(kind);
    const link = document.createElement('a');
    link.href = url;
    link.download = kind === 'bass'
      ? 'speaker-tuning-bass-48k.wav'
      : 'speaker-tuning-test-48k.wav';
    document.body.append(link);
    link.click();
    link.remove();
  } catch (err) {
    showError(`下載 WAV 失敗：${err.message}`);
  } finally {
    if (triggerBtn) {
      triggerBtn.textContent = originalText;
      triggerBtn.disabled = false;
    }
  }
}

function updatePlayButtonLabels() {
  const playingSweet = activeAudioKind === 'sweetspot';
  const playingBass = activeAudioKind === 'bass';
  el.btnPlayTest.textContent = playingSweet ? '⏹ 停止播放皇帝位測試音' : '▶ 在本裝置循環播放皇帝位測試音';
  el.btnPlayBassTest.textContent = playingBass ? '⏹ 停止播放低頻掃頻' : '▶ 在本裝置循環播放低頻掃頻';
  el.btnPlayBassTest2.textContent = playingBass ? '⏹ 停止播放低頻掃頻' : '▶ 在本裝置循環播放低頻掃頻';
}

async function handleTogglePlay(kind) {
  showError('');
  if (activeAudioEl && activeAudioKind === kind) {
    activeAudioEl.pause();
    activeAudioEl.currentTime = 0;
    activeAudioKind = null;
    updatePlayButtonLabels();
    return;
  }

  if (activeAudioEl) {
    activeAudioEl.pause();
    activeAudioEl.currentTime = 0;
    activeAudioKind = null;
  }

  try {
    const url = await ensureWavUrl(kind);
    activeAudioEl = new Audio(url);
    activeAudioEl.loop = true;
    await activeAudioEl.play();
    activeAudioKind = kind;
    updatePlayButtonLabels();
  } catch (err) {
    showError(`無法播放測試音：${err.message}`);
    updatePlayButtonLabels();
  }
}

async function startMeasurement() {
  showError('');
  if (!navigator.mediaDevices?.getUserMedia) {
    showError('此瀏覽器不支援麥克風存取，請確認使用 HTTPS 並以 Safari / Chrome 開啟。');
    return;
  }

  el.btnStartMic.disabled = true;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    });

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AudioCtx({ latencyHint: 'interactive' });
    if (audioCtx.state === 'suspended') {
      await audioCtx.resume();
    }

    await audioCtx.audioWorklet.addModule('./workers/capture-worklet.js');

    const source = audioCtx.createMediaStreamSource(micStream);
    workletNode = new AudioWorkletNode(audioCtx, 'capture-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
    });

    // Direct MessageChannel: AudioWorklet (Worker 1) -> DSP Web Worker (Worker 2)
    const channel = new MessageChannel();
    dspWorker.postMessage(
      {
        type: 'start',
        sampleRate: audioCtx.sampleRate,
        mode: currentDspMode(),
        bassFMinHz,
      },
      [channel.port1],
    );
    workletNode.port.postMessage(
      { type: 'connect-dsp' },
      [channel.port2],
    );

    source.connect(workletNode);
    isMeasuring = true;
    oneShotSamples = [];
    lastRoundCaptureMs = 0;

    el.btnStartMic.hidden = true;
    el.btnStopMic.hidden = false;
    el.btnStopMic.disabled = false;
    el.btnStopMic.textContent = oneShotMode
      ? `⏹ 停止（收集 0/${ONE_SHOT_CONFIG[currentDspMode()].targetRounds} 輪）`
      : '⏹ 停止收音';
    el.btnLockBaseline.disabled = false;
    el.sweetSpotBadge.textContent = oneShotMode ? '單次量測中 (0/4)' : '收音中...';
    el.sweetSpotBadge.dataset.status = 'buffering';
    el.bassBadge.textContent = oneShotMode ? '單次量測中 (0/2)' : '收音中...';
    el.bassBadge.dataset.status = 'buffering';
  } catch (err) {
    const wrapped = new Error(`啟動麥克風失敗：${err.message}`, { cause: err });
    showError(wrapped.message);
    await stopMeasurement();
  }
}

async function stopMeasurement() {
  isMeasuring = false;
  if (dspWorker) {
    dspWorker.postMessage({ type: 'stop' });
  }
  if (workletNode) {
    try {
      workletNode.port.postMessage({ type: 'stop' });
      workletNode.disconnect();
    } catch {
      // ignore disconnect errors
    }
    workletNode = null;
  }
  if (micStream) {
    for (const track of micStream.getTracks()) {
      track.stop();
    }
    micStream = null;
  }
  if (audioCtx) {
    try {
      await audioCtx.close();
    } catch {
      // ignore close errors
    }
    audioCtx = null;
  }

  el.btnStopMic.hidden = true;
  el.btnStopMic.disabled = true;
  el.btnStopMic.textContent = '⏹ 停止收音';
  el.btnStartMic.hidden = false;
  el.btnStartMic.disabled = !wasmReady;
  el.btnLockBaseline.disabled = !latestResult?.detected;
}

function meanOf(arr, selector) {
  return arr.reduce((sum, item) => sum + selector(item), 0) / arr.length;
}

function medianOf(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) * 0.5
    : sorted[mid];
}

function averageSweetSpotResults(samples) {
  const rawOf = (s, rawKey, fallbackKey) => (
    typeof s[rawKey] === 'number' ? s[rawKey] : s[fallbackKey]
  );

  const allDeltas = samples.map((s) => rawOf(s, 'rawDeltaMs', 'deltaMs'));
  const medDelta = medianOf(allDeltas);

  // Reject outlier rounds deviating > 0.6ms from the median
  const inliers = samples.filter((s) => Math.abs(rawOf(s, 'rawDeltaMs', 'deltaMs') - medDelta) <= 0.6);
  const used = inliers.length >= 2 ? inliers : samples;

  const usedDeltas = used.map((s) => rawOf(s, 'rawDeltaMs', 'deltaMs'));
  const spreadMs = Math.max(...usedDeltas) - Math.min(...usedDeltas);
  const unstable = inliers.length < 2 || spreadMs > 0.8;

  const last = structuredClone(used.at(-1));
  last.deltaMs = Math.round(meanOf(used, (s) => rawOf(s, 'rawDeltaMs', 'deltaMs')) * 1000) / 1000;
  last.offsetCm = Math.round(meanOf(used, (s) => rawOf(s, 'rawOffsetCm', 'offsetCm')) * 100) / 100;
  last.splDiffDb = Math.round(meanOf(used, (s) => rawOf(s, 'rawSplDiffDb', 'splDiffDb')) * 100) / 100;
  last.hfRatioL = Math.round(meanOf(used, (s) => rawOf(s, 'rawHfRatioL', 'hfRatioL')) * 100) / 100;
  last.hfRatioR = Math.round(meanOf(used, (s) => rawOf(s, 'rawHfRatioR', 'hfRatioR')) * 100) / 100;
  last.toeInAsymDb = Math.round(meanOf(used, (s) => rawOf(s, 'rawToeInAsymDb', 'toeInAsymDb')) * 100) / 100;
  last.clarityL = Math.round(meanOf(used, (s) => rawOf(s, 'rawClarityL', 'clarityL')) * 100) / 100;
  last.clarityR = Math.round(meanOf(used, (s) => rawOf(s, 'rawClarityR', 'clarityR')) * 100) / 100;

  last.lockedRounds = used.length;
  last.totalRounds = samples.length;
  last.spreadMs = Math.round(spreadMs * 1000) / 1000;
  last.unstable = unstable;
  last.roundDeltasMs = allDeltas.map((v) => Math.round(v * 100) / 100);

  const absCm = Math.abs(last.offsetCm);
  const stabilityTag = unstable
    ? `⚠ 波動過大 ±${(spreadMs * 0.5).toFixed(2)} ms`
    : `${used.length}/${samples.length} 輪有效，穩定度 ±${(spreadMs * 0.5).toFixed(2)} ms`;

  if (unstable) {
    last.sweetSpotStatus = 'waiting';
    last.sweetSpotHint = `量測波動過大（各輪 Δt: ${last.roundDeltasMs.join(', ')} ms），請保持手機完全靜止、確認音量足夠後重測，切勿依此調整 DSP。`;
  } else if (absCm <= 1.5) {
    last.sweetSpotStatus = 'centered';
    last.sweetSpotHint = `量測完成（${stabilityTag}）：您目前正處於左右等距的皇帝位中軸線上。`;
  } else if (last.offsetCm > 0) {
    last.sweetSpotStatus = 'move_right';
    last.sweetSpotHint = `量測完成（${stabilityTag}）：位置偏左，請往右移動約 ${absCm.toFixed(1)} cm。`;
  } else {
    last.sweetSpotStatus = 'move_left';
    last.sweetSpotHint = `量測完成（${stabilityTag}）：位置偏右，請往左移動約 ${absCm.toFixed(1)} cm。`;
  }

  const absAsym = Math.abs(last.toeInAsymDb);
  if (absAsym <= 1.2) {
    last.toeInStatus = 'balanced';
    last.toeInHint = `量測完成（${used.length} 輪平均）：左右喇叭高頻指向性對稱良好（差異 ${absAsym.toFixed(1)} dB）。`;
  } else if (last.toeInAsymDb < 0) {
    last.toeInStatus = 'toe_in_left';
    last.toeInHint = `量測完成（${used.length} 輪平均）：左喇叭高頻偏暗（-${absAsym.toFixed(1)} dB），建議增加左喇叭 Toe-in。`;
  } else {
    last.toeInStatus = 'toe_in_right';
    last.toeInHint = `量測完成（${used.length} 輪平均）：右喇叭高頻偏暗（-${absAsym.toFixed(1)} dB），建議增加右喇叭 Toe-in。`;
  }
  return last;
}

function averageBassResults(samples) {
  const last = structuredClone(samples.at(-1));
  const len = last.rawDb.length;
  for (let i = 0; i < len; i++) {
    last.rawDb[i] = Math.round(meanOf(samples, (s) => s.rawDb[i]) * 100) / 100;
    last.detrendedDb[i] = Math.round(meanOf(samples, (s) => s.detrendedDb[i]) * 100) / 100;
  }
  last.smoothnessDb = Math.round(meanOf(samples, (s) => s.smoothnessDb) * 100) / 100;
  last.spreadDb = Math.round(meanOf(samples, (s) => s.spreadDb) * 100) / 100;
  last.hint = `量測完成（${samples.length} 輪平均已鎖定）：${last.hint}`;
  last.lockedRounds = samples.length;
  return last;
}

function handleSweetSpotFrame(data) {
  if (!isMeasuring) return;
  if (!oneShotMode) {
    latestResult = data;
    renderAnalysis(latestResult);
    return;
  }

  // Always update live oscilloscope & RMS while collecting
  el.rmsReadout.textContent = `${data.inputRmsDb.toFixed(1)} dBFS`;
  if (activeTab === 'sweetspot') {
    drawLiveWaveform(el.canvasWave, data);
  }

  const cfg = ONE_SHOT_CONFIG.sweetspot;
  const now = performance.now();
  if (data.detected && (oneShotSamples.length === 0 || now - lastRoundCaptureMs >= cfg.minIntervalMs)) {
    oneShotSamples.push(structuredClone(data));
    lastRoundCaptureMs = now;
    el.btnStopMic.textContent = `⏹ 停止（已收 ${oneShotSamples.length}/${cfg.targetRounds} 輪）`;
    el.sweetSpotBadge.textContent = `單次量測中 (${oneShotSamples.length}/${cfg.targetRounds})`;
    el.sweetSpotBadge.dataset.status = 'buffering';
    el.sweetSpotHint.textContent = `正在收集第 ${oneShotSamples.length} / ${cfg.targetRounds} 輪訊號，請保持手機穩定...`;

    if (oneShotSamples.length >= cfg.targetRounds) {
      const averaged = averageSweetSpotResults(oneShotSamples);
      latestResult = averaged;
      stopMeasurement().then(() => {
        renderAnalysis(latestResult);
        el.sweetSpotBadge.textContent = averaged.unstable
          ? `⚠ 波動過大 (±${(averaged.spreadMs * 0.5).toFixed(2)}ms)`
          : `✓ 已鎖定 (${averaged.lockedRounds}/${averaged.totalRounds}輪 ±${(averaged.spreadMs * 0.5).toFixed(2)}ms)`;
        el.btnLockBaseline.disabled = false;
      });
    }
  } else if (!data.detected && oneShotSamples.length === 0) {
    el.sweetSpotBadge.textContent = '等待測試音...';
    el.sweetSpotBadge.dataset.status = 'waiting';
    el.sweetSpotHint.textContent = data.sweetSpotHint;
  }
}

function handleBassFrame(data) {
  if (!isMeasuring) return;
  if (!oneShotMode) {
    latestBassResult = data;
    renderBassAnalysis(latestBassResult);
    return;
  }

  const cfg = ONE_SHOT_CONFIG.bass;
  const now = performance.now();
  if (data.detected && (oneShotSamples.length === 0 || now - lastRoundCaptureMs >= cfg.minIntervalMs)) {
    oneShotSamples.push(structuredClone(data));
    lastRoundCaptureMs = now;
    el.btnStopMic.textContent = `⏹ 停止（已收 ${oneShotSamples.length}/${cfg.targetRounds} 輪）`;
    el.bassBadge.textContent = `單次量測中 (${oneShotSamples.length}/${cfg.targetRounds})`;
    el.bassBadge.dataset.status = 'buffering';
    el.bassHint.textContent = `已收集第 ${oneShotSamples.length} / ${cfg.targetRounds} 輪低頻掃頻，完成後自動停止並鎖定曲線...`;

    if (oneShotSamples.length >= cfg.targetRounds) {
      const averaged = averageBassResults(oneShotSamples);
      latestBassResult = averaged;
      stopMeasurement().then(() => {
        renderBassAnalysis(latestBassResult);
        el.bassBadge.textContent = `✓ 已鎖定 (${averaged.lockedRounds}輪平均)`;
      });
    }
  } else if (!data.detected && oneShotSamples.length === 0) {
    el.bassBadge.textContent = '等待低頻掃頻...';
    el.bassBadge.dataset.status = 'waiting';
    el.bassHint.textContent = data.hint;
  }
}

function toggleCaptureMode() {
  oneShotMode = !oneShotMode;
  el.btnCaptureMode.textContent = oneShotMode ? '單次' : '連續';
  el.btnCaptureMode.dataset.continuous = String(!oneShotMode);
  el.btnStartMic.textContent = oneShotMode ? '🎙 開始單次量測 (自動停)' : '🎙 開始連續即時量測';
  if (isMeasuring) {
    oneShotSamples = [];
    lastRoundCaptureMs = 0;
    el.btnStopMic.textContent = oneShotMode
      ? `⏹ 停止（收集 0/${ONE_SHOT_CONFIG[currentDspMode()].targetRounds} 輪）`
      : '⏹ 停止收音';
  }
}

function renderAnalysis(data) {
  el.rmsReadout.textContent = `${data.inputRmsDb.toFixed(1)} dBFS`;
  el.snrReadout.textContent = `L ${data.snrL.toFixed(0)} / R ${data.snrR.toFixed(0)}`;

  const statusMap = {
    buffering: '緩衝收音中',
    waiting: '等待測試音',
    centered: '皇帝位正中 ✓',
    move_right: '請往右移 →',
    move_left: '← 請往左移',
  };
  el.sweetSpotBadge.textContent = statusMap[data.sweetSpotStatus] ?? '待命中';
  el.sweetSpotBadge.dataset.status = data.sweetSpotStatus;
  el.sweetSpotHint.textContent = data.sweetSpotHint;

  if (data.detected) {
    const absCm = Math.abs(data.offsetCm).toFixed(1);
    const halfCm = (Math.abs(data.offsetCm) * 0.5).toFixed(1);

    if (tuningMode === 'speaker') {
      // Fixed Seat Mode: tell user how to move/aim speakers to bring sweet spot to their seat
      if (data.unstable) {
        el.sweetSpotBadge.textContent = '⚠ 延遲波動過大，請重測';
        el.offsetReadout.textContent = '請重測';
        el.sweetSpotHint.textContent = data.sweetSpotHint;
      } else if (data.sweetSpotStatus === 'centered') {
        el.sweetSpotBadge.textContent = '喇叭距離已等距 ✓';
        el.offsetReadout.textContent = `✓ 等距 (${absCm} cm)`;
        el.sweetSpotHint.textContent = '左右喇叭到您目前座位的距離已平衡！';
      } else if (data.offsetCm > 0) {
        // R is farther than L -> pull R forward or push L back
        el.sweetSpotBadge.textContent = '右喇叭較遠';
        el.offsetReadout.textContent = `右前移 ${absCm} cm`;
        el.sweetSpotHint.textContent = `座位偏左：將右喇叭往前拉 ${absCm} cm（或左退 ${halfCm} + 右進 ${halfCm} cm）`;
      } else {
        // L is farther than R -> pull L forward or push R back
        el.sweetSpotBadge.textContent = '左喇叭較遠';
        el.offsetReadout.textContent = `左前移 ${absCm} cm`;
        el.sweetSpotHint.textContent = `座位偏右：將左喇叭往前拉 ${absCm} cm（或右退 ${halfCm} + 左進 ${halfCm} cm）`;
      }

      // 3-step actionable speaker adjustment card (Distance + Angle + Balance + Stability)
      const distAdvice = data.unstable
        ? '本輪各次 Δt 差距過大，請勿依此調整 DSP Delay，請保持手機不動並重測'
        : data.sweetSpotStatus === 'centered'
          ? '已等距 ✓（不需移動前後位置）'
          : data.offsetCm > 0
            ? `右喇叭往前移 ${absCm} cm（或左後退）；若不能移動，可用擴大機/DAC/Roon DSP 延遲左聲道 ${Math.abs(data.deltaMs).toFixed(2)} ms`
            : `左喇叭往前移 ${absCm} cm（或右後退）；若不能移動，可用擴大機/DAC/Roon DSP 延遲右聲道 ${Math.abs(data.deltaMs).toFixed(2)} ms`;

      const angleAdvice = data.toeInStatus === 'balanced'
        ? '左右高頻指向已對準您的座位 ✓'
        : data.toeInStatus === 'toe_in_left'
          ? `左喇叭往內轉（Toe-in）對準您的座位（左高頻少 ${Math.abs(data.toeInAsymDb).toFixed(1)} dB）`
          : `右喇叭往內轉（Toe-in）對準您的座位（右高頻少 ${Math.abs(data.toeInAsymDb).toFixed(1)} dB）`;

      const absSpl = Math.abs(data.splDiffDb);
      const balanceAdvice = absSpl <= 1.0
        ? '左右音量平衡良好 ✓'
        : data.splDiffDb > 0
          ? `左聲道偏大 +${absSpl.toFixed(1)} dB：擴大機 Balance 略往右補，或將左喇叭稍微外轉（Toe-out）減弱直吹`
          : `右聲道偏大 +${absSpl.toFixed(1)} dB：擴大機 Balance 略往左補，或將右喇叭稍微外轉（Toe-out）減弱直吹`;

      const guideRows = [
        buildSpeakerGuideRow('1. 距離', distAdvice),
        buildSpeakerGuideRow('2. 角度', angleAdvice),
        buildSpeakerGuideRow('3. 音量', balanceAdvice),
      ];
      if (Array.isArray(data.roundDeltasMs) && data.roundDeltasMs.length > 0) {
        const roundsStr = data.roundDeltasMs.map((v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`).join(' / ');
        const stabText = data.unstable
          ? `⚠ 各輪 Δt: [${roundsStr}] ms（誤差 ±${(data.spreadMs * 0.5).toFixed(2)} ms）`
          : `✓ ${data.lockedRounds}/${data.totalRounds} 輪有效，誤差 ±${(data.spreadMs * 0.5).toFixed(2)} ms（各輪: ${roundsStr} ms）`;
        guideRows.push(buildSpeakerGuideRow('4. 穩定度', stabText));
      }

      el.speakerActionBox.hidden = false;
      el.speakerActionBox.replaceChildren(...guideRows);
    } else {
      el.speakerActionBox.hidden = true;
      if (data.unstable) {
        el.offsetReadout.textContent = '請重測';
      } else if (data.sweetSpotStatus === 'centered') {
        el.offsetReadout.textContent = `✓ ${absCm} cm`;
      } else if (data.offsetCm > 0) {
        el.offsetReadout.textContent = `往右 ${absCm} cm →`;
      } else {
        el.offsetReadout.textContent = `← 往左 ${absCm} cm`;
      }
    }

    el.deltaMsReadout.textContent = `${data.deltaMs >= 0 ? '+' : ''}${data.deltaMs.toFixed(2)} ms`;
    el.splDiffReadout.textContent = `${data.splDiffDb >= 0 ? '+' : ''}${data.splDiffDb.toFixed(1)} dB`;

    const toeMap = {
      waiting: '等待中',
      balanced: '左右對稱 ✓',
      toe_in_left: '左喇叭內轉',
      toe_in_right: '右喇叭內轉',
    };
    const toeText = toeMap[data.toeInStatus] ?? '分析中';
    el.toeInBadge.textContent = toeText;
    el.toeInBadge.dataset.status = data.toeInStatus;
    el.toeInMini.textContent = `Toe-in: ${toeText}`;
    el.toeInMini.dataset.status = data.toeInStatus;
    el.toeInHint.textContent = data.toeInHint;

    const deltaL = baseline ? data.hfRatioL - baseline.hfRatioL : null;
    const deltaR = baseline ? data.hfRatioR - baseline.hfRatioR : null;

    el.hfLeftReadout.textContent = deltaL === null
      ? `${data.hfRatioL.toFixed(1)} dB`
      : `${data.hfRatioL.toFixed(1)} (${deltaL >= 0 ? '+' : ''}${deltaL.toFixed(1)})`;

    el.hfRightReadout.textContent = deltaR === null
      ? `${data.hfRatioR.toFixed(1)} dB`
      : `${data.hfRatioR.toFixed(1)} (${deltaR >= 0 ? '+' : ''}${deltaR.toFixed(1)})`;

    const asymStr = `${data.toeInAsymDb >= 0 ? '+' : ''}${data.toeInAsymDb.toFixed(1)} dB`;
    el.hfAsymReadout.textContent = asymStr;
    el.hfAsymMini.textContent = asymStr;
    el.clarityReadout.textContent = `L ${data.clarityL.toFixed(1)} / R ${data.clarityR.toFixed(1)}`;
  } else {
    el.offsetReadout.textContent = '-- cm';
    el.deltaMsReadout.textContent = '-- ms';
    el.splDiffReadout.textContent = '-- dB';
    el.hfAsymMini.textContent = '-- dB';
    el.toeInBadge.textContent = '等待測試音';
    el.toeInBadge.dataset.status = 'waiting';
    el.toeInMini.textContent = 'Toe-in 等待';
    el.toeInMini.dataset.status = 'waiting';
    el.toeInHint.textContent = data.toeInHint;
    el.speakerActionBox.hidden = true;
  }

  if (activeTab === 'sweetspot') {
    drawStageRadar(el.canvasStage, data, tuningMode);
    drawCorrelationWave(el.canvasCorr, data);
    drawLiveWaveform(el.canvasWave, data);
  }
}

function renderBassAnalysis(data) {
  const statusMap = {
    buffering: '收集掃頻中',
    waiting: '等待低頻掃頻',
    good: '低頻平順 ✓',
    moderate: '中度駐波',
    severe: '明顯駐波',
  };
  el.bassBadge.textContent = statusMap[data.status] ?? '待命中';
  el.bassBadge.dataset.status = data.status;
  el.bassHint.textContent = data.hint;

  if (data.detected) {
    el.btnSnapA.disabled = false;
    el.btnSnapB.disabled = false;
    el.bassSmoothReadout.textContent = `${data.smoothnessDb.toFixed(1)} dB`;
    el.bassSpreadReadout.textContent = `${data.spreadDb.toFixed(1)} dB`;

    const peaksText = data.peaks?.length
      ? data.peaks.slice(0, 2).map((p) => `${p.freqHz}Hz (+${p.db.toFixed(0)})`).join(', ')
      : '無明顯峰 ✓';
    const nullsText = data.nulls?.length
      ? data.nulls.slice(0, 2).map((n) => `${n.freqHz}Hz (${n.db.toFixed(0)})`).join(', ')
      : '無深凹陷 ✓';

    el.bassPeaksReadout.textContent = peaksText;
    el.bassNullsReadout.textContent = nullsText;
  } else {
    el.bassSmoothReadout.textContent = '-- dB';
    el.bassSpreadReadout.textContent = '-- dB';
    el.bassPeaksReadout.textContent = '--';
    el.bassNullsReadout.textContent = '--';
  }

  if (activeTab === 'bass') {
    redrawBassChart();
  }
}

function updateSnapSummary() {
  const parts = [];
  if (bassSnapA) {
    parts.push(`位置 A 平坦度 ${bassSnapA.smoothnessDb.toFixed(1)} dB（落差 ${bassSnapA.spreadDb.toFixed(1)} dB）`);
  }
  if (bassSnapB) {
    parts.push(`位置 B 平坦度 ${bassSnapB.smoothnessDb.toFixed(1)} dB（落差 ${bassSnapB.spreadDb.toFixed(1)} dB）`);
  }
  if (bassSnapA && bassSnapB) {
    const winner = bassSnapA.smoothnessDb <= bassSnapB.smoothnessDb ? '位置 A 較平順 ✓' : '位置 B 較平順 ✓';
    parts.push(`結論：${winner}`);
  }
  el.snapCompareInfo.textContent = parts.length
    ? parts.join(' ｜ ')
    : '透過同一支手機存「位置 A / B」疊圖對比（例如喇叭離後牆 40cm vs 60cm），可完全抵銷手機麥克風誤差。';
  el.btnSnapClear.disabled = !bassSnapA && !bassSnapB;
}

function handleSaveSnapshot(slot) {
  if (!latestBassResult?.detected) {
    showError('請先偵測到低頻掃頻結果後再儲存快照。');
    return;
  }
  showError('');
  const snap = structuredClone(latestBassResult);
  if (slot === 'A') bassSnapA = snap;
  else bassSnapB = snap;
  updateSnapSummary();
  redrawBassChart();
}

function handleLockBaseline() {
  if (!latestResult?.detected) {
    showError('請先偵測到左右聲道測試音後再鎖定 Toe-in 基準。');
    return;
  }
  showError('');
  baseline = {
    hfRatioL: latestResult.hfRatioL,
    hfRatioR: latestResult.hfRatioR,
  };
  el.btnClearBaseline.disabled = false;
  el.baselineInfo.textContent = `已鎖定基準（L ${baseline.hfRatioL.toFixed(1)} dB / R ${baseline.hfRatioR.toFixed(1)} dB），轉動喇叭即可觀察高頻 ΔdB 變化。`;
  renderAnalysis(latestResult);
}

function handleClearBaseline() {
  baseline = null;
  el.btnClearBaseline.disabled = true;
  el.baselineInfo.textContent = '未鎖定基準。固定手機於皇帝位後鎖定基準，轉動喇叭即可觀察高頻 ΔdB 變化。';
  if (latestResult) {
    renderAnalysis(latestResult);
  }
}

// Event bindings
for (const btn of el.tabButtons) {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
}
el.toeInMini.addEventListener('click', () => switchTab('toein'));

el.btnStartMic.addEventListener('click', startMeasurement);
el.btnStopMic.addEventListener('click', stopMeasurement);
el.btnCaptureMode.addEventListener('click', toggleCaptureMode);
el.btnQuickWav.addEventListener('click', () => handleDownloadWav(currentDspMode(), el.btnQuickWav));

el.btnDownloadWav.addEventListener('click', () => handleDownloadWav('sweetspot', el.btnDownloadWav));
el.btnPlayTest.addEventListener('click', () => handleTogglePlay('sweetspot'));

el.btnDownloadBassWav.addEventListener('click', () => handleDownloadWav('bass', el.btnDownloadBassWav));
el.btnPlayBassTest.addEventListener('click', () => handleTogglePlay('bass'));
el.btnDownloadBassWav2.addEventListener('click', () => handleDownloadWav('bass', el.btnDownloadBassWav2));
el.btnPlayBassTest2.addEventListener('click', () => handleTogglePlay('bass'));

el.btnLockBaseline.addEventListener('click', handleLockBaseline);
el.btnClearBaseline.addEventListener('click', handleClearBaseline);
el.btnModeSeat.addEventListener('click', () => setTuningMode('seat'));
el.btnModeSpeaker.addEventListener('click', () => setTuningMode('speaker'));

el.selectBassFMin.addEventListener('change', () => {
  bassFMinHz = Number(el.selectBassFMin.value) || 40;
  if (dspWorker && wasmReady) {
    dspWorker.postMessage({ type: 'set-bass-fmin', fMinHz: bassFMinHz });
  }
  redrawBassChart();
});

el.toggleBassDetrend.addEventListener('change', () => {
  bassDetrended = el.toggleBassDetrend.checked;
  redrawBassChart();
});

el.btnSnapA.addEventListener('click', () => handleSaveSnapshot('A'));
el.btnSnapB.addEventListener('click', () => handleSaveSnapshot('B'));
el.btnSnapClear.addEventListener('click', () => {
  bassSnapA = null;
  bassSnapB = null;
  updateSnapSummary();
  redrawBassChart();
});

window.addEventListener('resize', () => {
  if (activeTab === 'sweetspot') {
    drawStageRadar(el.canvasStage, latestResult, tuningMode);
    drawCorrelationWave(el.canvasCorr, latestResult);
    drawLiveWaveform(el.canvasWave, latestResult);
  } else if (activeTab === 'bass') {
    redrawBassChart();
  }
});

// Initial canvas paint & start Go WASM Worker
drawStageRadar(el.canvasStage, null, tuningMode);
drawCorrelationWave(el.canvasCorr, null);
drawLiveWaveform(el.canvasWave, null);
redrawBassChart();
initDspWorker().catch(() => {});
