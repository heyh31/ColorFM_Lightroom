-- Session.lua
--
-- The Lightroom side of the serial workflow (v0.md §6.5, §7.3). It exports,
-- creates a session, waits, imports. It never chooses a reference image and
-- never touches pixels: that is the Tauri window's job, by design.

local LrApplication = import "LrApplication"
local LrDialogs = import "LrDialogs"
local LrErrors = import "LrErrors"
local LrFileUtils = import "LrFileUtils"
local LrPathUtils = import "LrPathUtils"
local LrProgressScope = import "LrProgressScope"
local LrShell = import "LrShell"
local LrTasks = import "LrTasks"

local EngineClient = require "EngineClient"
local Exporter = require "Exporter"

local Session = {}

local WAIT_POLLS = 60 * 30
local POLL_SECONDS = 1

local STATE_TEXT = {
    created = "已创建",
    waiting_for_ui = "等待桌面应用",
    waiting_for_reference = "请选择参考图",
    previewing = "正在生成预览",
    ready = "等待确认",
    rendering = "正在写回",
    ready_to_import = "可以导入",
    imported = "已导入",
    canceled = "已取消",
    error = "出错",
}

function Session.stateText(state)
    return STATE_TEXT[state] or tostring(state)
end

local function fail(message)
    LrErrors.throwUserError(message)
end

local function targetPhoto()
    local catalog = LrApplication.activeCatalog()
    local photo = catalog:getTargetPhoto()

    if not photo then
        fail("请先在 Lightroom 中选择一张照片。")
    end
    if photo:getRawMetadata("isVideo") then
        fail("ColorFM 只处理静态照片。")
    end
    if not photo:checkPhotoAvailability() then
        fail("当前照片的文件不可用或已移动。")
    end

    return catalog, photo
end

--- Polls the engine until the user is done in the Tauri window.
--- Counts polls instead of reading the clock: `os.time` is not guaranteed to be
--- in Lightroom's sandbox, and a poll counter cannot fail.
--- Returns state, resultPath (only for ready_to_import), message.
local function waitForWorkflow(info, sessionId, scope)
    for _ = 1, WAIT_POLLS do
        if scope and scope:isCanceled() then
            EngineClient.cancel(info, sessionId)
            return "canceled", nil, "已在 Lightroom 中取消"
        end

        local snapshot, snapshotError = EngineClient.getSession(info, sessionId)
        if not snapshot then
            return "error", nil, snapshotError
        end

        if scope then
            scope:setCaption("状态：" .. Session.stateText(snapshot.state))
        end

        if snapshot.state == "ready_to_import" then
            return "ready_to_import", snapshot.resultPath, nil
        end
        if snapshot.state == "imported" then
            return "imported", snapshot.resultPath, nil
        end
        if snapshot.state == "error" then
            return "error", nil, snapshot.errorCode or "引擎返回错误"
        end
        if snapshot.state == "canceled" then
            return "canceled", nil, "会话已取消"
        end

        LrTasks.sleep(POLL_SECONDS)
    end

    return "timeout", nil, "等待超时（30 分钟）。会话仍保留在桌面应用中，可以稍后继续。"
end

--- Adds the result as a new catalogue photo, stacked below the original.
---
--- Idempotent on purpose: a previous attempt may have added the photo and then
--- failed later in the workflow, and clicking again must not create a duplicate.
---
--- Per-photo plug-in properties (`setPropertyForPlugin`) are deliberately not
--- used: their keys must be declared through a custom metadata definition, and
--- a missing declaration aborts the import with
--- `Attempt to access property "x" that's not declared in Info.lua`.
--- Provenance lives in the engine's session record instead (v0.md §11).
local function importResult(info, sessionId, resultPath, originalPhoto)
    if not resultPath then
        return nil, "引擎没有返回结果路径"
    end

    local catalog = LrApplication.activeCatalog()
    local imported

    catalog:withWriteAccessDo(
        "ColorFM：导入结果 TIFF",
        function()
            local existing = catalog:findPhotoByPath(resultPath)
            if existing then
                imported = existing
            else
                -- Prefer stacking below the original; fall back to a plain add
                -- when the original is no longer resolvable (moved photo,
                -- resumed session from another catalogue).
                if originalPhoto then
                    imported = catalog:addPhoto(resultPath, originalPhoto, "below")
                end
                if not imported then
                    imported = catalog:addPhoto(resultPath)
                end
            end
        end,
        { timeout = 60 }
    )

    if not imported then
        return nil, "Lightroom 未能把结果加入目录: " .. tostring(resultPath)
    end

    EngineClient.markImported(info, sessionId)
    return imported
