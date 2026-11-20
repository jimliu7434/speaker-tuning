package signal

import (
	"math"
	"math/cmplx"
)

const (
	analysisFFTSize = 131072 // ~2.73s @ 48kHz, ~2.97s @ 44.1kHz
	gateFFTSize     = 2048   // quasi-anechoic time-gated impulse response FFT
	waveformPoints  = 160
	corrEnvPoints   = 121    // -12ms .. 0 .. +12ms
	corrEnvHalfMs   = 12.0
)

// AnalysisResult holds all acoustic diagnostics returned to the frontend UI.
type AnalysisResult struct {
	Ready           bool      `json:"ready"`
	Detected        bool      `json:"detected"`
	SampleRate      int       `json:"sampleRate"`
	InputRmsDb      float64   `json:"inputRmsDb"`
	SnrL            float64   `json:"snrL"`
	SnrR            float64   `json:"snrR"`
	DeltaMs         float64   `json:"deltaMs"`         // >0: R arrives later (listener too far Left -> move Right)
	OffsetCm        float64   `json:"offsetCm"`        // Equivalent lateral shift in cm (+ move Right, - move Left)
	SplL            float64   `json:"splL"`            // Relative dBFS of L chirp
	SplR            float64   `json:"splR"`            // Relative dBFS of R chirp
	SplDiffDb       float64   `json:"splDiffDb"`       // splL - splR
	MidL            float64   `json:"midL"`            // 400-2000 Hz dB
	MidR            float64   `json:"midR"`
	HighL           float64   `json:"highL"`           // 4000-12000 Hz dB
	HighR           float64   `json:"highR"`
	HfRatioL        float64   `json:"hfRatioL"`        // HighL - MidL (brightness / on-axis indicator)
	HfRatioR        float64   `json:"hfRatioR"`        // HighR - MidR
	ToeInAsymDb     float64   `json:"toeInAsymDb"`     // HfRatioL - HfRatioR
	ClarityL        float64   `json:"clarityL"`        // Direct vs Early Reflection ratio (dB)
	ClarityR        float64   `json:"clarityR"`
	SweetSpotStatus string    `json:"sweetSpotStatus"` // "buffering" | "waiting" | "centered" | "move_right" | "move_left"
	SweetSpotHint   string    `json:"sweetSpotHint"`
	ToeInStatus     string    `json:"toeInStatus"`     // "waiting" | "balanced" | "toe_in_left" | "toe_in_right"
	ToeInHint       string    `json:"toeInHint"`
	Waveform        []float64 `json:"waveform"`        // Downsampled recent mic waveform [-1, 1]
	CorrEnvL        []float64 `json:"corrEnvL"`        // Normalized L correlation envelope [-12ms..+12ms]
	CorrEnvR        []float64 `json:"corrEnvR"`        // Normalized R correlation envelope [-12ms..+12ms] aligned to expected R
}

// Analyzer maintains a ring buffer and precomputed chirp templates for fast DSP.
type Analyzer struct {
	sampleRate    int
	periodSamples float64
	chirpLen      int
	ring          []float64
	ringPos       int
	totalSamples  int64

	templateLConj []complex128
	templateRConj []complex128
	templateNorm  float64

	// Reusable scratch buffers to minimize GC pressure in WASM
	chronoBuf []float64
	fftSignal []complex128
	fftWork   []complex128
	corrL     []float64
	corrR     []float64
	specBuf   []complex128

	// Temporal EMA smoothing state for rock-solid mobile readouts
	hasEma       bool
	emaDeltaMs   float64
	emaOffsetCm  float64
	emaSplDiff   float64
	emaHfRatioL  float64
	emaHfRatioR  float64
	emaToeInAsym float64
	emaClarityL  float64
	emaClarityR  float64
}

// NewAnalyzer creates an acoustic analyzer configured for the given mic sample rate.
func NewAnalyzer(sampleRate int) *Analyzer {
	if sampleRate <= 0 {
		sampleRate = DefaultSampleRate
	}

	up := GenerateLogChirp(sampleRate, true)
	down := GenerateLogChirp(sampleRate, false)

	energy := 0.0
	for _, v := range up {
		energy += v * v
	}

	bufL := make([]complex128, analysisFFTSize)
	bufR := make([]complex128, analysisFFTSize)
	for i := 0; i < len(up); i++ {
		bufL[i] = complex(up[i], 0)
		bufR[i] = complex(down[i], 0)
	}
	FFT(bufL, false)
	FFT(bufR, false)

	return &Analyzer{
		sampleRate:    sampleRate,
		periodSamples: float64(sampleRate) * PeriodSeconds,
		chirpLen:      len(up),
		ring:          make([]float64, analysisFFTSize),
		templateLConj: ConjugateCopy(bufL),
		templateRConj: ConjugateCopy(bufR),
		templateNorm:  math.Sqrt(energy),
		chronoBuf:     make([]float64, analysisFFTSize),
		fftSignal:     make([]complex128, analysisFFTSize),
		fftWork:       make([]complex128, analysisFFTSize),
		corrL:         make([]float64, analysisFFTSize),
		corrR:         make([]float64, analysisFFTSize),
		specBuf:       make([]complex128, gateFFTSize),
	}
}

