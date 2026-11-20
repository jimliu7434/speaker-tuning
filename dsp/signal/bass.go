package signal

import (
	"encoding/binary"
	"math"
	"math/cmplx"
)

const (
	BassPeriodSeconds  = 5.00
	BassSyncSeconds    = 0.10
	BassSyncFreqStart  = 800.0
	BassSyncFreqEnd    = 2400.0
	BassSweepOffsetSec = 0.35
	BassSweepSeconds   = 4.00
	BassFreqStart      = 30.0
	BassFreqEnd        = 320.0
	bassFFTSize        = 262144 // ~5.46s @ 48kHz, ~5.94s @ 44.1kHz
	bassCurvePoints    = 96
)

// ModeAnomaly represents a detected room mode peak or null.
type ModeAnomaly struct {
	FreqHz float64 `json:"freqHz"`
	Db     float64 `json:"db"`
}

// BassAnalysisResult holds low-frequency room mode diagnostics for the UI.
type BassAnalysisResult struct {
	Ready         bool          `json:"ready"`
	Detected      bool          `json:"detected"`
	SampleRate    int           `json:"sampleRate"`
	FMinHz        float64       `json:"fMinHz"`
	InputRmsDb    float64       `json:"inputRmsDb"`
	SyncSnr       float64       `json:"syncSnr"`
	SmoothnessDb  float64       `json:"smoothnessDb"`  // StdDev in [fMin, 250Hz] (lower = better)
	SpreadDb      float64       `json:"spreadDb"`      // Max peak - Min null in [fMin, 250Hz]
	FreqsHz       []float64     `json:"freqsHz"`       // 96 log-spaced frequencies 30..320 Hz
	RawDb         []float64     `json:"rawDb"`         // Relative dB normalized to 100..250 Hz
	DetrendedDb   []float64     `json:"detrendedDb"`   // Trend-removed dB (neutralizes phone mic roll-off)
	Peaks         []ModeAnomaly `json:"peaks"`         // Top room mode peaks (>= +4 dB)
	Nulls         []ModeAnomaly `json:"nulls"`         // Top room mode nulls (<= -4.5 dB)
	Status        string        `json:"status"`        // "buffering" | "waiting" | "good" | "moderate" | "severe"
	Hint          string        `json:"hint"`
	Waveform      []float64     `json:"waveform"`
}

func generateWindowedLogSweep(sampleRate int, f0, f1, duration, taperFrac float64) []float64 {
	n := int(math.Round(float64(sampleRate) * duration))
	if n < 64 {
		n = 64
	}
	out := make([]float64, n)
	T := float64(n) / float64(sampleRate)
	ratio := f1 / f0
	lnRatio := math.Log(ratio)
	k := 2.0 * math.Pi * f0 * T / lnRatio

	taper := int(float64(n) * taperFrac)
	if taper < 1 {
		taper = 1
	}

	for i := 0; i < n; i++ {
		t := float64(i) / float64(sampleRate)
		phase := k * (math.Pow(ratio, t/T) - 1.0)
		w := 1.0
		if i < taper {
			w = 0.5 * (1.0 - math.Cos(math.Pi*float64(i)/float64(taper)))
		} else if i >= n-taper {
			rem := n - 1 - i
			w = 0.5 * (1.0 - math.Cos(math.Pi*float64(rem)/float64(taper)))
		}
		out[i] = math.Sin(phase) * w
	}
	return out
}

