# apps/desktop

[简体中文](README-zh.md) | English

The macOS window (Tauri 2 + React 19 + Vite 7). It is **the only interactive surface** and
also the engine's host: at launch it starts `packages/engine/dist/main.js` with the Node
already on the machine, hands the port and token to the webview, and reaps the process on exit.

No image work happens here — previews, renders and thumbnails all come from the engine's
HTTP API.

## Layout

```
src/                      # frontend (React + TypeScript)
  App.tsx                 # session polling, adopt/hand-back, settings context, ⌘,
  Workspace.tsx           # three panels, zoom/pan, strength slider, filmstrip
  SettingsSheet.tsx       # settings sheet (language / output / storage / about)
  icons.tsx               # inline SVG icons
  lib/engine.ts           # engine HTTP client and error-code translation
  lib/i18n.ts             # zh/en dictionaries (flat keys + {placeholders}); a missing key shows itself
  lib/settings.ts         # settings type plus read/write through Rust
  styles.css              # all styling (macOS tokens; the canvas color is --canvas)

src-tauri/
  src/main.rs             # window, native menu, engine process lifecycle, system commands
  src/settings.rs         # settings.json read/write and defaults
  tauri.conf.json         # window 1200×800 (min 900×620, resizable), model resource
  capabilities/default.json
```

## Frontend ↔ Rust

Two channels only:

1. **HTTP** (`lib/engine.ts`) — every business operation: sessions, jobs, history, preview images.
2. **`invoke`** (Tauri commands) — system capabilities:

| Command | Purpose |
|---|---|
| `engine_info` / `start_engine` | Read/spawn the engine (Node); returns port and token |
| `pick_reference` / `pick_folder` | Native image / folder pickers |
| `load_settings` / `save_settings` | Read and persist `settings.json` |
| `data_dir` | Data directory for "Reveal in Finder" |
| `cleanup_exports` | Remove `lightroom/export-*` folders still unreferenced |
| `delete_exported_file` | Delete a session's intermediate TIFF after write-back |
| `reveal_in_finder` / `activate_lightroom` | Reveal a file, bring Lightroom forward |

## Settings

Stored in `~/Library/Application Support/ColorFM-LR/settings.json`, applied immediately:

- `language`: `auto` / `zh-Hans` / `en`
- `outputMode` + `outputFolder`: beside the original (default) or a fixed folder
- `deleteExportAfterWriteBack`: defaults to `true`; deletes the 16-bit export once the result exists
- `window`: last window size, restored on launch (fullscreen/maximised is not recorded)

Reachable from the native menu (`ColorFM-LR > Settings…`, ⌘,) and the slider icon in the toolbar.

## Build

From the repository root:

```bash
npm install
npm run model:link       # models/colorfm_l.onnx → the checkpoint (no 118 MB copy)
npm run desktop:dev      # tsc -b for the engine, then Vite + the window
npm run desktop:build    # same, packaged as .app
```

`beforeDevCommand` / `beforeBuildCommand` already run `npm --prefix ../.. run build`, so the
window always starts the engine built from the current sources.

`beforeDevCommand` also runs `scripts/check-port.mjs 1420` first. Vite's port is fixed at 1420
(`strictPort`), and a dev window killed hard can leave an orphan holding it; `tauri dev` then
only prints `Port 1420 is already in use` without saying which process. The preflight prints
the PID and a ready-to-paste `kill` command, then exits.

The window looks for the engine in this order: `$COLORFM_ENGINE` (an executable),
`.app/Contents/MacOS/colorfm-engine`, `$COLORFM_ENGINE_ENTRY`,
`.app/Contents/Resources/engine/main.js`, then this checkout's
`packages/engine/dist/main.js`. When it finds a `.js` it also needs Node: `$COLORFM_NODE`,
`PATH`, then `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `~/.volta/bin`,
`~/.local/bin`. A process started by Finder inherits almost no `PATH`, which is why the
list is explicit.

**Packaging note**: the `.app` currently carries the window and the model; the engine runs as
a Node script, so the target machine needs Node. A self-contained build would copy
`packages/engine/dist`, `packages/core/dist` and the production dependencies into
`Contents/Resources/engine/` next to a Node runtime (or a single-executable build). That is
remaining work; it does not affect the one-command development flow.

## Interaction rules

- Images start at "fit"; double-click toggles fit ⇄ 1:1 (a badge shows the percentage); pinch
  or ⌘+wheel zooms around the pointer; drag pans once zoomed.
- Switching photos (new session or another history entry) resets the zoom.
- After a successful write-back the strength slider and "replace reference" lock, because the
  source TIFF is scratch at that point.
- In the `error` state the write-back button stays enabled so a failed render can be retried.

## Related

- [`../../packages/engine`](../../packages/engine/README.md): the HTTP service being hosted.
- [`../../hosts/lightroom`](../../hosts/lightroom/README.md): who starts a session.
- [`../../packages/engine/test/host-contract.test.ts`](../../packages/engine/test/host-contract.test.ts):
  checks the wire fields using the plug-in's own JSON scanner.
