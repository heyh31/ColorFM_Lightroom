/**
 * Points `models/colorfm_l.onnx` at the checkpoint without copying 118 MB into
 * this repository.
 *
 * The source is `COLORFM_MODEL`, defaulting to `models/colorfm_l.onnx` in a
 * sibling directory. The symlink makes `models/` work for `tauri build`, which
 * copies the file into the app bundle instead of following it at run time.
 */

import { existsSync, mkdirSync, symlinkSync, copyFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "models", "colorfm_l.onnx");
const sources = [process.env.COLORFM_MODEL, join(root, "models", "colorfm_l.onnx.src")].filter(
  (path) => typeof path === "string" && path.length > 0,
);

mkdirSync(join(root, "models"), { recursive: true });

if (existsSync(target)) {
  console.log(`models/colorfm_l.onnx already present (${Math.round(statSync(target).size / 1e6)} MB)`);
  process.exit(0);
}

const source = sources.find((path) => existsSync(path));
if (!source) {
  console.error("no checkpoint found; set COLORFM_MODEL to the .onnx file");
  process.exit(1);
}

try {
  symlinkSync(source, target);
  console.log(`linked models/colorfm_l.onnx -> ${source}`);
} catch (error) {
  // A copy keeps the build working where symlinks are refused (some network
  // volumes); it costs 118 MB, which is why it is the fallback.
  copyFileSync(source, target);
  const reason = error instanceof Error ? error.message : String(error);
  console.log(`copied ${source} to models/colorfm_l.onnx (${reason})`);
}
