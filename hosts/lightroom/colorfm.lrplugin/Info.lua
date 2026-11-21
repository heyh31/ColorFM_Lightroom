-- ColorFM-LR Lightroom plug-in.
--
-- Where the menu entries land (this trips people up):
--   LrExportMenuItems   -> 文件 > 增效工具额外信息   (File > Plug-in Extras)
--   LrLibraryMenuItems  -> 图库 > 增效工具额外功能   (Library > Plug-in Extras)
--
-- The real workflow lives in Session.lua: export a 16-bit sRGB TIFF, create a
-- session in colorfm-engine, hand off to the Tauri window, and import what it
-- renders. The "测试" entries are bare-SDK probes used to verify export /
-- addPhoto / stacking on Lightroom Classic 15.1 (see README).
--
-- Everything here is a literal table on purpose: Info.lua is parsed before any
-- plug-in code runs, and a runtime error in it takes the whole plug-in down.
-- The restricted loader still provides `LOC`, so titles are ZStrings: the value
-- after `=` is the English default, and TranslatedStrings_zh.txt supplies the
-- Chinese wording. Lightroom picks the dictionary by its own UI language.
--
-- Info.lua is read once, when Lightroom loads the plug-in: after editing this
-- file (or adding scripts), restart Lightroom before expecting the menu to
-- change.

return {
    LrSdkVersion = 10.0,
    LrSdkMinimumVersion = 5.0,
    LrToolkitIdentifier = "com.colorfm.lightroom",
    LrPluginName = LOC "$$$/ColorFM/PluginName=ColorFM-LR",

    -- 文件 > 增效工具额外信息
    LrExportMenuItems = {
        {
            title = LOC "$$$/ColorFM/MenuProcess=Process Current Photo…",
            file = "MenuProcess.lua",
        },
        {
            title = LOC "$$$/ColorFM/MenuStatus=Engine Status",
            file = "MenuStatus.lua",
        },
    },

    -- 图库 > 增效工具额外功能 (same commands, plus the SDK probes)
    LrLibraryMenuItems = {
        {
            title = LOC "$$$/ColorFM/MenuProcess=Process Current Photo…",
            file = "MenuProcess.lua",
        },
        {
            title = LOC "$$$/ColorFM/MenuStatus=Engine Status",
            file = "MenuStatus.lua",
        },
        {
            title = LOC "$$$/ColorFM/MenuTestExport=Test: Export Current Photo as TIFF…",
            file = "MenuExport.lua",
        },
        {
            title = LOC "$$$/ColorFM/MenuTestImport=Test: Import TIFF as New Photo…",
            file = "MenuImport.lua",
        },
        {
            title = LOC "$$$/ColorFM/MenuTestRoundTrip=Test: Export, Import and Stack…",
            file = "MenuRoundTrip.lua",
        },
    },

    VERSION = {
        major = 0,
        minor = 2,
        revision = 1,
        build = 1,
    },
}
