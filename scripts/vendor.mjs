// Downloads the vendored ONNX Runtime wasm binary (kept out of git: 14 MB) at the pinned version.
// Run once after cloning: `npm run vendor`. See workers/vendor/VENDORED.md.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ORT_VERSION = "1.31.0-dev.20260914-8d85527a0"; // must match workers/vendor/VENDORED.md
const FILE = "ort-wasm-simd-threaded.wasm";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dest = join(root, "workers", "vendor", "transformers", FILE);

if (existsSync(dest) && !process.argv.includes("--force")) {
  console.log(`${FILE} already present (use --force to re-download)`);
  process.exit(0);
}

// Downloaded packages are untrusted: unpack in a fresh temp dir, copy out only the one file.
// `npm pack` only downloads the tarball — it doesn't run install scripts.
const work = mkdtempSync(join(tmpdir(), "summarizer-vendor-"));
try {
  const tarball = execFileSync("npm", ["pack", `onnxruntime-web@${ORT_VERSION}`, "--silent"], { cwd: work, encoding: "utf8" }).trim();
  execFileSync("tar", ["xzf", tarball, `package/dist/${FILE}`], { cwd: work });
  copyFileSync(join(work, "package", "dist", FILE), dest);
  console.log(`vendored ${FILE} from onnxruntime-web@${ORT_VERSION}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
