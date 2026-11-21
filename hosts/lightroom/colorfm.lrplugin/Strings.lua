-- User-visible text for the plug-in, in whichever language Lightroom itself
-- runs in.
--
-- Why not ZStrings (`LOC "$$$/..."`) here: those need one key per string in a
-- TranslatedStrings file and lose `string.format` syntax (`%d`, `%s`) in favour
-- of `^1` placeholders. Runtime scripts are not limited like Info.lua is, so a
-- plain table keyed by name keeps the format strings readable and leaves the
-- `string.format` calls in the call sites untouched.
--
-- Keep the two tables in step: the same keys, and the same printf placeholders.

local LrLocalization = import "LrLocalization"

local ENGLISH = {
    -- Session states, shown in captions and dialogs
    state_created = "created",
    state_waiting_for_ui = "waiting for the app",
    state_waiting_for_reference = "waiting for a reference",
    state_previewing = "rendering the preview",
    state_ready = "waiting for confirmation",
    state_rendering = "writing back",
    state_ready_to_import = "ready to import",
    state_imported = "imported",
    state_canceled = "canceled",
    state_error = "error",


    -- Main flow
    select_photo_first = "Select a photo in Lightroom first.",
    photos_only = "ColorFM only handles still photos.",
    file_missing = "The photo's file is missing or has been moved.",
    canceled_in_lr = "canceled in Lightroom",
    status_caption = "Status: %s",
    engine_error = "The engine reported an error",
    session_canceled = "The session was canceled",
    timeout = "Timed out after 30 minutes. The session stays in the app, so you can finish it later.",
    no_result_path = "The engine returned no result path",
    import_title = "ColorFM: import the result TIFF",
    import_failed = "Lightroom could not add the result to the catalog: %s",
    process_failed = "ColorFM failed:\n\n%s",
    export_scope = "ColorFM: export a 16-bit sRGB TIFF",
    adjust_scope = "ColorFM: adjust in the app (you can cancel here)",
    already_imported = "These results have already been imported.",
    done_title = "ColorFM: done",
    done_body = "Imported as a new photo and stacked below the original.\n\nResult:\n%s\n\nThe original was not modified.",

    -- Engine status dialog
    engine_down_title = "ColorFM: the engine is not running",
    engine_down_body = "%s\n\nDiscovery file:\n%s\n\nRunning \"Process Current Photo\" in Lightroom starts the app for you.",
    engine_dead_title = "ColorFM: the engine is not responding",
    engine_dead_body = "The discovery file exists, but http://127.0.0.1:%d does not answer.\n\n%s\n\nQuit the ColorFM app and try again.",
    engine_ready_title = "ColorFM: the engine is ready",
    engine_ready_body = "Address: http://127.0.0.1:%d\nProcess: %s\nVersion: %s\nModel loaded: %s\n\nDiscovery file:\n%s",
    yes = "yes",
    no = "no",

    -- EngineClient
    discovery_missing = "Engine discovery file not found (the engine is not running)",
    discovery_unreadable = "Cannot read the engine discovery file: %s",
    discovery_malformed = "The engine discovery file is malformed",
    no_response = "The engine did not respond",
    transport_failed = "Cannot reach the engine: %s",
    launch_failed_head = "Cannot start the ColorFM-LR app.",
    launch_failed_installed = "- Installed: put ColorFM-LR.app in /Applications;",
    launch_failed_checkout = "- Source checkout: build once with `npm run desktop:build` (the plug-in finds apps/desktop/src-tauri/target/release/bundle/macos/ColorFM-LR.app by itself);",
    launch_failed_manual = "- Or open the app yourself and retry here (it is not launched again while the engine is up).",
    launch_timeout = "The app started, but the engine did not answer within 20 s. Check that it opened, then retry.",
    session_create_failed = "The engine refused to create the session: %s",
    session_no_id = "The engine returned no session id",
    session_read_failed = "Cannot read the session: %s",

    -- Exporter
    mkdir_failed = "Cannot create the export folder: %s",
    export_failed = "TIFF export failed: %s",
    export_missing = "The exported file does not exist: %s",
    lr_no_file = "Lightroom returned no file",

    -- SDK probe menus
    test_export_title = "ColorFM test: TIFF export",
    test_export_body = "Exported %d TIFF file(s).\n\n%s\n\nTest folder:\n%s",
    test_import_title = "ColorFM test: import new photos",
    test_roundtrip_title = "ColorFM test: export and import",
    test_roundtrip_body = "Export folder:\n%s\n\n%s\n\nThe result was imported as a new photo and stacked below the original; the original is untouched.",
    test_mkdir_failed = "Cannot create the test folder: %s",
    test_photos_only = "The ColorFM export test only handles still photos.",
    test_export_scope = "ColorFM test: export a TIFF",
    test_no_path = "Lightroom returned no exported file path.",
    test_export_failed = "TIFF export failed.\n%s",
    test_pick_title = "Choose ColorFM test TIFF files to import",
    test_pick_prompt = "Choose one or more TIFF files",
    test_imported_n = "Imported %d new photo(s).",
    test_existing_n = "%d already existed and were skipped.",
}

