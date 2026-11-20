package signal

import (
	"math"
	"testing"
)

// Simple biquad filter for simulating room modes (peak/null) and phone mic high-pass roll-off.
type biquad struct {
	b0, b1, b2, a1, a2 float64
	x1, x2, y1, y2     float64
}

func newPeakingEQ(fs, f0, q, gainDb float64) *biquad {
	A := math.Pow(10, gainDb/40.0)
	w0 := 2.0 * math.Pi * f0 / fs
	alpha := math.Sin(w0) / (2.0 * q)
	cosW := math.Cos(w0)
	b0 := 1 + alpha*A
	b1 := -2 * cosW
	b2 := 1 - alpha*A
	a0 := 1 + alpha/A
	a1 := -2 * cosW
	a2 := 1 - alpha/A
	return &biquad{b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0}
}

func newHighPass1st(fs, fc float64) *biquad {
	// Gentle 6dB/oct phone mic low-end roll-off
	rc := 1.0 / (2.0 * math.Pi * fc)
	dt := 1.0 / fs
	alpha := rc / (rc + dt)
	return &biquad{b0: alpha, b1: -alpha, b2: 0, a1: -alpha, a2: 0}
}

func (f *biquad) process(x float64) float64 {
	y := f.b0*x + f.b1*f.x1 + f.b2*f.x2 - f.a1*f.y1 - f.a2*f.y2
	f.x2, f.x1 = f.x1, x
	f.y2, f.y1 = f.y1, y
	return y
}

func TestBassRoomModeDetectionWithMicRollOff(t *testing.T) {
	const sr = 48000
	periodSamples := int(math.Round(float64(sr) * BassPeriodSeconds))
	sweepStart := int(math.Round(float64(sr) * BassSweepOffsetSec))
	syncChirp := generateWindowedLogSweep(sr, BassSyncFreqStart, BassSyncFreqEnd, BassSyncSeconds, 0.10)
	bassSweep := generateWindowedLogSweep(sr, BassFreqStart, BassFreqEnd, BassSweepSeconds, 0.05)

	// Simulate:
	// - Phone mic rolling off below 90 Hz
	// - Room mode PEAK at 58 Hz (+10 dB, Q=6)
	// - Room mode NULL at 112 Hz (-11 dB, Q=6)
	micHP := newHighPass1st(sr, 90.0)
	peak58 := newPeakingEQ(sr, 58.0, 6.0, +10.0)
	null112 := newPeakingEQ(sr, 112.0, 6.0, -11.0)

	total := int(math.Round(float64(sr) * 5.4))
	scene := make([]float32, total)
	const offset = 8000
	for i := 0; i < periodSamples && offset+i < total; i++ {
		x := 0.0
		if i < len(syncChirp) {
			x = syncChirp[i] * 0.55
		} else if i >= sweepStart && i < sweepStart+len(bassSweep) {
			x = bassSweep[i-sweepStart] * 0.70
		}
		y := null112.process(peak58.process(micHP.process(x)))
		scene[offset+i] = float32(y)
	}

	ba := NewBassAnalyzer(sr, 40.0)
	ba.PushSamples(scene)
	res := ba.Analyze()

	if !res.Detected {
		t.Fatalf("expected bass sweep detected, got syncSnr=%.2f", res.SyncSnr)
	}
	if len(res.Peaks) == 0 {
		t.Fatalf("expected at least 1 peak near 58Hz, got none")
	}
	if math.Abs(res.Peaks[0].FreqHz-58.0) > 6.0 {
		t.Fatalf("expected strongest peak near 58Hz, got %.1f Hz (%.2f dB)", res.Peaks[0].FreqHz, res.Peaks[0].Db)
	}
	if len(res.Nulls) == 0 {
		t.Fatalf("expected at least 1 null near 112Hz, got none")
	}
	if math.Abs(res.Nulls[0].FreqHz-112.0) > 10.0 {
		t.Fatalf("expected deepest null near 112Hz, got %.1f Hz (%.2f dB)", res.Nulls[0].FreqHz, res.Nulls[0].Db)
	}
}

func TestGenerateBassTestWAV(t *testing.T) {
	wav := GenerateBassTestWAV(48000, 1)
	if len(wav) <= 44 || string(wav[0:4]) != "RIFF" {
		t.Fatalf("invalid bass wav generated")
	}
}
