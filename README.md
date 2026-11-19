# ColorFM-Lightroom

[简体中文](README-zh.md) | English

Colour-transfer engine for Lightroom: it turns "one content image + one reference
image" into 1248 grading parameters, bakes those parameters into a 3D LUT, and
applies the LUT to 16-bit TIFFs without touching their metadata.

Four parts, one process boundary:

| Part | Role |
|---|---|
| [`packages/core`](packages/core/README.md) | The maths: parameters, per-pixel MLP, LUT baking, TIFF/PNG/JPEG I/O, ONNX inference |
| [`packages/engine`](packages/engine/README.md) | The local HTTP service the other two talk to |
| [`apps/desktop`](apps/desktop/README.md) | macOS window (Tauri 2 + React 19): hosts the engine, shows the preview, writes the result back |
| [`hosts/lightroom`](hosts/lightroom/README.md) | Lightroom Classic plug-in (Lua): exports the TIFF, starts a session, imports the result |

## Where the library ends and the service begins

`packages/core` exports colour maths and **batch** primitives: bake a table,
apply it to a block of pixels, transform one band of rows, decode one image.
Every one of them returns when its own work is done; none of them starts a
thread, counts cores, splits a file, caches a table or retries.

`packages/engine` owns all of that: how many workers a render gets, where the
cuts go, which baked table is reused, how a failed band stops its siblings. The
plan is computed on the main thread and handed to the worker, so a worker only
executes the rows it was given.

`packages/core/src/index.ts` is the contract, and
`packages/core/test/public-surface.test.ts` pins it: adding an export means
editing that list.

## How the pieces are coupled

The window and the plug-in only speak HTTP to the engine, and neither
implements any colour maths. The contract is the envelope
(`{ok, schema_version, data, warnings, error}`) plus the routes under `/v1`. A
different engine that answers those routes correctly would need no frontend
change.

Three things sit *outside* HTTP, and a replacement engine has to match them too:

| Seam | What is expected |
|---|---|
| Discovery file | `<home>/engine.json` with `http_port`, `token`, `pid` — both clients read it from disk instead of being told a port |
| Filesystem paths | The engine returns absolute paths; the window loads them through the asset protocol, whose scope is `$DOCUMENT/ColorFM-LR/{tasks,cache,history}/**` |
| Process lifecycle | The plug-in launches the `.app` (`open -a ColorFM`); the `.app` starts the engine and leaves it running while a session is unfinished |

One more, only for the window: it reads `<home>/lightroom/sessions/*.json`
directly when pruning scratch exports, so the session record stays a plain JSON
file with `content_path` / `result_path` / `render_done`.

Replies must stay compact JSON: the plug-in parses them with a hand-written
scanner that looks for the literal `"id":"…"`. `host-contract.test.ts` replays
the replies through that scanner, so a pretty-printed response fails the suite
instead of silently breaking the import.

## Requirements

- Node.js 20 or newer (the code uses `node:worker_threads`, `fetch` and ESM).
- `sharp` (libvips) for PNG/JPEG/WebP/AVIF/HEIF; it ships prebuilt binaries, and
  TIFF does not need it.
- The `.onnx` model (123 MB) for inference; `npm run model:link` points
  `models/colorfm_l.onnx` at the checkpoint without copying it. Without the
  model the service still starts and reports `model_loaded: false`; everything
  that needs parameters fails with `E_MODEL_MISSING`.
- A Rust toolchain only for the desktop shell (`apps/desktop/src-tauri`).

## Quick start

```bash
npm install
npm run build                     # tsc project references → packages/*/dist

# local service on a system-assigned port, discovery file in ~/Library/Application Support/ColorFM-LR
node packages/engine/dist/main.js serve --port 0

# or with an explicit model and a throwaway home, which is what the tests do
COLORFM_HOME=/tmp/cf-home COLORFM_LIBRARY=/tmp/cf-lib \
  node packages/engine/dist/main.js serve --port 0 --model /path/to/colorfm_l.onnx
```

The engine writes `engine.json` (`{schema_version, pid, http_port, token}`) into
its home directory; every request needs `Authorization: Bearer <token>`.

## Commands