local CHINESE = {
    state_created = "已创建",
    state_waiting_for_ui = "等待桌面应用",
    state_waiting_for_reference = "请选择参考图",
    state_previewing = "正在生成预览",
    state_ready = "等待确认",
    state_rendering = "正在写回",
    state_ready_to_import = "可以导入",
    state_imported = "已导入",
    state_canceled = "已取消",
    state_error = "出错",


    select_photo_first = "请先在 Lightroom 中选择一张照片。",
    photos_only = "ColorFM 只处理静态照片。",
    file_missing = "当前照片的文件不可用或已移动。",
    canceled_in_lr = "已在 Lightroom 中取消",
    status_caption = "状态：%s",
    engine_error = "引擎返回错误",
    session_canceled = "会话已取消",
    timeout = "等待超时（30 分钟）。会话仍保留在桌面应用中，可以稍后继续。",
    no_result_path = "引擎没有返回结果路径",
    import_title = "ColorFM：导入结果 TIFF",
    import_failed = "Lightroom 未能把结果加入目录: %s",
    process_failed = "ColorFM 处理失败：\n\n%s",
    export_scope = "ColorFM：导出 16-bit sRGB TIFF",
    adjust_scope = "ColorFM：在桌面应用中调整（可在此取消）",
    already_imported = "这批结果已经导入过了。",
    done_title = "ColorFM：完成",
    done_body = "已作为新照片导入，并堆叠在原片下方。\n\n结果：\n%s\n\n原片没有被修改。",

    engine_down_title = "ColorFM：引擎未运行",
    engine_down_body = "%s\n\n发现文件：\n%s\n\n在 Lightroom 中执行「处理当前照片」会自动启动桌面应用。",
    engine_dead_title = "ColorFM：引擎无响应",
    engine_dead_body = "发现文件存在，但 http://127.0.0.1:%d 没有响应。\n\n%s\n\n请退出 ColorFM 桌面应用后重试。",
    engine_ready_title = "ColorFM：引擎就绪",
    engine_ready_body = "地址：http://127.0.0.1:%d\n进程：%s\n版本：%s\n模型已加载：%s\n\n发现文件：\n%s",
    yes = "是",
    no = "否",

    discovery_missing = "找不到引擎发现文件（引擎尚未启动）",
    discovery_unreadable = "无法读取引擎发现文件: %s",
    discovery_malformed = "引擎发现文件格式不正确",
    no_response = "引擎没有响应",
    transport_failed = "无法连接引擎: %s",
    launch_failed_head = "无法启动 ColorFM-LR 桌面应用。",
    launch_failed_installed = "・安装版：把 ColorFM-LR.app 放进 /Applications；",
    launch_failed_checkout = "・源码目录：先构建一次 `npm run desktop:build`（插件会自动找到 apps/desktop/src-tauri/target/release/bundle/macos/ColorFM-LR.app）；",
    launch_failed_manual = "・也可以先手动打开桌面应用，再回到 Lightroom 重试（引擎在跑时不会尝试拉起）。",
    launch_timeout = "已启动桌面应用，但引擎在 20 秒内没有响应。请在应用中确认它正常打开后重试。",
    session_create_failed = "引擎拒绝了会话创建: %s",
    session_no_id = "引擎没有返回会话 ID",
    session_read_failed = "无法读取会话: %s",

    mkdir_failed = "无法创建导出目录: %s",
    export_failed = "TIFF 导出失败: %s",
    export_missing = "导出文件不存在: %s",
    lr_no_file = "Lightroom 没有返回文件",

    test_export_title = "ColorFM 测试：TIFF 导出成功",
    test_export_body = "已导出 %d 张 TIFF。\n\n%s\n\n测试目录:\n%s",
    test_import_title = "ColorFM 测试：导入新照片",
    test_roundtrip_title = "ColorFM 测试：导出并导入成功",
    test_roundtrip_body = "导出目录:\n%s\n\n%s\n\n结果以新照片导入，并堆叠在原片下方；原片未修改。",
    test_mkdir_failed = "无法创建测试目录: %s",
    test_photos_only = "ColorFM 导出测试只支持静态照片。",
    test_export_scope = "ColorFM 测试：导出 TIFF",
    test_no_path = "Lightroom 未返回导出文件路径。",
    test_export_failed = "TIFF 导出失败。\n%s",
    test_pick_title = "选择要导入的 ColorFM 测试 TIFF",
    test_pick_prompt = "选择一张或多张 TIFF",
    test_imported_n = "新建并导入 %d 张照片。",
    test_existing_n = "已存在 %d 张，未重复导入。",
}

local Strings = {}

--- The two-letter code Lightroom is running in, e.g. "en" or "zh".
function Strings.language()
    return LrLocalization.currentLanguage()
end

--- True when Lightroom runs in Chinese, whatever it calls the locale.
--- `currentLanguage()` is documented as a two-letter code, but real installs have
--- been seen returning `zh_CN` and `zh-Hans`, so match the prefix.
function Strings.isChinese()
    local code = Strings.language()
    return type(code) == "string" and code:lower():sub(1, 2) == "zh"
end

--- Text for the current language. Extra arguments are passed to string.format.
function Strings.t(key, ...)
    local table_ = Strings.isChinese() and CHINESE or ENGLISH
    local text = table_[key] or ENGLISH[key] or key
    if select("#", ...) > 0 then
        return string.format(text, ...)
    end
    return text
end

return Strings
