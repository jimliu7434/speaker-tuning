package signal

import (
	"encoding/binary"
	"math"
)

const (
	DefaultSampleRate = 48000
	PeriodSeconds     = 1.60
	ChirpSeconds      = 0.12
	FreqStart         = 300.0
	FreqEnd           = 14000.0
	SpeedOfSound      = 343.0
)

// GenerateLogChirp generates a Tukey-windowed logarithmic chirp.
// If ascending is true: FreqStart -> FreqEnd.
// If ascending is false: exact time-reversal of the ascending chirp so both
// chirps have identical magnitude spectra while being orthogonal in correlation.
func GenerateLogChirp(sampleRate int, ascending bool) []float64 {
	n := int(math.Round(float64(sampleRate) * ChirpSeconds))
	if n < 64 {
		n = 64
	}
	out := make([]float64, n)
	T := float64(n) / float64(sampleRate)
	ratio := FreqEnd / FreqStart
	lnRatio := math.Log(ratio)
	k := 2.0 * math.Pi * FreqStart * T / lnRatio

	// 10% Tukey taper on each edge
	taper := int(float64(n) * 0.10)
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

	if !ascending {
		for i, j := 0, n-1; i < j; i, j = i+1, j-1 {
			out[i], out[j] = out[j], out[i]
		}
	}
	return out
}

// GenerateTestWAV generates a 16-bit PCM Stereo WAV file containing `loops`
// seamless repetitions of the 1.60s L(Up-Chirp) -> R(Down-Chirp) test frame.
func GenerateTestWAV(sampleRate int, loops int) []byte {
	if sampleRate <= 0 {
		sampleRate = DefaultSampleRate
	}
	if loops <= 0 {
		loops = 60
	}

	periodSamples := int(math.Round(float64(sampleRate) * PeriodSeconds))
	halfPeriod := periodSamples / 2
	up := GenerateLogChirp(sampleRate, true)
	down := GenerateLogChirp(sampleRate, false)

	totalFrames := periodSamples * loops
	numChannels := 2
	bitsPerSample := 16
	byteRate := sampleRate * numChannels * bitsPerSample / 8
	blockAlign := numChannels * bitsPerSample / 8
	dataSize := totalFrames * blockAlign

	buf := make([]byte, 44+dataSize)

	// RIFF header
	copy(buf[0:4], "RIFF")
	binary.LittleEndian.PutUint32(buf[4:8], uint32(36+dataSize))
	copy(buf[8:12], "WAVE")

	// fmt subchunk
	copy(buf[12:16], "fmt ")
	binary.LittleEndian.PutUint32(buf[16:20], 16)
	binary.LittleEndian.PutUint16(buf[20:22], 1) // PCM
	binary.LittleEndian.PutUint16(buf[22:24], uint16(numChannels))
	binary.LittleEndian.PutUint32(buf[24:28], uint32(sampleRate))
	binary.LittleEndian.PutUint32(buf[28:32], uint32(byteRate))
	binary.LittleEndian.PutUint16(buf[32:34], uint16(blockAlign))
	binary.LittleEndian.PutUint16(buf[34:36], uint16(bitsPerSample))

	// data subchunk
	copy(buf[36:40], "data")
	binary.LittleEndian.PutUint32(buf[40:44], uint32(dataSize))

	const gain = 0.85 * 32767.0
	offset := 44
	for loop := 0; loop < loops; loop++ {
		for i := 0; i < periodSamples; i++ {
			var sampleL, sampleR int16
			if i < len(up) {
				sampleL = int16(math.Round(up[i] * gain))
			}
			if i >= halfPeriod && i < halfPeriod+len(down) {
				sampleR = int16(math.Round(down[i-halfPeriod] * gain))
			}
			binary.LittleEndian.PutUint16(buf[offset:offset+2], uint16(sampleL))
			binary.LittleEndian.PutUint16(buf[offset+2:offset+4], uint16(sampleR))
			offset += 4
		}
	}

	return buf
}
