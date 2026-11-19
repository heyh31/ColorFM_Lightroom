/**
 * Stages the engine for the app bundle.
 *
 * The `.app` is a Rust shell that spawns `node main.js serve`, so a release has
 * to carry three things the user's machine cannot be assumed to have: a Node
 * runtime, the engine's own JavaScript, and the two native addons it loads
 * (onnxruntime for the model, sharp for the codecs).
 *
 * Output: `build/engine/`, laid out so `node main.js` runs from that directory
 * with no `node_modules` above it:
 *
 *   build/engine/main.js            the engine, with its sibling workers
 *   build/engine/node               the runtime
 *   build/engine/node_modules/      @colorfm/core + the addons
 *
 * Only the host platform's binaries are copied; onnxruntime ships every OS in
 * one package, and 206 MB of the 293 MB is for platforms this build cannot run
 * on.
 */

import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "build/engine");

function log(message) {
  process.stdout.write(`package-engine: ${message}\n`);
}

/**
 * Creates the staging directory without emptying it.
 *
 * Everything below is copied with overwrite semantics, and the contents are
 * derived from files that only ever gain or change names between releases, so
 * reusing the directory is both faster and safer than deleting a 220 MB tree
 * before every build.
 */
function ensure(path) {
  mkdirSync(path, { recursive: true });
}

/** Copies the compiled JavaScript of a package, leaving declarations behind. */
function copyJs(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDirectory()) {
      copyJs(src, dst);
      continue;
    }
    // Source maps and `.d.ts` files are development aids; they are a third of
    // the bytes and nothing reads them at run time.
    if (entry.name.endsWith(".d.ts") || entry.name.endsWith(".d.ts.map") || entry.name.endsWith(".js.map")) {
      continue;
    }
    copyFileSync(src, dst);
  }
}

/** Copies a dependency, optionally pruning subtrees that are platform-specific. */
function copyDep(name, { keep } = {}) {
  const from = join(ROOT, "node_modules", name);
  const to = join(OUT, "node_modules", name);
  if (!existsSync(from)) throw new Error(`missing dependency: ${name}`);
  cpSync(from, to, { recursive: true, dereference: true, filter: keep ? (src) => keep(relative(from, src)) : undefined });
  return to;
}

ensure(OUT);

// --- the engine itself ------------------------------------------------------
const enginePkg = JSON.parse(readFileSync(join(ROOT, "packages/engine/package.json"), "utf8"));
copyJs(join(ROOT, "packages/engine/dist"), OUT);
writeFileSync(
  join(OUT, "package.json"),
  `${JSON.stringify({ name: "colorfm-engine-bundle", private: true, type: enginePkg.type ?? "module" }, null, 2)}\n`,
);

// --- the library it imports ------------------------------------------------
const coreTo = join(OUT, "node_modules/@colorfm/core");
mkdirSync(coreTo, { recursive: true });
copyFileSync(join(ROOT, "packages/core/package.json"), join(coreTo, "package.json"));
copyJs(join(ROOT, "packages/core/dist"), join(coreTo, "dist"));

// --- native addons ---------------------------------------------------------
// onnxruntime: keep the binding and the dylibs for this OS/arch only.
const arch = process.arch;
const platform = process.platform;
const nativeBin = `bin/napi-v6/${platform}/${arch}`;
copyDep("onnxruntime-node", {
  // Keep the wanted subtree *and its ancestors*: filtering a directory out
  // stops the walk before the files under it are ever considered.
  keep: (path) => !path.startsWith("bin") || path === nativeBin || nativeBin.startsWith(`${path}/`) || path.startsWith(`${nativeBin}/`),
});

// The bindings' own runtime dependencies: onnxruntime-node is a thin wrapper
// around onnxruntime-common, and sharp needs a libc probe and a semver parser.
for (const name of ["onnxruntime-common", "adm-zip", "global-agent"]) {
  if (existsSync(join(ROOT, "node_modules", name))) copyDep(name);
}

// sharp and the libvips build it loads.
for (const name of [
  "sharp",
  "detect-libc",
  "semver",
  "@img/color",
  `@img/sharp-${platform}-${arch}`,
  `@img/sharp-libvips-${platform}-${arch}`,
]) {
  if (existsSync(join(ROOT, "node_modules", name))) copyDep(name);
}

// --- the runtime -----------------------------------------------------------
copyFileSync(process.execPath, join(OUT, "node"));
chmodSync(join(OUT, "node"), 0o755);

const size = (path) => {
  const stats = statSync(path);
  if (!stats.isDirectory()) return stats.size;
  return readdirSync(path).reduce((sum, name) => sum + size(join(path, name)), 0);
};
log(`${OUT} (${Math.round(size(OUT) / 1e6)} MB, ${platform}/${arch})`);