// GenerateBassTestWAV generates a 16-bit PCM Stereo (L+R identical mono) WAV file
// containing `loops` repetitions of the 5.0s [Sync Marker -> 4.0s 30..320Hz Sweep] frame.
func GenerateBassTestWAV(sampleRate int, loops int) []byte {
	if sampleRate <= 0 {
		sampleRate = DefaultSampleRate
	}
	if loops <= 0 {
		loops = 6 // 30 seconds
	}

	periodSamples := int(math.Round(float64(sampleRate) * BassPeriodSeconds))
	sweepStart := int(math.Round(float64(sampleRate) * BassSweepOffsetSec))
	syncChirp := generateWindowedLogSweep(sampleRate, BassSyncFreqStart, BassSyncFreqEnd, BassSyncSeconds, 0.10)
	bassSweep := generateWindowedLogSweep(sampleRate, BassFreqStart, BassFreqEnd, BassSweepSeconds, 0.05)

	totalFrames := periodSamples * loops
	numChannels := 2
	bitsPerSample := 16
	byteRate := sampleRate * numChannels * bitsPerSample / 8
	blockAlign := numChannels * bitsPerSample / 8
	dataSize := totalFrames * blockAlign

	buf := make([]byte, 44+dataSize)
	copy(buf[0:4], "RIFF")
	binary.LittleEndian.PutUint32(buf[4:8], uint32(36+dataSize))
	copy(buf[8:12], "WAVE")
	copy(buf[12:16], "fmt ")
	binary.LittleEndian.PutUint32(buf[16:20], 16)
	binary.LittleEndian.PutUint16(buf[20:22], 1)
	binary.LittleEndian.PutUint16(buf[22:24], uint16(numChannels))
	binary.LittleEndian.PutUint32(buf[24:28], uint32(sampleRate))
	binary.LittleEndian.PutUint32(buf[28:32], uint32(byteRate))
	binary.LittleEndian.PutUint16(buf[32:34], uint16(blockAlign))
	binary.LittleEndian.PutUint16(buf[34:36], uint16(bitsPerSample))
	copy(buf[36:40], "data")
	binary.LittleEndian.PutUint32(buf[40:44], uint32(dataSize))

	const syncGain = 0.55 * 32767.0
	const bassGain = 0.80 * 32767.0

	offset := 44
	for loop := 0; loop < loops; loop++ {
		for i := 0; i < periodSamples; i++ {
			var sample int16
			if i < len(syncChirp) {
				sample = int16(math.Round(syncChirp[i] * syncGain))
			} else if i >= sweepStart && i < sweepStart+len(bassSweep) {
				sample = int16(math.Round(bassSweep[i-sweepStart] * bassGain))
			}
			u := uint16(sample)
			binary.LittleEndian.PutUint16(buf[offset:offset+2], u)
			binary.LittleEndian.PutUint16(buf[offset+2:offset+4], u)
			offset += 4
		}
	}
	return buf
}

// BassAnalyzer detects the sync marker and computes 30-320 Hz room mode curves.
type BassAnalyzer struct {
	sampleRate   int
	fMinHz       float64
	ring         []float64
	ringPos      int
	totalSamples int64

	syncLen      int
	sweepOffset  int
	sweepCapture int

	syncTemplateConj []complex128
	syncNorm         float64
	idealBassMag     []float64 // magnitude spectrum of ideal 4.0s bass sweep (0..bassFFTSize/2)
	freqsHz          []float64

	// Reusable buffers
	chronoBuf []float64
	fftWork   []complex128
	corrSync  []float64
}

