package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"speaker-tuning/dsp/signal"
)

func main() {
	mode := flag.String("mode", "sweetspot", "Signal mode: 'sweetspot' (L/R chirp) or 'bass' (30-320Hz room mode sweep)")
	outPath := flag.String("out", "speaker-tuning-test.wav", "Output WAV file path")
	sampleRate := flag.Int("rate", signal.DefaultSampleRate, "Sample rate in Hz")
	loops := flag.Int("loops", 0, "Number of cycles (default: 15 for sweetspot, 6 for bass)")
	flag.Parse()

	var wav []byte
	usedLoops := *loops
	if *mode == "bass" {
		if usedLoops <= 0 {
			usedLoops = 6
		}
		wav = signal.GenerateBassTestWAV(*sampleRate, usedLoops)
	} else {
		if usedLoops <= 0 {
			usedLoops = 15
		}
		wav = signal.GenerateTestWAV(*sampleRate, usedLoops)
	}

	if dir := filepath.Dir(*outPath); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			fmt.Fprintf(os.Stderr, "failed to create directory: %v\n", err)
			os.Exit(1)
		}
	}
	if err := os.WriteFile(*outPath, wav, 0o644); err != nil {
		fmt.Fprintf(os.Stderr, "failed to write wav: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("Generated [%s] %s (%d bytes, %d Hz, %d loops)\n", *mode, *outPath, len(wav), *sampleRate, usedLoops)
}
