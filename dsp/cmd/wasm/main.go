//go:build js && wasm

package main

import (
	"encoding/binary"
	"encoding/json"
	"math"
	"syscall/js"

	"speaker-tuning/dsp/signal"
)

var (
	analyzer     *signal.Analyzer
	bassAnalyzer *signal.BassAnalyzer
	byteBuf      []byte
	f32Buf       []float32
)

func decodeFloat32Bytes(u8 js.Value) []float32 {
	nBytes := u8.Get("byteLength").Int()
	if nBytes < 4 {
		return nil
	}
	if cap(byteBuf) < nBytes {
		byteBuf = make([]byte, nBytes)
	}
	byteBuf = byteBuf[:nBytes]
	js.CopyBytesToGo(byteBuf, u8)

	count := nBytes / 4
	if cap(f32Buf) < count {
		f32Buf = make([]float32, count)
	}
	f32Buf = f32Buf[:count]
	for i := 0; i < count; i++ {
		bits := binary.LittleEndian.Uint32(byteBuf[i*4 : i*4+4])
		f32Buf[i] = math.Float32frombits(bits)
	}
	return f32Buf
}

func dspInit(_ js.Value, args []js.Value) any {
	sr := signal.DefaultSampleRate
	if len(args) > 0 && args[0].Type() == js.TypeNumber {
		sr = args[0].Int()
	}
	analyzer = signal.NewAnalyzer(sr)
	return true
}

func dspReset(_ js.Value, _ []js.Value) any {
	if analyzer != nil {
		analyzer.Reset()
	}
	return true
}

func dspPushSamples(_ js.Value, args []js.Value) any {
	if analyzer == nil || len(args) < 1 {
		return false
	}
	samples := decodeFloat32Bytes(args[0])
	if len(samples) == 0 {
		return false
	}
	analyzer.PushSamples(samples)
	return true
}

func dspAnalyze(_ js.Value, _ []js.Value) any {
	if analyzer == nil {
		return "{}"
	}
	res := analyzer.Analyze()
	b, err := json.Marshal(res)
	if err != nil {
		return "{}"
	}
	return string(b)
}

func dspGenerateTestWav(_ js.Value, args []js.Value) any {
	sr := signal.DefaultSampleRate
	loops := 60
	if len(args) > 0 && args[0].Type() == js.TypeNumber {
		sr = args[0].Int()
	}
	if len(args) > 1 && args[1].Type() == js.TypeNumber {
		loops = args[1].Int()
	}
	wavBytes := signal.GenerateTestWAV(sr, loops)
	out := js.Global().Get("Uint8Array").New(len(wavBytes))
	js.CopyBytesToJS(out, wavBytes)
	return out
}

// --- Phase 2: Bass Room Mode WASM Exports ---

func dspBassInit(_ js.Value, args []js.Value) any {
	sr := signal.DefaultSampleRate
	fMin := 40.0
	if len(args) > 0 && args[0].Type() == js.TypeNumber {
		sr = args[0].Int()
	}
	if len(args) > 1 && args[1].Type() == js.TypeNumber {
		fMin = args[1].Float()
	}
	bassAnalyzer = signal.NewBassAnalyzer(sr, fMin)
	return true
}

func dspBassSetFMin(_ js.Value, args []js.Value) any {
	if bassAnalyzer != nil && len(args) > 0 && args[0].Type() == js.TypeNumber {
		bassAnalyzer.SetFMin(args[0].Float())
	}
	return true
}

func dspBassReset(_ js.Value, _ []js.Value) any {
	if bassAnalyzer != nil {
		bassAnalyzer.Reset()
	}
	return true
}

func dspBassPushSamples(_ js.Value, args []js.Value) any {
	if bassAnalyzer == nil || len(args) < 1 {
		return false
	}
	samples := decodeFloat32Bytes(args[0])
	if len(samples) == 0 {
		return false
	}
	bassAnalyzer.PushSamples(samples)
	return true
}

func dspBassAnalyze(_ js.Value, _ []js.Value) any {
	if bassAnalyzer == nil {
		return "{}"
	}
	res := bassAnalyzer.Analyze()
	b, err := json.Marshal(res)
	if err != nil {
		return "{}"
	}
	return string(b)
}

func dspGenerateBassWav(_ js.Value, args []js.Value) any {
	sr := signal.DefaultSampleRate
	loops := 6
	if len(args) > 0 && args[0].Type() == js.TypeNumber {
		sr = args[0].Int()
	}
	if len(args) > 1 && args[1].Type() == js.TypeNumber {
		loops = args[1].Int()
	}
	wavBytes := signal.GenerateBassTestWAV(sr, loops)
	out := js.Global().Get("Uint8Array").New(len(wavBytes))
	js.CopyBytesToJS(out, wavBytes)
	return out
}

func main() {
	g := js.Global()
	g.Set("dspInit", js.FuncOf(dspInit))
	g.Set("dspReset", js.FuncOf(dspReset))
	g.Set("dspPushSamples", js.FuncOf(dspPushSamples))
	g.Set("dspAnalyze", js.FuncOf(dspAnalyze))
	g.Set("dspGenerateTestWav", js.FuncOf(dspGenerateTestWav))

	g.Set("dspBassInit", js.FuncOf(dspBassInit))
	g.Set("dspBassSetFMin", js.FuncOf(dspBassSetFMin))
	g.Set("dspBassReset", js.FuncOf(dspBassReset))
	g.Set("dspBassPushSamples", js.FuncOf(dspBassPushSamples))
	g.Set("dspBassAnalyze", js.FuncOf(dspBassAnalyze))
	g.Set("dspGenerateBassWav", js.FuncOf(dspGenerateBassWav))
	select {}
}
