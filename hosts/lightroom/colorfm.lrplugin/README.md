# ColorFM Lightroom plug-in

[简体中文](README-zh.md) | English

The Lightroom half of the ColorFM pipeline. It exports the selected photo as a
16-bit sRGB TIFF, creates a session in `colorfm-engine`, hands the workflow to
the Tauri window, waits, then imports the rendered TIFF as a new catalogue photo
stacked below the original. The original photo is never modified.

The plug-in performs **no color work and touches no pixels** — that boundary is
deliberate.

## Menu

Two menus, same commands — Lightroom decides which one by plug-in metadata key,
and it is easy to look in the wrong place:

| Where | What appears |
|---|---|
| **文件 > 增效工具额外信息**<br>(`LrExportMenuItems`) | 4 条正式命令 |
| **图库 > 增效工具额外功能**<br>(`LrLibraryMenuItems`) | 4 条正式命令 + 3 条 SDK 测试 |

```text
文件 > 增效工具额外信息 >
  ColorFM：处理当前照片…
  ColorFM：继续未完成会话…
  ColorFM：检查引擎状态
  ColorFM：设置桌面应用路径…
```

```text
图库 > 增效工具额外功能 >
  …（同上四条）…
  ColorFM 测试：导出当前照片 TIFF…
  ColorFM 测试：导入 TIFF 为新照片…
  ColorFM 测试：导出并堆叠导入…
```

`Info.lua` is read **once**, when Lightroom loads the plug-in. Editing it, or
adding/removing `.lua` files, requires quitting and reopening Lightroom before
the menu changes.

### If a menu entry fails

Expected failures (no photo selected, engine down, file moved) are raised with
`LrErrors.throwUserError` inside `Session.lua`, so Lightroom shows our own
message text. A bare "出现了内部错误 / Could not load script X.lua" means the
script could not be compiled or a module was missing, which in practice is:

- the file named in `Info.lua` is missing (names are case-sensitive);
- Lightroom is still running with an older plug-in build — restart it;
- the plug-in was added from a different directory than the one being edited
  (check the path in `文件 > 增效工具管理器`).

**Never wrap SDK calls in `pcall`.** Lightroom's plug-in runtime is coroutine
based: `LrHttp`, `LrDialogs`, `LrTasks.sleep` and the export loop all yield, and
Lua 5.1 cannot yield across a C call. The symptom is a dialog reading
`Yielding is not allowed within a C or metamethod call`, with no line number.
Handle failures by checking return values (`nil` + message), not with `pcall`.

## Install

1. Open Lightroom Classic.
2. Open `文件 > 增效工具管理器`.
3. Click `添加`.
4. Select this `colorfm.lrplugin` directory.
5. Confirm that "ColorFM" is enabled.

For local development, the plug-in can also be copied to:

```text
~/Library/Application Support/Adobe/Lightroom/Modules/ColorFM.lrplugin
```

Production installs copy it from the app bundle on first launch.

## The workflow

```text
1. 选中一张照片，执行「ColorFM：处理当前照片…」
2. 插件导出 16-bit sRGB TIFF 到 ~/Documents/ColorFM-LR/lightroom/export-<时间戳>/
3. 插件查找引擎；没有就启动桌面应用（应用启动后写入 engine.json）
4. 插件 POST /v1/lightroom/sessions
5. 桌面应用轮询到该会话并接管：选择参考图 → 预览 → 调强度 → 写回
6. 用户点「回到 Lightroom 并导入」→ 会话进入 ready_to_import
7. 插件导入结果并堆叠在原片下方，写入插件元数据，会话进入 imported
```

Lightroom 在等待期间显示可取消的进度面板；取消会同时取消引擎侧的会话。

### Engine discovery

The plug-in reads the discovery file the engine writes:

```text
~/Library/Application Support/ColorFM-LR/engine.json
```

It contains `pid`, `http_port` and the bearer `token` (0600). Every request
carries `Authorization: Bearer <token>`. A stale token triggers one re-read of
the file, so a restarted engine does not wedge the plug-in.

### Which app gets launched

Resolution order:

1. `ColorFM：设置桌面应用路径…` (stored in Lightroom plug-in preferences)
2. a source checkout: the plug-in walks up from its own location and looks for
   `apps/desktop/src-tauri/target/release/bundle/macos/ColorFM-LR.app`, then
   `apps/desktop/src-tauri/target/release/colorfm-desktop`
3. `open -a ColorFM-LR` (i.e. an app in `/Applications`)

