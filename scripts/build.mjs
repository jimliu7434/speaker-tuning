import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const dspDir = path.join(rootDir, 'dsp');
const webDir = path.join(rootDir, 'web');
const binDir = path.join(rootDir, 'bin');
const distDir = path.join(rootDir, 'dist');
const distWasmDir = path.join(distDir, 'wasm');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyDir(src, dst) {
  ensureDir(dst);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDir(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

console.log('[1/5] Preparing output directories...');
ensureDir(binDir);
fs.rmSync(distDir, { recursive: true, force: true });
ensureDir(distWasmDir);

console.log('[2/5] Building Go WASM (bin/dsp.wasm)...');
const wasmOut = path.join(binDir, 'dsp.wasm');
execFileSync('go', ['build', '-ldflags=-s -w', '-o', wasmOut, './cmd/wasm'], {
  cwd: dspDir,
  stdio: 'inherit',
  env: {
    ...process.env,
    GOOS: 'js',
    GOARCH: 'wasm',
  },
});

console.log('[3/5] Building Go CLI WAV generator (bin/gen-test-wav.exe)...');
const cliOut = path.join(binDir, process.platform === 'win32' ? 'gen-test-wav.exe' : 'gen-test-wav');
execFileSync('go', ['build', '-ldflags=-s -w', '-o', cliOut, './cmd/genwav'], {
  cwd: dspDir,
  stdio: 'inherit',
});

console.log('[4/5] Generating default test WAVs (sweetspot + bass)...');
const wavOut = path.join(binDir, 'speaker-tuning-test-48k.wav');
execFileSync(cliOut, ['-mode', 'sweetspot', '-out', wavOut, '-rate', '48000', '-loops', '15'], {
  cwd: rootDir,
  stdio: 'inherit',
});
const bassWavOut = path.join(binDir, 'speaker-tuning-bass-48k.wav');
execFileSync(cliOut, ['-mode', 'bass', '-out', bassWavOut, '-rate', '48000', '-loops', '6'], {
  cwd: rootDir,
  stdio: 'inherit',
});

console.log('[5/5] Assembling dist/ for Cloudflare deployment...');
copyDir(webDir, distDir);
fs.copyFileSync(wasmOut, path.join(distWasmDir, 'dsp.wasm'));

const goRoot = execFileSync('go', ['env', 'GOROOT'], { encoding: 'utf8' }).trim();
const wasmExecCandidates = [
  path.join(goRoot, 'lib', 'wasm', 'wasm_exec.js'),
  path.join(goRoot, 'misc', 'wasm', 'wasm_exec.js'),
];
const wasmExecSrc = wasmExecCandidates.find((p) => fs.existsSync(p));
if (!wasmExecSrc) {
  throw new Error(`Could not find wasm_exec.js under GOROOT (${goRoot})`);
}
fs.copyFileSync(wasmExecSrc, path.join(distWasmDir, 'wasm_exec.js'));

const wasmSizeKb = (fs.statSync(wasmOut).size / 1024).toFixed(1);
console.log(`Build complete! dsp.wasm = ${wasmSizeKb} KB, static site ready in dist/`);