end

--- Picks the result path next to the original photo.
---
--- Two reasons this location matters:
---   * Lightroom can only stack a photo under another one in the same folder,
---     and the design asks for the result to sit below the original;
---   * a file in that folder shares the original's capture context, so it does
---     not end up at the end of a capture-time sort.
--- Returns nil when the folder is not writable, in which case the engine falls
--- back to writing beside the exported base TIFF.
local function resultPathNextToSource(sourcePath, photoName)
    if not sourcePath or sourcePath == "" then
        return nil
    end

    local directory = LrPathUtils.parent(sourcePath)
    if not directory or directory == "" or directory == "/" then
        return nil
    end

    if type(LrFileUtils.isWritable) == "function" and not LrFileUtils.isWritable(directory) then
        return nil
    end

    local leaf = photoName or LrPathUtils.leafName(sourcePath)
    local stem = leaf:match("^(.*)%.[^%.]+$") or leaf
    return LrPathUtils.child(directory, stem .. "_ColorFM.tif")
end

local function reportFailure(message)
    fail("ColorFM 处理失败：\n\n" .. tostring(message))
end

--- File > Plug-in Extras > ColorFM：处理当前照片…
function Session.processCurrentPhoto()
    local catalog, photo = targetPhoto()
    local sourcePath = photo:getRawMetadata("path")
    local photoName = photo:getFormattedMetadata("fileName")

    local exportScope = LrProgressScope { title = "ColorFM：导出 16-bit sRGB TIFF" }
    local exported, exportError = Exporter.exportBase(photo, exportScope)
    exportScope:done()

    if not exported then
        reportFailure(exportError)
    end

    local info, connectError = EngineClient.connect()
    if not info then
        reportFailure(connectError)
    end

    local sessionId, createError = EngineClient.createSession(info, {
        contentPath = exported.path,
        label = photoName or exported.label,
        strength = 1.0,
        outputPath = resultPathNextToSource(sourcePath, photoName),
        catalogPath = catalog:getPath(),
        photoUuid = tostring(photo.localIdentifier or ""),
        photoName = photoName,
        rawPath = sourcePath,
    })
    if not sessionId then
        reportFailure(createError)
    end

    -- Bringing the window forward is the hand-off: the window polls the engine,
    -- sees this session, and claims it.
    EngineClient.launchApp()

    local scope = LrProgressScope { title = "ColorFM：在桌面应用中调整（可在此取消）" }
    local state, resultPath, waitMessage = waitForWorkflow(info, sessionId, scope)
    scope:done()

    if state == "imported" then
        LrDialogs.message("ColorFM", "这批结果已经导入过了。", "info")
        return
    end
    if state ~= "ready_to_import" then
        reportFailure(waitMessage or state)
    end

    local imported, importError = importResult(
        info,
        sessionId,
        resultPath,
        photo
    )
    if not imported then
        reportFailure(importError)
    end

    LrDialogs.message(
        "ColorFM：完成",
        string.format(
            "已作为新照片导入，并堆叠在原片下方。\n\n结果：\n%s\n\n原片没有被修改。",
            tostring(resultPath)
        ),
        "info"
    )
    LrShell.revealInShell(resultPath)
end

