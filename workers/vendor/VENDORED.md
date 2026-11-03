# Vendored files

MV3 forbids remotely hosted code, so these are copied in at pinned versions. Model weights are not vendored. They're downloaded on first use and cached (master-spec §7.2).

| File | Source | Version | License |
|---|---|---|---|
| `transformers/transformers.min.js` | npm `@huggingface/transformers`, `dist/transformers.min.js` (self-contained build with ONNX Runtime bundled) | 4.3.1 | Apache-2.0 (`transformers/LICENSE.transformers`) |
| `transformers/ort-wasm-simd-threaded.mjs` + `.wasm` | npm `onnxruntime-web`, `dist/` (the exact version Transformers.js 4.3.1 depends on) | 1.31.0-dev.20260914-8d85527a0 | MIT (the package ships no LICENSE file) |

The plain `ort-wasm-simd-threaded` build (14 MB, CPU only) is used instead of the `.asyncify` build Transformers.js v4 loads by default (27 MB, needed only for WebGPU). `workers/embed-worker.js` points `env.backends.onnx.wasm.wasmPaths` at it.

**The `.wasm` file is not in git** (14 MB; see `.gitignore`). After cloning, run `npm run vendor` to download it at the pinned version. `scripts/vendor.mjs` holds the same version number as the table above, so keep them in sync.

When upgrading, take both from matching versions: check `onnxruntime-web` in the new Transformers.js `package.json`.
