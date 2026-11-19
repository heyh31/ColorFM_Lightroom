/**
 * Builds the DMG without Tauri's `create-dmg` wrapper.
 *
 * `tauri build --bundles dmg` runs a shell script that mounts a read-write image,
 * arranges the window and converts it. On this machine that script fails while
 * hunting for its own temporary volume ("unable to proceed with final disk image
 * creation because the interstitial disk image was not found"), even with no
 * images mounted. This produces the part a user actually needs: the app and a
 * shortcut to /Applications.
 *
 * The `.app` must already be built and signed (`npm run desktop:build` does that,
 * or `tauri build --bundles app`).
 */

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = join(ROOT, "apps/desktop/src-tauri/target/release/bundle");
const APP = join(BUNDLE, "macos/ColorFM-LR.app");

const config = JSON.parse(readFileSync(join(ROOT, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"));
const product = config.productName ?? "ColorFM-LR";
const out = join(BUNDLE, "dmg", `${product}_${config.version}_${process.arch === "arm64" ? "aarch64" : "x64"}.dmg`);

if (!existsSync(APP)) {
  console.error(`make-dmg: ${APP} is missing — run \`tauri build --bundles app\` first`);
  process.exit(1);
}

const staging = mkdtempSync(join(tmpdir(), "colorfm-dmg-"));
try {
  cpSync(APP, join(staging, `${product}.app`), { recursive: true, verbatimSymlinks: true });
  // The drag target every macOS disk image has.
  symlinkSync("/Applications", join(staging, "Applications"));

  mkdirSync(dirname(out), { recursive: true });
  execFileSync("hdiutil", ["create", "-volname", product, "-srcfolder", staging, "-ov", "-format", "UDZO", out], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  console.log(`make-dmg: ${out} (${Math.round(statSync(out).size / 1e6)} MB)`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