// Reset clears the ring buffer and EMA smoothing state.
func (a *Analyzer) Reset() {
	for i := range a.ring {
		a.ring[i] = 0
	}
	a.ringPos = 0
	a.totalSamples = 0
	a.hasEma = false
}

// PushSamples appends incoming mono PCM float32 samples into the ring buffer.
func (a *Analyzer) PushSamples(samples []float32) {
	n := len(a.ring)
	for _, s := range samples {
		a.ring[a.ringPos] = float64(s)
		a.ringPos++
		if a.ringPos >= n {
			a.ringPos = 0
		}
	}
	a.totalSamples += int64(len(samples))
}

// Analyze runs FFT matched filtering, TDOA sweet-spot calculation, and Toe-in band analysis.
func (a *Analyzer) Analyze() AnalysisResult {
	res := AnalysisResult{
		SampleRate:      a.sampleRate,
		SweetSpotStatus: "buffering",
		SweetSpotHint:   "正在收集環境音訊（約需 2 秒）...",
		ToeInStatus:     "waiting",
		ToeInHint:       "等待偵測左右聲道測試音...",
	}

	// Build recent ~60ms live waveform preview regardless of buffering state
	res.Waveform, res.InputRmsDb = a.buildWaveformPreview()

	minSamples := int64(math.Round(float64(a.sampleRate) * 1.85))
	if a.totalSamples < minSamples {
		return res
	}
	res.Ready = true

	// 1. Copy ring buffer chronologically and remove DC offset
	n := analysisFFTSize
	mean := 0.0
	for i := 0; i < n; i++ {
		idx := (a.ringPos + i) % n
		v := a.ring[idx]
		a.chronoBuf[i] = v
		mean += v
	}
	mean /= float64(n)
	for i := 0; i < n; i++ {
		v := a.chronoBuf[i] - mean
		a.chronoBuf[i] = v
		a.fftSignal[i] = complex(v, 0)
	}

	// 2. Forward FFT of input signal
	FFT(a.fftSignal, false)

	// 3. Matched filter correlation for L (Up-Chirp) and R (Down-Chirp)
	for i := 0; i < n; i++ {
		a.fftWork[i] = a.fftSignal[i] * a.templateLConj[i]
	}
	FFT(a.fftWork, true)
	for i := 0; i < n; i++ {
		a.corrL[i] = real(a.fftWork[i]) / a.templateNorm
	}

	for i := 0; i < n; i++ {
		a.fftWork[i] = a.fftSignal[i] * a.templateRConj[i]
	}
	FFT(a.fftWork, true)
	for i := 0; i < n; i++ {
		a.corrR[i] = real(a.fftWork[i]) / a.templateNorm
	}

	// 4. Locate strongest peaks in safe interior range [margin, n - chirpLen - margin)
	// Margin guarantees full direct sound + early reflection gate without edge wrap-around.
	margin := int(float64(a.sampleRate) * 0.03) // 30ms safety margin
	validEnd := n - a.chirpLen - margin
	if validEnd <= margin {
		margin = 0
		validEnd = n - a.chirpLen
	}
	relL, snrL := findPeakAndSNR(a.corrL[margin:validEnd])
	relR, snrR := findPeakAndSNR(a.corrR[margin:validEnd])
	idxL := margin + relL
	idxR := margin + relR
	res.SnrL = round2(snrL)
	res.SnrR = round2(snrR)

	const snrThreshold = 6.0
	if snrL < snrThreshold || snrR < snrThreshold {
		a.hasEma = false
		res.SweetSpotStatus = "waiting"
		res.SweetSpotHint = "尚未偵測到標準測試音，請播放測試 WAV 檔並調適音量。"
		res.ToeInStatus = "waiting"
		res.ToeInHint = "偵測到左右聲道測試音後將自動顯示 Toe-in 建議。"
		return res
	}

	res.Detected = true

	// 5. Sub-sample parabolic interpolation around peak magnitude
	peakL := parabolicPeak(a.corrL, idxL)
	peakR := parabolicPeak(a.corrR, idxR)

	// 6. TDOA calculation: expected R arrives exactly halfPeriod after L (modulo periodSamples)
	halfPeriod := a.periodSamples * 0.5
	rawDiff := peakR - peakL
	deltaSamples := wrapSigned(rawDiff-halfPeriod, a.periodSamples)
	deltaSec := deltaSamples / float64(a.sampleRate)
	rawDeltaMs := deltaSec * 1000.0
	rawOffsetCm := deltaSec * SpeedOfSound * 100.0

	// 7. Quasi-anechoic time-gated impulse response spectral analysis
	// Measuring directly from the compressed impulse peak [idx-3ms, idx+9ms] eliminates
	// Up-Chirp vs Down-Chirp edge clipping and gates out late room reverberation.
	splL, midL, highL := a.measureGatedBands(a.corrL, idxL)
	splR, midR, highR := a.measureGatedBands(a.corrR, idxR)

	rawSplDiff := splL - splR
	rawHfRatioL := highL - midL
	rawHfRatioR := highR - midR
	rawToeInAsym := rawHfRatioL - rawHfRatioR
	rawClarityL := a.measureClarity(a.corrL, idxL)
	rawClarityR := a.measureClarity(a.corrR, idxR)

	// Apply gentle EMA smoothing (alpha = 0.35) so live mobile readouts stay steady
	const alpha = 0.35
	if !a.hasEma {
		a.hasEma = true
		a.emaDeltaMs = rawDeltaMs
		a.emaOffsetCm = rawOffsetCm
		a.emaSplDiff = rawSplDiff
		a.emaHfRatioL = rawHfRatioL
		a.emaHfRatioR = rawHfRatioR
		a.emaToeInAsym = rawToeInAsym
		a.emaClarityL = rawClarityL
		a.emaClarityR = rawClarityR
	} else {
		a.emaDeltaMs += alpha * (rawDeltaMs - a.emaDeltaMs)
		a.emaOffsetCm += alpha * (rawOffsetCm - a.emaOffsetCm)
		a.emaSplDiff += alpha * (rawSplDiff - a.emaSplDiff)
		a.emaHfRatioL += alpha * (rawHfRatioL - a.emaHfRatioL)
		a.emaHfRatioR += alpha * (rawHfRatioR - a.emaHfRatioR)
		a.emaToeInAsym += alpha * (rawToeInAsym - a.emaToeInAsym)
		a.emaClarityL += alpha * (rawClarityL - a.emaClarityL)
		a.emaClarityR += alpha * (rawClarityR - a.emaClarityR)
	}

	res.DeltaMs = round3(a.emaDeltaMs)
	res.OffsetCm = round2(a.emaOffsetCm)

	// Sweet spot recommendation
	absCm := math.Abs(a.emaOffsetCm)
	if absCm <= 1.5 {
		res.SweetSpotStatus = "centered"
		res.SweetSpotHint = "太棒了！您目前正處於左右等距的皇帝位中軸線上。"
	} else if a.emaOffsetCm > 0 {
		res.SweetSpotStatus = "move_right"
		res.SweetSpotHint = "位置偏左，請往右移動約 " + formatOneDec(absCm) + " cm。"
	} else {
		res.SweetSpotStatus = "move_left"
		res.SweetSpotHint = "位置偏右，請往左移動約 " + formatOneDec(absCm) + " cm。"
	}

	res.SplL = round2(splL)
	res.SplR = round2(splR)
	res.SplDiffDb = round2(a.emaSplDiff)
	res.MidL = round2(midL)
	res.MidR = round2(midR)
	res.HighL = round2(highL)
	res.HighR = round2(highR)
	res.HfRatioL = round2(a.emaHfRatioL)
	res.HfRatioR = round2(a.emaHfRatioR)
	res.ToeInAsymDb = round2(a.emaToeInAsym)
	res.ClarityL = round2(a.emaClarityL)
	res.ClarityR = round2(a.emaClarityR)

	// Toe-in / Toe-out actionable suggestion
	absAsym := math.Abs(a.emaToeInAsym)
	if absAsym <= 1.2 {
		res.ToeInStatus = "balanced"
		res.ToeInHint = "左右喇叭高頻指向性對稱良好（差異 " + formatOneDec(absAsym) + " dB）。可鎖定基準後微調同步 Toe-in/out 尋找最佳聽感。"
	} else if a.emaToeInAsym < 0 {
		res.ToeInStatus = "toe_in_left"
		res.ToeInHint = "左喇叭高頻相對偏暗（-" + formatOneDec(absAsym) + " dB）：建議增加左喇叭 Toe-in（往內轉），或略微減少右喇叭內傾角。"
	} else {
		res.ToeInStatus = "toe_in_right"
		res.ToeInHint = "右喇叭高頻相對偏暗（-" + formatOneDec(absAsym) + " dB）：建議增加右喇叭 Toe-in（往內轉），或略微減少左喇叭內傾角。"
	}

	// 8. Build aligned L & R correlation envelopes (-12ms .. +12ms)
	// Center L at idxL, and center R at (idxR - deltaSamples) so R peak visibly shifts by deltaMs!
	expectedR := int(math.Round(float64(idxR) - deltaSamples))
	res.CorrEnvL = a.extractCorrEnvelope(a.corrL, idxL)
	res.CorrEnvR = a.extractCorrEnvelope(a.corrR, expectedR)

	return res
}