// NewBassAnalyzer creates a low-frequency room mode analyzer.
func NewBassAnalyzer(sampleRate int, fMinHz float64) *BassAnalyzer {
	if sampleRate <= 0 {
		sampleRate = DefaultSampleRate
	}
	if fMinHz < 30 || fMinHz > 120 {
		fMinHz = 40.0 // Default for MBL 311 C4 (38 Hz spec)
	}

	syncChirp := generateWindowedLogSweep(sampleRate, BassSyncFreqStart, BassSyncFreqEnd, BassSyncSeconds, 0.10)
	bassSweep := generateWindowedLogSweep(sampleRate, BassFreqStart, BassFreqEnd, BassSweepSeconds, 0.05)

	syncEnergy := 0.0
	for _, v := range syncChirp {
		syncEnergy += v * v
	}

	syncFFT := make([]complex128, bassFFTSize)
	for i, v := range syncChirp {
		syncFFT[i] = complex(v, 0)
	}
	FFT(syncFFT, false)

	bassFFT := make([]complex128, bassFFTSize)
	for i, v := range bassSweep {
		bassFFT[i] = complex(v, 0)
	}
	FFT(bassFFT, false)

	half := bassFFTSize / 2
	idealMag := make([]float64, half)
	for k := 0; k < half; k++ {
		idealMag[k] = cmplx.Abs(bassFFT[k])
	}

	freqs := make([]float64, bassCurvePoints)
	logRatio := math.Log(BassFreqEnd / BassFreqStart)
	for i := 0; i < bassCurvePoints; i++ {
		frac := float64(i) / float64(bassCurvePoints-1)
		freqs[i] = round2(BassFreqStart * math.Exp(frac*logRatio))
	}

	return &BassAnalyzer{
		sampleRate:       sampleRate,
		fMinHz:           fMinHz,
		ring:             make([]float64, bassFFTSize),
		syncLen:          len(syncChirp),
		sweepOffset:      int(math.Round(float64(sampleRate) * BassSweepOffsetSec)),
		sweepCapture:     int(math.Round(float64(sampleRate) * (BassSweepSeconds + 0.30))),
		syncTemplateConj: ConjugateCopy(syncFFT),
		syncNorm:         math.Sqrt(syncEnergy),
		idealBassMag:     idealMag,
		freqsHz:          freqs,
		chronoBuf:        make([]float64, bassFFTSize),
		fftWork:          make([]complex128, bassFFTSize),
		corrSync:         make([]float64, bassFFTSize),
	}
}

// SetFMin updates the speaker low-frequency cutoff (Hz) used for mode scoring.
func (b *BassAnalyzer) SetFMin(fMinHz float64) {
	if fMinHz >= 30 && fMinHz <= 120 {
		b.fMinHz = fMinHz
	}
}

// Reset clears the ring buffer.
func (b *BassAnalyzer) Reset() {
	for i := range b.ring {
		b.ring[i] = 0
	}
	b.ringPos = 0
	b.totalSamples = 0
}

// PushSamples appends incoming mono float32 PCM samples.
func (b *BassAnalyzer) PushSamples(samples []float32) {
	n := len(b.ring)
	for _, s := range samples {
		b.ring[b.ringPos] = float64(s)
		b.ringPos++
		if b.ringPos >= n {
			b.ringPos = 0
		}
	}
	b.totalSamples += int64(len(samples))
}

