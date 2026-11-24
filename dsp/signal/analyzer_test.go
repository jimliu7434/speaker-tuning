package signal

import (
	"math"
	"testing"
)

func synthesizeAcousticScene(sampleRate int, delayRSamples int, gainL, gainR float64, lowpassL bool) []float32 {
	periodSamples := int(math.Round(float64(sampleRate) * PeriodSeconds))
	halfPeriod := periodSamples / 2
	up := GenerateLogChirp(sampleRate, true)
	down := GenerateLogChirp(sampleRate, false)

	// Optional simple 1-pole lowpass on L to simulate off-axis high-frequency roll-off (bad toe-in)
	if lowpassL {
		alpha := 0.25
		y := 0.0
		filtered := make([]float64, len(up))
		for i, x := range up {
			y = y + alpha*(x-y)
			filtered[i] = y
		}
		up = filtered
	}

	total := int(float64(sampleRate) * 2.8)
	buf := make([]float32, total)

	for start := 4000; start < total; start += periodSamples {
		for i, v := range up {
			if start+i < total {
				buf[start+i] += float32(v * gainL)
			}
		}
		rStart := start + halfPeriod + delayRSamples
		for i, v := range down {
			if rStart+i >= 0 && rStart+i < total {
				buf[rStart+i] += float32(v * gainR)
			}
		}
	}
	return buf
}

func TestSweetSpotCentered(t *testing.T) {
	a := NewAnalyzer(48000)
	scene := synthesizeAcousticScene(48000, 0, 0.5, 0.5, false)
	a.PushSamples(scene)
	res := a.Analyze()

	if !res.Detected {
		t.Fatalf("expected signal detected, got snrL=%.2f snrR=%.2f", res.SnrL, res.SnrR)
	}
	if math.Abs(res.OffsetCm) > 0.5 {
		t.Fatalf("expected centered offset ~0 cm, got %.2f cm", res.OffsetCm)
	}
	if res.SweetSpotStatus != "centered" {
		t.Fatalf("expected centered status, got %s", res.SweetSpotStatus)
	}
	if res.ToeInStatus != "balanced" {
		t.Fatalf("expected balanced toe-in, got %s (asym=%.2f dB)", res.ToeInStatus, res.ToeInAsymDb)
	}
}

func TestSweetSpotOffsetAndToeIn(t *testing.T) {
	// Delay R by +14 samples @ 48kHz (~0.292ms -> ~10.0cm -> listener is too far Left -> move Right)
	// Also apply low-pass to L to simulate left speaker aimed off-axis
	a := NewAnalyzer(48000)
	scene := synthesizeAcousticScene(48000, 14, 0.5, 0.5, true)
	a.PushSamples(scene)
	res := a.Analyze()

	if !res.Detected {
		t.Fatalf("expected signal detected")
	}
	if res.SweetSpotStatus != "move_right" {
		t.Fatalf("expected move_right, got %s (offset=%.2f cm)", res.SweetSpotStatus, res.OffsetCm)
	}
	if math.Abs(res.OffsetCm-10.0) > 1.5 {
		t.Fatalf("expected offset ~10.0 cm, got %.2f cm", res.OffsetCm)
	}
	if res.ToeInStatus != "toe_in_left" {
		t.Fatalf("expected toe_in_left when L has HF roll-off, got %s (asym=%.2f dB)", res.ToeInStatus, res.ToeInAsymDb)
	}
}

func TestGenerateTestWAV(t *testing.T) {
	wav := GenerateTestWAV(48000, 2)
	if len(wav) <= 44 {
		t.Fatalf("expected valid wav bytes, got %d", len(wav))
	}
	if string(wav[0:4]) != "RIFF" || string(wav[8:12]) != "WAVE" {
		t.Fatalf("invalid wav header")
	}
}

func TestToeInStabilityWithRoomEchoAndSlidingWindow(t *testing.T) {
	const sr = 48000
	a := NewAnalyzer(sr)
	// Off-center (+40 samples ~ 28cm) with symmetric flat speakers + strong room reflection (+18ms, 0.45x)
	periodSamples := int(math.Round(float64(sr) * PeriodSeconds))
	halfPeriod := periodSamples / 2
	up := GenerateLogChirp(sr, true)
	down := GenerateLogChirp(sr, false)

	total := int(float64(sr) * 6.0)
	buf := make([]float32, total)
	echoDelay := int(math.Round(float64(sr) * 0.018)) // 18ms wall reflection

	for start := 2000; start < total; start += periodSamples {
		for i, v := range up {
			if start+i < total {
				buf[start+i] += float32(v * 0.5)
			}
			if start+echoDelay+i < total {
				buf[start+echoDelay+i] += float32(v * 0.22)
			}
		}
		rStart := start + halfPeriod + 40
		for i, v := range down {
			if rStart+i < total {
				buf[rStart+i] += float32(v * 0.5)
			}
			if rStart+echoDelay+i < total {
				buf[rStart+echoDelay+i] += float32(v * 0.22)
			}
		}
	}

	// Stream in 16800-sample (~350ms) chunks just like the live Web Worker
	const chunk = 16800
	checked := 0
	for pos := 0; pos+chunk <= total; pos += chunk {
		a.PushSamples(buf[pos : pos+chunk])
		res := a.Analyze()
		if res.Detected {
			checked++
			if math.Abs(res.ToeInAsymDb) > 1.2 {
				t.Fatalf("frame %d: expected stable toeInAsymDb near 0 dB even off-center with echo, got %.2f dB", checked, res.ToeInAsymDb)
			}
		}
	}
	if checked < 5 {
		t.Fatalf("expected at least 5 detected frames, got %d", checked)
	}
}

