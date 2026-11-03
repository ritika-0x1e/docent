# Vendored files

MV3 forbids remotely hosted code, so these are copied in at pinned versions. Model weights are not vendored. They're downloaded on first use and cached (master-spec §7.2).

| File | Source | Version | License |
|---|---|---|---|
| `transformers/transformers.min.js` | npm `@huggingface/transformers`, `dist/transformers.min.js` (self-contained build with ONNX Runtime bundled) | 4.3.1 | Apache-2.0 (`transformers/LICENSE.transformers`) |
| `../../background/vendor/idb.js` | npm `idb`, `build/umd.js` (classic-script build, sets a global `idb`, so `importScripts` can load it) | 8.0.4 | ISC (`background/vendor/LICENSE.idb`) |
| `transformers/ort-wasm-simd-threaded.mjs` + `.wasm` | npm `onnxruntime-web`, `dist/` (the exact version Transformers.js 4.3.1 depends on) | 1.31.0-dev.20260914-8d85527a0 | MIT (the package ships no LICENSE file) |

The plain `ort-wasm-simd-threaded` build (14 MB, CPU only) is used instead of the `.asyncify` build Transformers.js v4 loads by default (27 MB, needed only for WebGPU). `workers/embed-worker.js` points `env.backends.onnx.wasm.wasmPaths` at it.

**`transformers.min.js` and the `.wasm` file are not in git** (see `.gitignore`). After cloning, run `npm run vendor` to download both at their pinned versions. The extension won't embed anything until you do. `scripts/vendor.mjs` holds the same version numbers as the table above, so keep them in sync.
- The `.wasm` is 14 MB.
- `transformers.min.js` is kept out because GitHub's secret scanning reports a "Mistral AI API key" in it (2026-11-03). It's a false positive: the match is a 32-character model class name / gist id in the minified code. The file is byte-identical to the npm release.

When upgrading, take both from matching versions: check `onnxruntime-web` in the new Transformers.js `package.json`.