| Command | What it does |
|---|---|
| `npm run build` | Compile both packages and their declarations |
| `npm run clean` | Remove the compiled output and the incremental cache |
| `npm test` | Type-check sources and tests, then run the whole suite |
| `npm run typecheck` | `tsc -b` plus a no-emit pass over the test files |
| `npm run dev:serve` | Run the service from sources through `tsx` |
| `npm run colorfm -- --content a.tiff --style b.png --out c.tiff` | One-shot grading CLI |
| `npm run bake-lut -- params.txt out.cube 33` | Bake a `.cube` from 1248 floats |
| `npm run desktop:dev` | Build the engine, then Vite + the macOS window |
| `npm run desktop:build` | Same, packaged as `.app` |
| `npm run model:link` | Symlink the checkpoint into `models/` |
| `npm run bench:core` | Bake / lookup throughput, TypeScript side |
| `npm run bench:engine` | Whole session, timed end to end |
| `npm run desktop:web` | Frontend only, in a browser (no window APIs) |

`packages/*/dist` and `*.tsbuildinfo` are both generated and both ignored. Remove
them together (`npm run clean`): `tsc -b` trusts the cache file, so deleting
`dist/` alone leaves `npm run build` with nothing to do.

### Environment

| Variable | Meaning |
|---|---|
| `COLORFM_HOME` | Discovery file, settings and sessions (default `~/Library/Application Support/ColorFM-LR`) |
| `COLORFM_LIBRARY` | Task cache, previews and history (default `~/Documents/ColorFM-LR`) |
| `COLORFM_MODEL` | Path to the `.onnx` graph |
| `COLORFM_WORKERS` | Worker threads a render may use (default `cores - 1`, capped at 8) |

## Precision

The pipeline is defined in single precision, so every operation carries an
explicit `f32()` rounding rather than letting JavaScript's doubles drift. That
includes `expf`: the Swish activation divides by it on every hidden unit, and the
implementation reproduces the platform's `expf` from a `2^(k/128)` table and a
quadratic residual.

What that buys, checked by the test suite:

- the same parameters and the same input always produce the same LUT, `.cube`
  text, thumbnail and TIFF, run to run and machine to machine;
- 16-bit TIFF pixels round-trip exactly, and a JPEG is decoded once — the preview
  and the render see the same decode, so they cannot drift apart.

See [docs/performance.md](docs/performance.md) for measured throughput (32 MP
frame end to end in 1.5 s; a render in 0.73 s banded across cores).

## Layout

```
packages/core/src
  float32.ts        f32 rounding helpers and expf
  params.ts         the 1248-float kernel layout
  mlp.ts            the two residual MLPs, per point and per batch
  lut/              table type and blending, baking, lookup, .cube I/O
  io/               TIFF transform, thumbnails, previews; codec/ has the formats
  infer/            model input types and the ONNX backend
  color.ts          colour-management boundary (not ICC-aware yet)
  pipeline.ts       parameters → pixels, both paths
  bin/              the two command-line tools
packages/engine/src
  main.ts           CLI, lock, discovery file, idle watchdog
  api.ts            HTTP surface and the response envelope
  jobs.ts           job table; hands pixel work to worker.ts
  worker.ts         the arithmetic that must not block the HTTP thread
  session.ts        Lightroom session state machine and persistence
  store.ts          parameter cache (params.bin, thumbnails, previews)
  history.ts        filmstrip snapshots
  state.ts          shared application state
  events.ts         event-stream boundary (polling for now)
  project.ts        durable project boundary (parameter cache for now)
apps/desktop/src
  App.tsx           polls for a session, adopts it, owns the settings context
  Workspace.tsx     the three panels, zoom/pan, strength slider, filmstrip
  lib/engine.ts     typed HTTP client for the engine
apps/desktop/src-tauri
  src/main.rs       window, native menu, engine process lifecycle, macOS helpers
hosts/lightroom/colorfm.lrplugin
  Session.lua       the whole run: export, create a session, wait, import
  EngineClient.lua  discovery file, HTTP, starting the app
docs                testing notes
```

## Not implemented here

- ICC colour management (`packages/core/src/color`): profiles are carried through
  byte for byte but not interpreted.
- WebSocket progress events (`packages/engine/src/events.ts`): jobs are polled.
- A durable project model (`packages/engine/src/project.ts`): the parameter cache
  stands in for it.

## Licence

Released under [Creative Commons Attribution-NonCommercial-ShareAlike 4.0
International (CC BY-NC-SA 4.0)](LICENSE). You may share and adapt the work for
non-commercial purposes, provided you give appropriate credit, indicate any
changes, and release your adaptation under the same licence. Commercial use is
not granted by these terms.

© 2026 heyh31
