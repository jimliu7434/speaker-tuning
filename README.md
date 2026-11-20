# Speaker Tuning — 網頁版音響皇帝位與 Toe-in 調校工具

純前端聲學量測與喇叭擺位輔助工具，採用 **Go WebAssembly (DSP 核心)** ＋ **AudioWorklet 收音執行緒** ＋ **Web Worker 運算執行緒** 雙 Worker 分離架構，可直接部署至 Cloudflare，透過手機瀏覽器麥克風即可進行量測。

## 功能特色

1. **標準雙聲道測試 WAV 生成與下載**：產生 48kHz / 16-bit 無損 Stereo WAV（左聲道上掃 Chirp、右聲道下掃 Chirp，1.6 秒週期循環），亦支援網頁直接播放。
2. **皇帝位（Sweet Spot）定位**：利用 FFT 互相關（Matched Filter）＋ 拋物線次樣本內插計算左右到達時間差（TDOA），精準換算左右偏移公分數與音量平衡（dB）。
3. **喇叭 Toe-in / Toe-out 建議**：比對左右聲道高頻指向帶（4k–12kHz）相對於中頻帶（400–2kHz）的能量比與直達聲清晰度，並提供「鎖定角度基準」即時觀察轉動喇叭後的高頻 ΔdB 變化。
4. **Phase 2 低頻駐波測試（30–320 Hz）**：內建同步前導音 ＋ 4 秒低頻掃頻 WAV、喇叭低頻下限設定（預設 40 Hz 適合 MBL 311 C4）、**抗手機麥克風低頻滾降（去趨勢模式）**，以及位置 A/B 快照疊圖對比。
5. **即時波型與擺位視覺化**：包含即時收音示波器、L/R 到達脈衝重疊波型圖、俯視皇帝位雷達圖與 30–320 Hz 低頻駐波曲線。

## 目錄架構

詳細設計與演算法請見 [SPEC.md](./SPEC.md)。

- `dsp/`：Go DSP 核心與單元測試（`signal/`、`cmd/wasm/`、`cmd/genwav/`）
- `web/`：前端原始碼（`workers/capture-worklet.js`、`workers/dsp-worker.js`、`js/`、`styles/`）
- `scripts/build.mjs`：一鍵編譯 Go WASM、CLI 與組裝 `dist/`
- `bin/`：封裝產出（`dsp.wasm`、`gen-test-wav.exe`、`speaker-tuning-test-48k.wav`）
- `dist/`：Cloudflare 靜態部署輸出目錄

## 建置與測試

> Windows 環境若使用 `fnm` 管理 Node.js，呼叫 `node` / `npx` 前需將 `$env:APPDATA\fnm\aliases\default` 加入 `PATH`。

```powershell
# 1. 執行 Go DSP 聲學單元測試
cd dsp
go test -v ./...

# 2. 編譯 Go WASM、CLI 並組裝 dist/ 與 bin/
cd ..
$env:PATH = "$env:APPDATA\fnm\aliases\default;" + $env:PATH
node scripts/build.mjs

# 3. 部署至 Cloudflare Workers Static Assets
npx wrangler deploy
```

## 手機使用注意事項

- 瀏覽器僅允許在 **HTTPS**（例如部署後的 Cloudflare 網址）下存取麥克風。
- 請使用手機原生瀏覽器（**iOS Safari / Android Chrome**）開啟，避免在 LINE / FB 等 App 內建瀏覽器中使用。
- 調整 Toe-in 時，請將手機固定於皇帝位朝向正前方，避免晃動影響高頻指向性讀值。
