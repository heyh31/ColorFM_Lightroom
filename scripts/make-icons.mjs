/**
 * Turns the chosen 1024 px master into the icon set the desktop app uses.
 *
 * `icon-master-1024.png` is the source of truth: edit that file (or regenerate
 * it from `tmp/icon-v6.mjs` during design work) and run `npm run icons`.
 *
 * macOS wants an `.iconset` with specific names and then `iconutil`; Tauri also
 * reads the loose PNGs listed in `tauri.conf.json`. The Android/iOS trees that
 * `tauri icon` also emits are not used by this project, so they are not produced
 * here.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, copyFileSync } from "node:fs";
import { join } from "node:path";

import sharp from "sharp";

const MASTER = "apps/desktop/src-tauri/icons/icon-master-1024.png";
const ICONSET = "apps/desktop/src-tauri/icons/ColorFM-LR.iconset";
const OUT = "apps/desktop/src-tauri/icons";

/** name → pixel size. The @2x entries are the same pixel sizes, different names. */
const SIZES = [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024],
];

rmSync(ICONSET, { recursive: true, force: true });
mkdirSync(ICONSET, { recursive: true });

for (const [name, size] of SIZES) {
  await sharp(MASTER).resize(size, size, { kernel: "lanczos3" }).png().toFile(join(ICONSET, name));
}

// .icns from the iconset; macOS only, which is fine for a .app bundle.
execFileSync("iconutil", ["-c", "icns", ICONSET, "-o", join(OUT, "icon.icns")]);

// The loose files Tauri reads directly.
await sharp(MASTER).resize(32, 32).png().toFile(join(OUT, "32x32.png"));
await sharp(MASTER).resize(128, 128).png().toFile(join(OUT, "128x128.png"));
await sharp(MASTER).resize(256, 256).png().toFile(join(OUT, "128x128@2x.png"));
await sharp(MASTER).resize(512, 512).png().toFile(join(OUT, "icon.png"));

// Windows keeps its .ico, which sharp cannot write; it is unused by this build
// but listed in the config, so leaving the old one is better than a missing file.
copyFileSync(MASTER, join(OUT, "icon-master-1024.png"));

rmSync(ICONSET, { recursive: true, force: true });
console.log("icons written to", OUT);
