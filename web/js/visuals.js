// High-DPI Canvas Visualizers for Acoustic Measurement

const COLORS = {
  bg: '#0b111c',
  grid: 'rgba(148, 163, 184, 0.14)',
  axis: 'rgba(148, 163, 184, 0.35)',
  text: '#94a3b8',
  left: '#38bdf8',       // Cyan (Left speaker)
  leftGlow: 'rgba(56, 189, 248, 0.22)',
  right: '#fbbf24',      // Amber (Right speaker)
  rightGlow: 'rgba(251, 191, 36, 0.22)',
  good: '#34d399',       // Emerald (Centered / Balanced)
  warn: '#f87171',       // Rose (Off-center)
  wave: '#60a5fa',
};

function setupCanvas(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

/**
 * Top-down Sweet Spot & Speaker Toe-in Diagram
 * tuningMode: 'seat' (move listener) | 'speaker' (fixed seat, move/aim speakers)
 */
export function drawStageRadar(canvas, result, tuningMode = 'seat') {
  const { ctx, w, h } = setupCanvas(canvas);
  ctx.clearRect(0, 0, w, h);

  const cx = w * 0.5;
  const spkY = h * 0.24;
  const spkHalfSpan = Math.min(w * 0.34, 150);
  const leftX = cx - spkHalfSpan;
  const rightX = cx + spkHalfSpan;
  const sweetY = h * 0.76;

  // Center axis line
  ctx.strokeStyle = COLORS.grid;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(cx, 14);
  ctx.lineTo(cx, h - 14);
  ctx.stroke();
  ctx.setLineDash([]);

  // Ideal 60-degree triangle lines
  ctx.strokeStyle = 'rgba(52, 211, 153, 0.22)';
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  ctx.moveTo(leftX, spkY);
  ctx.lineTo(cx, sweetY);
  ctx.lineTo(rightX, spkY);
  ctx.stroke();

  // Compute subtle visual toe-in angle hints from asymmetry
  const baseAngle = Math.atan2(sweetY - spkY, spkHalfSpan);
  const asym = result?.detected ? Math.max(-4, Math.min(4, result.toeInAsymDb)) : 0;
  const leftAimAngle = baseAngle + (asym < -1.2 ? 0.16 : 0);
  const rightAimAngle = Math.PI - baseAngle - (asym > 1.2 ? 0.16 : 0);

  // Acoustic dispersion cones
  drawCone(ctx, leftX, spkY, leftAimAngle, h * 0.62, COLORS.leftGlow);
  drawCone(ctx, rightX, spkY, rightAimAngle, h * 0.62, COLORS.rightGlow);

  // Speaker cabinets
  drawSpeakerBox(ctx, leftX, spkY, leftAimAngle, COLORS.left, 'L');
  drawSpeakerBox(ctx, rightX, spkY, rightAimAngle, COLORS.right, 'R');

  // In Fixed Seat mode, draw forward-pull arrow on the farther speaker
  if (tuningMode === 'speaker' && result?.detected && Math.abs(result.offsetCm) > 1.5) {
    const pullRight = result.offsetCm > 0; // R is farther -> pull R forward
    const sx = pullRight ? rightX : leftX;
    const arrowColor = pullRight ? COLORS.right : COLORS.left;
    ctx.strokeStyle = arrowColor;
    ctx.fillStyle = arrowColor;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(sx, spkY + 18);
    ctx.lineTo(sx, spkY + 46);
    ctx.stroke();
    // Arrowhead pointing down (forward toward seat)
    ctx.beginPath();
    ctx.moveTo(sx, spkY + 52);
    ctx.lineTo(sx - 5, spkY + 42);
    ctx.lineTo(sx + 5, spkY + 42);
    ctx.closePath();
    ctx.fill();
    ctx.font = 'bold 10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`往前拉 ${Math.abs(result.offsetCm).toFixed(0)}cm`, sx, spkY + 64);
  }

  // Ideal sweet spot ring
  ctx.strokeStyle = 'rgba(52, 211, 153, 0.55)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(cx, sweetY, 16, 0, Math.PI * 2);
  ctx.stroke();

  // Listener dot
  let listenerX = cx;
  let dotColor = COLORS.text;
  if (result?.detected) {
    const clampedCm = Math.max(-35, Math.min(35, result.offsetCm));
    const maxShiftPx = spkHalfSpan * 0.92;
    listenerX = cx - (clampedCm / 35) * maxShiftPx;
    dotColor = Math.abs(result.offsetCm) <= 1.5 ? COLORS.good : COLORS.warn;

    if (tuningMode === 'seat' && Math.abs(result.offsetCm) > 1.5) {
      ctx.strokeStyle = dotColor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(listenerX, sweetY);
      ctx.lineTo(cx, sweetY);
      ctx.stroke();
    }
  }

  // Draw listener head/mic marker
  ctx.fillStyle = tuningMode === 'speaker' ? COLORS.good : dotColor;
  ctx.beginPath();
  ctx.arc(listenerX, sweetY, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#0f172a';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Labels
  ctx.fillStyle = COLORS.text;
  ctx.font = '11px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(
    tuningMode === 'speaker' ? '已鎖定座位（依箭頭調整喇叭）' : '皇帝位中軸',
    cx,
    sweetY + 30,
  );
}

function drawCone(ctx, x, y, angle, length, fill) {
  const spread = 0.24;
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.arc(x, y, length, angle - spread, angle + spread);
  ctx.closePath();
  ctx.fill();
}

function drawSpeakerBox(ctx, x, y, angle, color, label) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle - Math.PI / 2);
  ctx.fillStyle = '#1e293b';
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(-14, -10, 28, 20, 4);
  ctx.fill();
  ctx.stroke();

  // Front tweeter indicator line
  ctx.fillStyle = color;
  ctx.fillRect(-8, 7, 16, 3);
  ctx.restore();

  ctx.fillStyle = color;
  ctx.font = 'bold 12px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(label, x, y - 16);
}