func TestLoopGapRejected(t *testing.T) {
	const sr = 48000
	a := NewAnalyzer(sr)
	periodSamples := int(math.Round(float64(sr) * PeriodSeconds))
	halfPeriod := periodSamples / 2
	up := GenerateLogChirp(sr, true)
	down := GenerateLogChirp(sr, false)

	// Build a 2.8s window containing cycle 1, then a 120ms player loop gap, then cycle 2
	gapSamples := int(math.Round(float64(sr) * 0.120))
	total := int(float64(sr) * 2.85)
	buf := make([]float32, total)

	c1 := 3000
	c2 := c1 + periodSamples + gapSamples
	for _, start := range []int{c1, c2} {
		for i, v := range up {
			if start+i < total {
				buf[start+i] += float32(v * 0.5)
			}
		}
		rStart := start + halfPeriod
		for i, v := range down {
			if rStart+i < total {
				buf[rStart+i] += float32(v * 0.5)
			}
		}
	}

	a.PushSamples(buf)
	res := a.Analyze()
	if res.Detected {
		t.Fatalf("expected loop-gap frame to be rejected, but got detected=true deltaMs=%.3f", res.RawDeltaMs)
	}
}

func TestClockDriftSelfCalibration(t *testing.T) {
	const sr = 48000
	a := NewAnalyzer(sr)
	// Simulate +300 ppm clock drift between player DAC and phone mic:
	// nominal period 1.60s becomes 1.60048s (+0.48ms per period).
	driftedPeriod := int(math.Round(float64(sr) * PeriodSeconds * 1.0003))
	driftedHalf := driftedPeriod / 2
	up := GenerateLogChirp(sr, true)
	down := GenerateLogChirp(sr, false)

	total := int(float64(sr) * 2.85)
	buf := make([]float32, total)
	for start := 4000; start < total; start += driftedPeriod {
		for i, v := range up {
			if start+i < total {
				buf[start+i] += float32(v * 0.5)
			}
		}
		rStart := start + driftedHalf
		for i, v := range down {
			if rStart+i < total {
				buf[rStart+i] += float32(v * 0.5)
			}
		}
	}

	a.PushSamples(buf)
	res := a.Analyze()
	if !res.Detected {
		t.Fatalf("expected signal detected under +300ppm clock drift")
	}
	if math.Abs(res.RawDeltaMs) > 0.05 {
		t.Fatalf("expected self-calibrated deltaMs near 0ms, got %.3f ms (measuredPeriod=%.3f ms)", res.RawDeltaMs, res.MeasuredPeriodMs)
	}
}

func TestFirstArrivalLocksDirectSoundOverStrongReflection(t *testing.T) {
	const sr = 48000
	a := NewAnalyzer(sr)
	periodSamples := int(math.Round(float64(sr) * PeriodSeconds))
	halfPeriod := periodSamples / 2
	up := GenerateLogChirp(sr, true)
	down := GenerateLogChirp(sr, false)

	// R has a strong inverted early reflection (+3.0ms, 1.15x amplitude) simulating desk/wall bounce
	reflDelay := int(math.Round(float64(sr) * 0.003))
	total := int(float64(sr) * 2.85)
	buf := make([]float32, total)
	for start := 4000; start < total; start += periodSamples {
		for i, v := range up {
			if start+i < total {
				buf[start+i] += float32(v * 0.5)
			}
		}
		rStart := start + halfPeriod
		for i, v := range down {
			if rStart+i < total {
				buf[rStart+i] += float32(v * 0.5)
			}
			if rStart+reflDelay+i < total {
				buf[rStart+reflDelay+i] -= float32(v * 0.58)
			}
		}
	}

	a.PushSamples(buf)
	res := a.Analyze()
	if !res.Detected {
		t.Fatalf("expected signal detected")
	}
	if math.Abs(res.RawDeltaMs) > 0.15 {
		t.Fatalf("expected first-arrival to lock direct sound (~0ms), not +3ms reflection; got %.3f ms", res.RawDeltaMs)
	}
}
