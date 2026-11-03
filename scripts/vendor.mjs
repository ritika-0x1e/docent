// Downloads vendored third-party files that are kept out of git, at pinned versions.
// Run once after cloning: `npm run vendor`. See workers/vendor/VENDORED.md.
//   - ort-wasm-simd-threaded.wasm: 14 MB binary
//   - transformers.min.js: 586 KB minified build whose model-name strings trip GitHub secret scanning (false positive)

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Versions must match workers/vendor/VENDORED.md.
const FILES = [
  { pkg: "onnxruntime-web@1.31.0-dev.20260914-8d85527a0", from: "package/dist/ort-wasm-simd-threaded.wasm", to: "workers/vendor/transformers/ort-wasm-simd-threaded.wasm" },
  { pkg: "@huggingface/transformers@4.3.1", from: "package/dist/transformers.min.js", to: "workers/vendor/transformers/transformers.min.js" },
];

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const force = process.argv.includes("--force");

for (const { pkg, from, to } of FILES) {
  const dest = join(root, to);
  const name = to.split("/").pop();
  if (existsSync(dest) && !force) {
    console.log(`${name} already present (use --force to re-download)`);
    continue;
  }

  // Downloaded packages are untrusted: unpack in a fresh temp dir, copy out only the one file.
  // `npm pack` only downloads the tarball — it doesn't run install scripts.
  const work = mkdtempSync(join(tmpdir(), "summarizer-vendor-"));
  try {
    const tarball = execFileSync("npm", ["pack", pkg, "--silent"], { cwd: work, encoding: "utf8" }).trim();
    execFileSync("tar", ["xzf", tarball, from], { cwd: work });
    copyFileSync(join(work, from), dest);
    console.log(`vendored ${name} from ${pkg}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