/**
 * Dual-channel Correlation Pulse Diagram (-12ms .. 0ms .. +12ms)
 * Cyan (L) sits at 0ms; Amber (R) shifts by DeltaMs so overlap = Sweet Spot!
 */
export function drawCorrelationWave(canvas, result) {
  const { ctx, w, h } = setupCanvas(canvas);
  ctx.clearRect(0, 0, w, h);

  const padL = 12;
  const padR = 12;
  const padT = 16;
  const padB = 24;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const cx = padL + plotW * 0.5;

  // Grid & 0ms center line
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const x = padL + (plotW * i) / 4;
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + plotH);
    ctx.stroke();
  }

  ctx.strokeStyle = COLORS.good;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(cx, padT);
  ctx.lineTo(cx, padT + plotH);
  ctx.stroke();
  ctx.setLineDash([]);

  // Axis labels
  ctx.fillStyle = COLORS.text;
  ctx.font = '10px ui-monospace, monospace';
  ctx.textAlign = 'left';
  ctx.fillText('-12ms', padL, h - 6);
  ctx.textAlign = 'center';
  ctx.fillText('0ms (等距)', cx, h - 6);
  ctx.textAlign = 'right';
  ctx.fillText('+12ms', w - padR, h - 6);

  if (!result?.detected || !result.corrEnvL?.length || !result.corrEnvR?.length) {
    ctx.fillStyle = COLORS.text;
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('播放測試音後將顯示 L / R 到達脈衝重疊圖', cx, padT + plotH * 0.5);
    return;
  }

  drawEnvelopeTrace(ctx, result.corrEnvL, padL, padT, plotW, plotH, COLORS.left, 'rgba(56, 189, 248, 0.16)');
  drawEnvelopeTrace(ctx, result.corrEnvR, padL, padT, plotW, plotH, COLORS.right, 'rgba(251, 191, 36, 0.16)');
}

function drawEnvelopeTrace(ctx, arr, padL, padT, plotW, plotH, stroke, fill) {
  const n = arr.length;
  ctx.beginPath();
  ctx.moveTo(padL, padT + plotH);
  for (let i = 0; i < n; i++) {
    const x = padL + (i / (n - 1)) * plotW;
    const y = padT + plotH - Math.max(0, Math.min(1, arr[i])) * (plotH - 6);
    ctx.lineTo(x, y);
  }
  ctx.lineTo(padL + plotW, padT + plotH);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();

  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = padL + (i / (n - 1)) * plotW;
    const y = padT + plotH - Math.max(0, Math.min(1, arr[i])) * (plotH - 6);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 2;
  ctx.stroke();
}

/**
 * Live Microphone Oscilloscope Waveform
 */
