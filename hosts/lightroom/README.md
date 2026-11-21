# hosts/lightroom

[简体中文](README-zh.md) | English

The Lightroom Classic half of ColorFM: a Lua plug-in (`colorfm.lrplugin`) that exports,
hands over, and imports. It **touches no pixels** — all color work lives in the engine
, and the original photo is never modified.

## One full run

```
photo selected
  └─ export as 16-bit sRGB, uncompressed TIFF
       → ~/Documents/ColorFM-LR/lightroom/export-<YYYYmmdd-HHMMSS>/<original name>.tif
  └─ POST /v1/lightroom/sessions (contentPath, referencePath, outputPath, …)
  └─ bring the desktop window forward → the window claims the session
  └─ poll the session until ready_to_import / error / canceled
  └─ once ready_to_import:
       add the result TIFF to the catalogue, stacked below the original
       POST …/imported so the engine records a history snapshot
```

The result lands next to the original as `<stem>_ColorFM.tif` by default.

## Menus

The same commands hang off two places (Lightroom picks by plug-in metadata key, so it is
easy to look in the wrong spot):

| Where | What |
|---|---|
| **File > Plug-in Extras** (`LrExportMenuItems`) | the 2 real commands |
| **Library > Plug-in Extras** (`LrLibraryMenuItems`) | the 2 real commands + 3 SDK self-tests |

- Process Current Photo… — process the selected photo (`MenuProcess.lua`)
- Engine Status — engine status (`MenuStatus.lua`)

The titles are ZStrings (`LOC "$$$/ColorFM/MenuProcess=Process Current Photo…"`), with
Chinese supplied by `TranslatedStrings_zh.txt`. They follow **Lightroom's own UI language**,
not the system locale — and the dictionary is read at plug-in load, so restart Lightroom
after editing it.

Dialogs and progress captions take the other route: two tables in `Strings.lua`
(ENGLISH / CHINESE) read through `Strings.t("key", ...)`, chosen by
`LrLocalization.currentLanguage()` and keeping `string.format`'s `%s` / `%d`.
`host-contract.test.ts` pins the two tables together, so a missing translation fails the build.

## Files

| File | Responsibility |
|---|---|
| `Info.lua` | Plug-in metadata, both menus (titles are ZStrings), runtime version |
| `Strings.lua` | Every dialog and progress caption, in English or Chinese depending on `LrLocalization.currentLanguage()` |
| `Session.lua` | Main flow: export → create session → wait → import the result |
| `Exporter.lua` | Fixed export settings (16-bit, sRGB, no compression, no sharpening, no preset inheritance) |
| `EngineClient.lua` | Engine discovery (`engine.json`), HTTP, `LrPrefs`, launching the app |
| `Menu*.lua` | The four menu entry points |
| `TestSupport.lua` | Helpers used by the SDK self-test entries |

Deeper English notes live in [`colorfm.lrplugin/README.md`](colorfm.lrplugin/README.md),
including the export keys verified on Lightroom Classic 15.1.

## Installing (development)

```bash
ln -s "$PWD/hosts/lightroom/colorfm.lrplugin" \
      ~/Library/Application\ Support/Adobe/Lightroom/Modules/colorfm.lrplugin
```

Or use **File > Plug-in Manager > Add** and select the `colorfm.lrplugin` directory.
Lua changes need a Lightroom restart (modules load at startup).

## Constraints

- Export settings are hard-coded and never inherited from a preset: a stray HDR or 8-bit
  preset must not reach the engine.
- `setPropertyForPlugin` is deliberately unused (its keys must be declared in `Info.lua`
  first, and a missing declaration aborts the import). Provenance lives in the engine's
  session record instead.
- Import is idempotent: `catalog:findPhotoByPath` reuses an existing photo, so clicking
  twice cannot duplicate.
- A missing engine produces a clear message rather than a silent failure.

## Related

- [`../../packages/engine`](../../packages/engine/README.md): the HTTP service being called.
- [`../../apps/desktop`](../../apps/desktop/README.md): the window that is launched and does the write-back.
- [`../../packages/engine/test/host-contract.test.ts`](../../packages/engine/test/host-contract.test.ts):
  replays the replies through the plug-in's own JSON scanner, without opening Lightroom.