func (a *Analyzer) buildWaveformPreview() ([]float64, float64) {
	previewSamples := int(float64(a.sampleRate) * 0.06) // latest 60ms
	if previewSamples > len(a.ring) {
		previewSamples = len(a.ring)
	}
	n := len(a.ring)
	start := (a.ringPos - previewSamples + n) % n

	out := make([]float64, waveformPoints)
	step := float64(previewSamples) / float64(waveformPoints)
	sumSq := 0.0
	for i := 0; i < previewSamples; i++ {
		v := a.ring[(start+i)%n]
		sumSq += v * v
	}
	rms := math.Sqrt(sumSq / float64(previewSamples))
	rmsDb := 20.0 * math.Log10(rms+1e-9)

	for p := 0; p < waveformPoints; p++ {
		s0 := int(float64(p) * step)
		s1 := int(float64(p+1) * step)
		if s1 <= s0 {
			s1 = s0 + 1
		}
		peak := 0.0
		for j := s0; j < s1 && j < previewSamples; j++ {
			v := a.ring[(start+j)%n]
			if math.Abs(v) > math.Abs(peak) {
				peak = v
			}
		}
		out[p] = round4(peak)
	}
	return out, round2(rmsDb)
}

// measureGatedBands extracts a quasi-anechoic 12ms time-gated window [-3ms, +9ms]
// around the compressed impulse peak in `corr`, applies a Tukey taper, and whitens
// the log-chirp's 1/f spectral slope (* f^2 in power) so flat speakers read ~0 dB HF/MF.
func (a *Analyzer) measureGatedBands(corr []float64, peakIdx int) (fullDb, midDb, highDb float64) {
	pre := int(math.Round(float64(a.sampleRate) * 0.003))  // 3ms before peak
	post := int(math.Round(float64(a.sampleRate) * 0.009)) // 9ms after peak (gates out wall reflections)
	winLen := pre + post + 1
	if winLen > gateFFTSize {
		winLen = gateFFTSize
	}

	taper := winLen / 6
	if taper < 2 {
		taper = 2
	}

	for i := 0; i < gateFFTSize; i++ {
		if i < winLen {
			srcIdx := peakIdx - pre + i
			v := 0.0
			if srcIdx >= 0 && srcIdx < len(corr) {
				v = corr[srcIdx]
			}
			w := 1.0
			if i < taper {
				w = 0.5 * (1.0 - math.Cos(math.Pi*float64(i)/float64(taper)))
			} else if i >= winLen-taper {
				rem := winLen - 1 - i
				w = 0.5 * (1.0 - math.Cos(math.Pi*float64(rem)/float64(taper)))
			}
			a.specBuf[i] = complex(v*w, 0)
		} else {
			a.specBuf[i] = 0
		}
	}
	FFT(a.specBuf, false)

	binHz := float64(a.sampleRate) / float64(gateFFTSize)
	fullSum, fullCnt := 0.0, 0
	midSum, midCnt := 0.0, 0
	highSum, highCnt := 0.0, 0

	half := gateFFTSize / 2
	for k := 1; k < half; k++ {
		freq := float64(k) * binHz
		if freq < 300 || freq > 14000 {
			continue
		}
		mag := cmplx.Abs(a.specBuf[k]) / float64(winLen)
		// Whiten log-chirp autocorrelation (|X(f)|^2 ~ 1/f => |FFT(corr)|^2 ~ 1/f^2)
		whiten := (freq / 1000.0) * (freq / 1000.0)
		p := mag * mag * whiten

		fullSum += p
		fullCnt++
		if freq >= 400 && freq <= 2000 {
			midSum += p
			midCnt++
		}
		if freq >= 4000 && freq <= 12000 {
			highSum += p
			highCnt++
		}
	}

	fullDb = 10.0 * math.Log10(fullSum/math.Max(1, float64(fullCnt))+1e-18)
	midDb = 10.0 * math.Log10(midSum/math.Max(1, float64(midCnt))+1e-18)
	highDb = 10.0 * math.Log10(highSum/math.Max(1, float64(highCnt))+1e-18)
	return
}