// Analyze detects a complete 4.0s bass sweep in the ring buffer and extracts room modes.
func (b *BassAnalyzer) Analyze() BassAnalysisResult {
	res := BassAnalysisResult{
		SampleRate: b.sampleRate,
		FMinHz:     b.fMinHz,
		FreqsHz:    b.freqsHz,
		Status:     "buffering",
		Hint:       "正在收集低頻掃頻訊號（需約 5 秒完整週期）...",
	}

	res.Waveform, res.InputRmsDb = b.buildWaveformPreview()

	minSamples := int64(math.Round(float64(b.sampleRate) * 4.8))
	if b.totalSamples < minSamples {
		return res
	}
	res.Ready = true

	// 1. Copy ring buffer chronologically and remove DC
	n := bassFFTSize
	mean := 0.0
	for i := 0; i < n; i++ {
		v := b.ring[(b.ringPos+i)%n]
		b.chronoBuf[i] = v
		mean += v
	}
	mean /= float64(n)
	for i := 0; i < n; i++ {
		v := b.chronoBuf[i] - mean
		b.chronoBuf[i] = v
		b.fftWork[i] = complex(v, 0)
	}

	// 2. Correlate with Sync Marker (800-2400 Hz) to locate the exact sweep start
	FFT(b.fftWork, false)
	for i := 0; i < n; i++ {
		b.fftWork[i] *= b.syncTemplateConj[i]
	}
	FFT(b.fftWork, true)
	for i := 0; i < n; i++ {
		b.corrSync[i] = real(b.fftWork[i]) / b.syncNorm
	}

	// Valid sync position must allow the full 4.3s sweep capture to fit inside chronoBuf
	validLimit := n - b.sweepOffset - b.sweepCapture
	if validLimit <= 0 {
		validLimit = n - b.syncLen
	}
	syncIdx, snr := findPeakAndSNR(b.corrSync[:validLimit])
	res.SyncSnr = round2(snr)

	if snr < 6.0 {
		res.Status = "waiting"
		res.Hint = "尚未偵測到低頻掃頻測試音，請播放「低頻駐波測試 WAV (30–320 Hz)」。"
		return res
	}

	res.Detected = true

	// 3. Slice out the 4.3s recorded bass sweep and compute high-res FFT
	startIdx := syncIdx + b.sweepOffset
	endIdx := startIdx + b.sweepCapture
	if endIdx > n {
		endIdx = n
	}

	for i := 0; i < n; i++ {
		if startIdx+i < endIdx {
			b.fftWork[i] = complex(b.chronoBuf[startIdx+i], 0)
		} else {
			b.fftWork[i] = 0
		}
	}
	FFT(b.fftWork, false)

	// 4. Compute transfer magnitude |FFT(rec)| / |FFT(ideal)| across 96 log-spaced bands (1/12-oct smoothing)
	binHz := float64(b.sampleRate) / float64(n)
	rawDb := make([]float64, bassCurvePoints)
	halfOctFactor := math.Pow(2.0, 1.0/24.0) // +/- 1/24 oct => 1/12 oct window

	for i, fc := range b.freqsHz {
		fLow := fc / halfOctFactor
		fHigh := fc * halfOctFactor
		k0 := int(math.Floor(fLow / binHz))
		k1 := int(math.Ceil(fHigh / binHz))
		if k0 < 1 {
			k0 = 1
		}
		if k1 >= n/2 {
			k1 = n/2 - 1
		}

		recPow := 0.0
		refPow := 0.0
		for k := k0; k <= k1; k++ {
			rm := cmplx.Abs(b.fftWork[k])
			im := b.idealBassMag[k]
			recPow += rm * rm
			refPow += im * im
		}
		ratio := (recPow + 1e-18) / (refPow + 1e-18)
		rawDb[i] = 10.0 * math.Log10(ratio)
	}

	// Normalize rawDb so average in 100-250 Hz == 0 dB
	normSum, normCnt := 0.0, 0
	for i, fc := range b.freqsHz {
		if fc >= 100.0 && fc <= 250.0 {
			normSum += rawDb[i]
			normCnt++
		}
	}
	normOffset := 0.0
	if normCnt > 0 {
		normOffset = normSum / float64(normCnt)
	}
	for i := range rawDb {
		rawDb[i] = round2(rawDb[i] - normOffset)
	}

	// 5. Compute Detrended Room Mode Deviation (subtract ~1-octave moving average to neutralize phone mic roll-off)
	// 96 points span log2(320/30) = 3.415 octaves -> ~28 points per octave -> half-window = 14
	const halfWin = 14
	detrended := make([]float64, bassCurvePoints)
	for i := 0; i < bassCurvePoints; i++ {
		w0 := i - halfWin
		w1 := i + halfWin
		if w0 < 0 {
			w0 = 0
		}
		if w1 >= bassCurvePoints {
			w1 = bassCurvePoints - 1
		}
		sum := 0.0
		for j := w0; j <= w1; j++ {
			sum += rawDb[j]
		}
		trend := sum / float64(w1-w0+1)
		detrended[i] = round2(rawDb[i] - trend)
	}

	res.RawDb = rawDb
	res.DetrendedDb = detrended

	// 6. Score smoothness and detect Peaks & Nulls in [fMinHz, 250 Hz]
	sumSq, cnt := 0.0, 0
	minVal, maxVal := 1e9, -1e9
	var peaks []ModeAnomaly
	var nulls []ModeAnomaly

	for i := 1; i < bassCurvePoints-1; i++ {
		fc := b.freqsHz[i]
		if fc < b.fMinHz || fc > 250.0 {
			continue
		}
		v := detrended[i]
		sumSq += v * v
		cnt++
		if v < minVal {
			minVal = v
		}
		if v > maxVal {
			maxVal = v
		}

		// Local peak
		if v >= 4.0 && v >= detrended[i-1] && v >= detrended[i+1] {
			peaks = append(peaks, ModeAnomaly{FreqHz: math.Round(fc), Db: v})
		}
		// Local null
		if v <= -4.5 && v <= detrended[i-1] && v <= detrended[i+1] {
			nulls = append(nulls, ModeAnomaly{FreqHz: math.Round(fc), Db: v})
		}
	}

	// Keep up to top 3 strongest peaks & nulls (deduplicating closely spaced ones)
	res.Peaks = topAnomalies(peaks, true, 3)
	res.Nulls = topAnomalies(nulls, false, 3)

	stdDev := 0.0
	spread := 0.0
	if cnt > 0 {
		stdDev = math.Sqrt(sumSq / float64(cnt))
		spread = maxVal - minVal
	}
	res.SmoothnessDb = round2(stdDev)
	res.SpreadDb = round2(spread)

	if stdDev <= 3.0 && spread <= 10.0 {
		res.Status = "good"
		res.Hint = "低頻響應相當平順（標準差 " + formatOneDec(stdDev) + " dB），目前喇叭離牆與聆聽前後距離表現良好！"
	} else if stdDev <= 5.0 {
		res.Status = "moderate"
		res.Hint = "偵測到中度房間駐波（峰谷落差 " + formatOneDec(spread) + " dB）。建議儲存快照 A，將喇叭離後牆或座椅前後移動 15–25 cm 後存快照 B 對比。"
	} else {
		res.Status = "severe"
		res.Hint = "低頻駐波起伏較大（峰谷落差 " + formatOneDec(spread) + " dB）。建議優先避開深度凹陷（Null）：嘗試將喇叭前移/後移 20 cm 或調整聆聽位前後距離，用 A/B 快照找出最平順位置。"
	}

	return res
}