--- File > Plug-in Extras > ColorFM：继续未完成会话…
function Session.resume()
    local info, connectError = EngineClient.connect()
    if not info then
        reportFailure(connectError)
    end

    local sessions, listError = EngineClient.listSessions(info)
    if not sessions then
        reportFailure(listError)
    end
    if #sessions == 0 then
        LrDialogs.message("ColorFM", "没有未完成的会话。", "info")
        return
    end

    local target = sessions[1]
    local snapshot = EngineClient.getSession(info, target.id)

    -- LrDialogs.confirm takes positional arguments: (message, info, style).
    local proceed = LrDialogs.confirm(
        "继续这个未完成的会话吗？",
        string.format(
            "最近一个会话：\n%s\n状态：%s",
            tostring(target.label or target.id),
            Session.stateText(target.state)
        ),
        { actionVerb = "继续" }
    )
    if proceed ~= "ok" then
        return
    end

    EngineClient.launchApp()

    local scope = LrProgressScope { title = "ColorFM：等待桌面应用完成" }
    local state, resultPath, waitMessage = waitForWorkflow(info, target.id, scope)
    scope:done()

    if state == "imported" then
        LrDialogs.message("ColorFM", "这个会话的结果已经在目录中。", "info")
        return
    end
    if state ~= "ready_to_import" then
        reportFailure(waitMessage or state)
    end

    local catalog = LrApplication.activeCatalog()
    local original
    if snapshot and snapshot.rawPath then
        original = catalog:findPhotoByPath(snapshot.rawPath)
    end

    local imported, importError = importResult(
        info,
        target.id,
        resultPath,
        original
    )
    if not imported then
        reportFailure(importError)
    end

    LrDialogs.message(
        "ColorFM：完成",
        "已导入结果：\n" .. tostring(resultPath),
        "info"
    )
    LrShell.revealInShell(resultPath)
end

--- File > Plug-in Extras > ColorFM：检查引擎状态
function Session.diagnose()
    local path = EngineClient.discoveryPath()
    local info, discoveryError = EngineClient.readDiscovery()

    if not info then
        LrDialogs.message(
            "ColorFM：引擎未运行",
            string.format(
                "%s\n\n发现文件：\n%s\n\n在 Lightroom 中执行「处理当前照片」会自动启动桌面应用。",
                tostring(discoveryError),
                tostring(path)
            ),
            "warning"
        )
        return
    end

    local body = EngineClient.request(info, "GET", "/v1/health")
    if not body then
        LrDialogs.message(
            "ColorFM：引擎无响应",
            string.format(
                "发现文件存在，但 http://127.0.0.1:%d 没有响应。\n\n%s\n\n请退出 ColorFM 桌面应用后重试。",
                info.port,
                tostring(path)
            ),
            "warning"
        )
        return
    end

    LrDialogs.message(
        "ColorFM：引擎就绪",
        string.format(
            "地址：http://127.0.0.1:%d\n进程：%s\n版本：%s\n模型已加载：%s\n\n发现文件：\n%s",
            info.port,
            tostring(info.pid),
            tostring(EngineClient.jsonString(body, "version")),
            EngineClient.jsonBool(body, "model_loaded") and "是" or "否",
            tostring(path)
        ),
        "info"
    )
end

--- File > Plug-in Extras > ColorFM：设置桌面应用路径…
function Session.configureAppPath()
    local props = { path = EngineClient.appPath() or "" }

    local result = LrDialogs.presentModalDialog {
        title = "ColorFM：桌面应用路径",
        contents = {
            {
                title = "ColorFM-LR.app 的完整路径（留空则使用 /Applications 中的 ColorFM-LR）",
                bind_to_object = props,
                property = "path",
            },
        },
        actionVerb = "保存",
    }

    if result ~= "ok" then
        return
    end

    local prefs = EngineClient.prefs()
    if not prefs then
        fail("Lightroom 没有提供插件偏好设置接口，无法保存应用路径。\n请改用 /Applications 中的 ColorFM。")
    end

    prefs.colorfmAppPath = props.path
    LrDialogs.message(
        "ColorFM",
        props.path == "" and "已恢复为默认路径。" or ("已保存：\n" .. props.path),
        "info"
    )
end

return Session