export function drawLiveWaveform(canvas, result) {
  const { ctx, w, h } = setupCanvas(canvas);
  ctx.clearRect(0, 0, w, h);

  const midY = h * 0.5;
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, midY);
  ctx.lineTo(w, midY);
  ctx.stroke();

  const wave = result?.waveform;
  if (!wave || wave.length < 2) {
    ctx.fillStyle = COLORS.text;
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('尚未啟動麥克風收音', w * 0.5, midY + 4);
    return;
  }

  // Auto-scale gently so quiet rooms are still visible
  let peak = 0.05;
  for (let i = 0; i < wave.length; i++) {
    const a = Math.abs(wave[i]);
    if (a > peak) peak = a;
  }
  const scale = (h * 0.42) / peak;

  ctx.strokeStyle = COLORS.wave;
  ctx.lineWidth = 1.75;
  ctx.beginPath();
  for (let i = 0; i < wave.length; i++) {
    const x = (i / (wave.length - 1)) * w;
    const y = midY - wave[i] * scale;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

/**
 * Phase 2: Low-Frequency Room Mode Response Chart (30 Hz - 320 Hz log scale)
 * Supports Detrended (phone mic roll-off neutralized) vs Raw view, plus Snapshot A/B overlays.
 */
export function drawBassResponse(canvas, result, options = {}) {
  const { ctx, w, h } = setupCanvas(canvas);
  ctx.clearRect(0, 0, w, h);

  const { detrended = true, snapA = null, snapB = null, fMinHz = 40 } = options;
  const padL = 34;
  const padR = 12;
  const padT = 16;
  const padB = 24;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  const fStart = 30;
  const fEnd = 320;
  const dbMax = 15;
  const dbMin = -21;

  const freqToX = (f) => {
    const t = Math.log(Math.max(fStart, Math.min(fEnd, f)) / fStart) / Math.log(fEnd / fStart);
    return padL + t * plotW;
  };
  const dbToY = (db) => {
    const clamped = Math.max(dbMin, Math.min(dbMax, db));
    return padT + ((dbMax - clamped) / (dbMax - dbMin)) * plotH;
  };

  // Shaded zone below speaker fMinHz cutoff
  const fMinX = freqToX(fMinHz);
  ctx.fillStyle = 'rgba(148, 163, 184, 0.08)';
  ctx.fillRect(padL, padT, Math.max(0, fMinX - padL), plotH);

  // Horizontal dB grid lines
  const dbTicks = [12, 6, 0, -6, -12, -18];
  ctx.font = '10px ui-monospace, monospace';
  ctx.textAlign = 'right';
  for (const db of dbTicks) {
    const y = dbToY(db);
    ctx.strokeStyle = db === 0 ? COLORS.axis : COLORS.grid;
    ctx.lineWidth = db === 0 ? 1.25 : 1;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();

    ctx.fillStyle = COLORS.text;
    ctx.fillText(`${db > 0 ? '+' : ''}${db}`, padL - 5, y + 3);
  }

  // Vertical log-frequency grid lines
  const freqTicks = [30, 40, 60, 80, 100, 150, 200, 300];
  ctx.textAlign = 'center';
  for (const f of freqTicks) {
    const x = freqToX(f);
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + plotH);
    ctx.stroke();

    ctx.fillStyle = COLORS.text;
    ctx.fillText(`${f}`, x, h - 6);
  }

  // fMinHz vertical cutoff marker
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.45)';
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(fMinX, padT);
  ctx.lineTo(fMinX, padT + plotH);
  ctx.stroke();
  ctx.setLineDash([]);

  const drawCurve = (freqs, values, color, dashed = false, lineWidth = 2) => {
    if (!freqs?.length || !values?.length) return;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    if (dashed) ctx.setLineDash([5, 4]);
    ctx.beginPath();
    for (let i = 0; i < freqs.length; i++) {
      const x = freqToX(freqs[i]);
      const y = dbToY(values[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();
  };

  // Overlaid Snapshots A & B
  if (snapA) {
    drawCurve(snapA.freqsHz, detrended ? snapA.detrendedDb : snapA.rawDb, COLORS.good, true, 1.75);
  }
  if (snapB) {
    drawCurve(snapB.freqsHz, detrended ? snapB.detrendedDb : snapB.rawDb, COLORS.right, true, 1.75);
  }

  if (!result?.detected || !result.freqsHz?.length) {
    ctx.fillStyle = COLORS.text;
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('播放「低頻駐波測試 WAV」後將顯示 30–320 Hz 曲線', padL + plotW * 0.5, padT + plotH * 0.48);
    return;
  }

  const liveValues = detrended ? result.detrendedDb : result.rawDb;
  drawCurve(result.freqsHz, liveValues, COLORS.left, false, 2.25);

  // Annotate Peaks (red) and Nulls (purple) when in detrended view
  if (detrended) {
    ctx.font = 'bold 10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    for (const p of result.peaks || []) {
      const x = freqToX(p.freqHz);
      const y = dbToY(p.db);
      ctx.fillStyle = '#f87171';
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillText(`${p.freqHz}Hz`, x, Math.max(padT + 10, y - 7));
    }
    for (const n of result.nulls || []) {
      const x = freqToX(n.freqHz);
      const y = dbToY(n.db);
      ctx.fillStyle = '#c084fc';
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillText(`${n.freqHz}Hz`, x, Math.min(padT + plotH - 4, y + 14));
    }
  }
}