The checkout branch is what makes a working copy usable without configuring
anything — after `npm run desktop:build` the plug-in finds the bundle on its
own. If the engine is already running (the app is open, or you
started it yourself), the plug-in never launches anything.

`os.getenv` does **not** exist in Lightroom's Lua sandbox, so `COLORFM_APP` is
only honoured on hosts that provide it; the path is probed before use.

## Modules

| File | Role |
|---|---|
| `EngineClient.lua` | discovery, HTTP, bearer token, scalar JSON reads |
| `Exporter.lua` | export settings and the export loop |
| `Session.lua` | the workflow the user sees: export → create → wait → import |
| `Menu*.lua` | menu entry points |
| `Info.lua` | SDK metadata and menu registration |
| `TestSupport.lua` | SDK probe kept from the verification stage |

`EngineClient.lua` deliberately ships no JSON library. It reads a handful of
scalar fields from documents this engine produced, and writes JSON with explicit
escaping. A full parser would be more code to audit, not more capability.

## What cannot be tested outside Lightroom

The Lua side has no test runner: Lightroom is the interpreter, and it is not
scriptable from a shell. Verification therefore has two layers:

- the **contract** is exercised against a real engine by
  `packages/engine/test/host-contract.test.ts`, which replays the same requests in
  the same order and parses the replies with this plug-in's own JSON scanner;
- the **plug-in glue** (export settings, `addPhoto`, stacking, progress scope)
  is exercised by the test menus, and by one manual run of the real flow.

## Verified locally

Lightroom Classic 15.1, through the SDK probes and the test menus:

- exported a `6960×4640` RGB TIFF at 16 bits per sample;
- confirmed the file exists at the path returned by `waitForRender()`;
- imported that TIFF as one new catalogue photo;
- stacked the imported TIFF below the original photo;
- confirmed that the source photo was not replaced.

With the packaged `.app`:

- export → `POST /v1/lightroom/sessions` → the window claims the session →
  preview → confirm → `ready_to_import`, the result written beside the original.

Not covered automatically: the import that follows `ready_to_import` in the same
run. The test menus cover the same `addPhoto` calls, not the hand-off around them.

## Notes

- Export is forced to 16-bit sRGB with no resize and no output sharpening while
  the ICC boundary in `colorfm-core` is a stub. A user preset with HDR or 8-bit
  output must not leak into the engine.
- **The result is written next to the original photo**, as
  `<stem>_ColorFM.tif` (e.g. `IMG_5399.CR3` → `IMG_5399_ColorFM.tif`), and the
  path is fixed when the session is created (`output_path`). Two reasons:
  Lightroom's stacking is folder-scoped (`stackInFolder*` in the SDK), so a
  result in another folder cannot be stacked under the original; and a sibling
  file keeps the original's capture context instead of sorting to the end of a
  capture-time view. When the folder is not writable the engine falls back to
  the export directory — the photo is then imported normally, without stacking.
- **Metadata is preserved**: for uncompressed sources (what this plug-in
  exports) the engine copies the file and only replaces the pixel bytes, so
  EXIF / IPTC / XMP / ICC survive — including `DateTimeOriginal`, which is what
  places the result next to the original in a capture-time sort. Compressed or
  tiled sources fall back to a re-encode and lose those tags; the render result
  reports `metadata_preserved` so this is visible instead of silent.
- `~/Documents/ColorFM-LR/lightroom/` is a cache. Exported base TIFFs can be
  deleted once the session is imported.
- Import is idempotent: the result path is looked up in the catalogue first, so
  a retry after a later failure never creates a duplicate photo. Stacking below
  the original is attempted first and degrades to a plain import when the
  original can no longer be resolved.

### Per-photo plug-in metadata (not implemented yet)

`photo:setPropertyForPlugin(_PLUGIN, key, value)` only accepts keys that are
declared in a custom metadata definition. Without one, Lightroom aborts with
`Attempt to access property "x" that's not declared in Info.lua` (see
`LrPhoto.lua` → `AgCustomMetadataRegistry`). The plug-in therefore does not
write per-photo properties today; provenance lives in the engine's session
record (`lightroom/sessions/<id>.json`).

To add it later:

1. a `CustomMetadataDefinition.lua` returning
   `{ metadataFieldsForPhotos = { { id = "...", title = "...", dataType = "string",
   searchable = true, browsable = true } }, schemaVersion = 1 }`;
2. `LrMetadataProvider = "CustomMetadataDefinition.lua"` in `Info.lua`;
3. only then call `setPropertyForPlugin` with those ids.
