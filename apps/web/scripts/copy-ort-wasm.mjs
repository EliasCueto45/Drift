// Copies onnxruntime-web's WASM runtime into public/ort so the scene classifier loads it from
// this origin (no CDN at runtime). Runs before `next dev` and `next build`; output is gitignored.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "onnxruntime-web", "dist");
const out = join(root, "public", "ort");
mkdirSync(out, { recursive: true });
for (const file of ["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"]) {
  copyFileSync(join(src, file), join(out, file));
}
console.log("onnxruntime-web WASM copied to public/ort");
