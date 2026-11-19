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
--
-- Info.lua is read once, when Lightroom loads the plug-in: after editing this
-- file (or adding scripts), restart Lightroom before expecting the menu to
-- change.

return {
    LrSdkVersion = 10.0,
    LrSdkMinimumVersion = 5.0,
    LrToolkitIdentifier = "com.colorfm.lightroom",
    LrPluginName = "ColorFM-LR",

    -- 文件 > 增效工具额外信息
    LrExportMenuItems = {
        {
            title = "ColorFM-LR：处理当前照片…",
            file = "MenuProcess.lua",
        },
        {
            title = "ColorFM-LR：继续未完成会话…",
            file = "MenuResume.lua",
        },
        {
            title = "ColorFM-LR：检查引擎状态",
            file = "MenuStatus.lua",
        },
        {
            title = "ColorFM-LR：设置桌面应用路径…",
            file = "MenuSetApp.lua",
        },
    },

    -- 图库 > 增效工具额外功能 (same commands, plus the SDK probes)
    LrLibraryMenuItems = {
        {
            title = "ColorFM-LR：处理当前照片…",
            file = "MenuProcess.lua",
        },
        {
            title = "ColorFM-LR：继续未完成会话…",
            file = "MenuResume.lua",
        },
        {
            title = "ColorFM-LR：检查引擎状态",
            file = "MenuStatus.lua",
        },
        {
            title = "ColorFM-LR：设置桌面应用路径…",
            file = "MenuSetApp.lua",
        },
        {
            title = "ColorFM-LR 测试：导出当前照片 TIFF…",
            file = "MenuExport.lua",
        },
        {
            title = "ColorFM-LR 测试：导入 TIFF 为新照片…",
            file = "MenuImport.lua",
        },
        {
            title = "ColorFM-LR 测试：导出并堆叠导入…",
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
