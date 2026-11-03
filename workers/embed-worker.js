// Minimal C1 (pulled into Phase B): local sentence embeddings with all-MiniLM-L6-v2.
// Runs as a module worker inside the offscreen document (MV3 service workers can't spawn workers).
// See docs/phased-implementation-plan/phase-B-sectioning.md ("B2 — Centroid breakpoint detection").

import { pipeline, env } from "./vendor/transformers/transformers.min.js";

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const BATCH_SIZE = 32; // texts per inference call; bounds peak memory on long pages

const vendorDir = new URL("./vendor/transformers/", import.meta.url).href;

// Weights come from the Hugging Face hub on first use, then from the browser cache (master-spec §7.2).
env.allowLocalModels = false;
// Never the CDN default: MV3 forbids remote code. Plain CPU build, see workers/vendor/VENDORED.md.
env.backends.onnx.wasm.wasmPaths = {
  mjs: `${vendorDir}ort-wasm-simd-threaded.mjs`,
  wasm: `${vendorDir}ort-wasm-simd-threaded.wasm`,
};
// Extension pages aren't cross-origin isolated, so there's no SharedArrayBuffer for threads.
env.backends.onnx.wasm.numThreads = 1;
// The wasm cache pre-loads the ORT loader into a blob: URL and imports that, which the extension's
// script-src 'self' CSP blocks. Transformers.js only skips this when it sees the `chrome` global,
// which workers don't have. Caching local extension files gains nothing anyway.
env.useWasmCache = false;

let extractorPromise = null;

function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = pipeline("feature-extraction", MODEL_ID, { dtype: "q8", device: "wasm" }).catch((err) => {
      extractorPromise = null; // allow a retry, e.g. after a failed first download
      throw err;
    });
  }
  return extractorPromise;
}

self.onmessage = async ({ data: { id, texts } }) => {
  try {
    const coldStart = !extractorPromise;
    const t0 = performance.now();
    const extractor = await getExtractor();
    const t1 = performance.now();

    const vectors = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      // Mean pooling + L2 normalization: the standard sentence-embedding setup for this model,
      // giving 384-dim unit vectors so cosine similarity is a plain dot product.
      const output = await extractor(texts.slice(i, i + BATCH_SIZE), { pooling: "mean", normalize: true });
      vectors.push(...output.tolist());
    }

    self.postMessage({
      id,
      vectors,
      stats: { count: texts.length, msModelLoad: coldStart ? Math.round(t1 - t0) : 0, msEmbed: Math.round(performance.now() - t1) },
    });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message ?? err) });
  }
};