func (a *Analyzer) measureClarity(corr []float64, peakIdx int) float64 {
	directPre := int(float64(a.sampleRate) * 0.001)
	directPost := int(float64(a.sampleRate) * 0.0025)
	earlyStart := int(float64(a.sampleRate) * 0.003)
	earlyEnd := int(float64(a.sampleRate) * 0.025)

	directE := 0.0
	for i := peakIdx - directPre; i <= peakIdx+directPost; i++ {
		if i >= 0 && i < len(corr) {
			directE += corr[i] * corr[i]
		}
	}

	earlyE := 0.0
	for i := peakIdx + earlyStart; i <= peakIdx+earlyEnd; i++ {
		if i >= 0 && i < len(corr) {
			earlyE += corr[i] * corr[i]
		}
	}

	return 10.0 * math.Log10((directE+1e-12)/(earlyE+1e-12))
}

func (a *Analyzer) extractCorrEnvelope(corr []float64, centerIdx int) []float64 {
	out := make([]float64, corrEnvPoints)
	halfSamples := float64(a.sampleRate) * (corrEnvHalfMs / 1000.0)
	samplesPerBin := (2.0 * halfSamples) / float64(corrEnvPoints)

	maxVal := 1e-12
	for p := 0; p < corrEnvPoints; p++ {
		startF := float64(centerIdx) - halfSamples + float64(p)*samplesPerBin
		endF := startF + samplesPerBin
		s0 := int(math.Floor(startF))
		s1 := int(math.Ceil(endF))
		binMax := 0.0
		for i := s0; i <= s1; i++ {
			if i >= 0 && i < len(corr) {
				v := math.Abs(corr[i])
				if v > binMax {
					binMax = v
				}
			}
		}
		out[p] = binMax
		if binMax > maxVal {
			maxVal = binMax
		}
	}

	for p := 0; p < corrEnvPoints; p++ {
		out[p] = round4(out[p] / maxVal)
	}
	return out
}

