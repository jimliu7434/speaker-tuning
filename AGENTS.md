# AGENTS.md — Speaker Tuning 專案開發指南

## 專案概述
本專案為純前端聲學量測與喇叭調校工具（皇帝位定位 + Toe-in / Toe-out 建議），由 **Go WebAssembly (DSP 核心)** 與 **原生 HTML/CSS/JS 前端（AudioWorklet + Web Worker 雙執行緒分離）** 組成，部署於 Cloudflare。

## 關鍵規範與環境
1. **工具鏈**：
   - Go：`C:\Program Files\Go\bin\go.exe`（`wasm_exec.js` 位於 `$(go env GOROOT)/lib/wasm/wasm_exec.js`）
   - Node.js / npm / npx / wrangler：透過 fnm 管理，執行前需將 `C:\Users\e988l\AppData\Roaming\fnm\aliases\default` 加入 `PATH`。
2. **文件與封裝同步**：
   - 任何演算法、通訊協定或目錄變動，必須同步更新 `SPEC.md` 與 `README.md`。
   - 封裝產出物（編譯後的 `dsp.wasm`、`gen-test-wav.exe` 與標準測試音 `speaker-tuning-test.wav`）統一輸出至 `bin/`，網站靜態檔案輸出至 `dist/`。
3. **執行緒邊界（不可違反）**：
   - `web/workers/capture-worklet.js` 僅負責收音緩衝與透過 `MessageChannel` 轉傳 `Float32Array`，嚴禁在 AudioWorklet 內做 FFT 或重運算。
   - 所有 DSP 運算與 WAV 生成皆在 `web/workers/dsp-worker.js` 內的 Go WASM 執行。
4. **音訊前處理**：
   - `getUserMedia` 必須明確關閉 `echoCancellation: false`、`noiseSuppression: false`、`autoGainControl: false`。

## 常用指令
- 執行 DSP 單元測試：`cd dsp && go test ./...`
- 建置 WASM、CLI 與前端 `dist/`：`node scripts/build.mjs`
- 部署至 Cloudflare：`npx wrangler deploy`