func (b *BassAnalyzer) buildWaveformPreview() ([]float64, float64) {
	previewSamples := int(float64(b.sampleRate) * 0.08)
	if previewSamples > len(b.ring) {
		previewSamples = len(b.ring)
	}
	n := len(b.ring)
	start := (b.ringPos - previewSamples + n) % n

	out := make([]float64, waveformPoints)
	step := float64(previewSamples) / float64(waveformPoints)
	sumSq := 0.0
	for i := 0; i < previewSamples; i++ {
		v := b.ring[(start+i)%n]
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
			v := b.ring[(start+j)%n]
			if math.Abs(v) > math.Abs(peak) {
				peak = v
			}
		}
		out[p] = round4(peak)
	}
	return out, round2(rmsDb)
}

func topAnomalies(in []ModeAnomaly, descending bool, limit int) []ModeAnomaly {
	if len(in) == 0 {
		return nil
	}
	// Simple selection sort (slice is tiny)
	arr := make([]ModeAnomaly, len(in))
	copy(arr, in)
	for i := 0; i < len(arr); i++ {
		best := i
		for j := i + 1; j < len(arr); j++ {
			if (descending && arr[j].Db > arr[best].Db) || (!descending && arr[j].Db < arr[best].Db) {
				best = j
			}
		}
		arr[i], arr[best] = arr[best], arr[i]
	}
	var out []ModeAnomaly
	for _, a := range arr {
		tooClose := false
		for _, kept := range out {
			if math.Abs(a.FreqHz-kept.FreqHz)/kept.FreqHz < 0.14 {
				tooClose = true
				break
			}
		}
		if !tooClose {
			out = append(out, a)
			if len(out) >= limit {
				break
			}
		}
	}
	return out
}