func findPeakAndSNR(corr []float64) (int, float64) {
	maxIdx := 0
	maxAbs := 0.0
	sumSq := 0.0
	for i, v := range corr {
		av := math.Abs(v)
		if av > maxAbs {
			maxAbs = av
			maxIdx = i
		}
		sumSq += v * v
	}
	rms := math.Sqrt(sumSq / float64(len(corr)))
	if rms < 1e-12 {
		return maxIdx, 0
	}
	return maxIdx, maxAbs / rms
}

func parabolicPeak(corr []float64, idx int) float64 {
	if idx <= 0 || idx >= len(corr)-1 {
		return float64(idx)
	}
	y0 := math.Abs(corr[idx-1])
	y1 := math.Abs(corr[idx])
	y2 := math.Abs(corr[idx+1])
	denom := y0 - 2.0*y1 + y2
	if math.Abs(denom) < 1e-12 {
		return float64(idx)
	}
	delta := 0.5 * (y0 - y2) / denom
	if delta > 0.5 {
		delta = 0.5
	} else if delta < -0.5 {
		delta = -0.5
	}
	return float64(idx) + delta
}

func wrapSigned(val, period float64) float64 {
	r := math.Mod(val, period)
	if r > period*0.5 {
		r -= period
	} else if r < -period*0.5 {
		r += period
	}
	return r
}

func round2(v float64) float64 { return math.Round(v*100) / 100 }
func round3(v float64) float64 { return math.Round(v*1000) / 1000 }
func round4(v float64) float64 { return math.Round(v*10000) / 10000 }

func formatOneDec(v float64) string {
	tenths := int(math.Round(v * 10))
	whole := tenths / 10
	frac := tenths % 10
	return itoa(whole) + "." + itoa(frac)
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var digits [20]byte
	i := len(digits)
	for n > 0 {
		i--
		digits[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		digits[i] = '-'
	}
	return string(digits[i:])
}
