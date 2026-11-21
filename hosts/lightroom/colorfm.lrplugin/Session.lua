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
local Strings = require "Strings"

local Session = {}

local WAIT_POLLS = 60 * 30
local POLL_SECONDS = 1

local STATE_KEYS = {
    created = "state_created",
    waiting_for_ui = "state_waiting_for_ui",
    waiting_for_reference = "state_waiting_for_reference",
    previewing = "state_previewing",
    ready = "state_ready",
    rendering = "state_rendering",
    ready_to_import = "state_ready_to_import",
    imported = "state_imported",
    canceled = "state_canceled",
    error = "state_error",
}

function Session.stateText(state)
    local key = STATE_KEYS[state]
    return key and Strings.t(key) or tostring(state)
end

local function fail(message)
    LrErrors.throwUserError(message)
end

local function targetPhoto()
    local catalog = LrApplication.activeCatalog()
    local photo = catalog:getTargetPhoto()

    if not photo then
        fail(Strings.t("select_photo_first"))
    end
    if photo:getRawMetadata("isVideo") then
        fail(Strings.t("photos_only"))
    end
    if not photo:checkPhotoAvailability() then
        fail(Strings.t("file_missing"))
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
            return "canceled", nil, Strings.t("canceled_in_lr")
        end

        local snapshot, snapshotError = EngineClient.getSession(info, sessionId)
        if not snapshot then
            return "error", nil, snapshotError
        end

        if scope then
            scope:setCaption(Strings.t("status_caption", Session.stateText(snapshot.state)))
        end

        if snapshot.state == "ready_to_import" then
            return "ready_to_import", snapshot.resultPath, nil
        end
        if snapshot.state == "imported" then
            return "imported", snapshot.resultPath, nil
        end
        if snapshot.state == "error" then
            return "error", nil, snapshot.errorCode or Strings.t("engine_error")
        end
        if snapshot.state == "canceled" then
            return "canceled", nil, Strings.t("session_canceled")
        end

        LrTasks.sleep(POLL_SECONDS)
    end

    return "timeout", nil, Strings.t("timeout")
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
        return nil, Strings.t("no_result_path")
    end

    local catalog = LrApplication.activeCatalog()
    local imported

    catalog:withWriteAccessDo(
        Strings.t("import_title"),
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
        return nil, Strings.t("import_failed", tostring(resultPath))
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
    fail(Strings.t("process_failed", tostring(message)))
end

--- File > Plug-in Extras > ColorFM：处理当前照片…
function Session.processCurrentPhoto()
    local catalog, photo = targetPhoto()
    local sourcePath = photo:getRawMetadata("path")
    local photoName = photo:getFormattedMetadata("fileName")

    local exportScope = LrProgressScope { title = Strings.t("export_scope") }
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

    local scope = LrProgressScope { title = Strings.t("adjust_scope") }
    local state, resultPath, waitMessage = waitForWorkflow(info, sessionId, scope)
    scope:done()

    if state == "imported" then
        LrDialogs.message("ColorFM", Strings.t("already_imported"), "info")
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
        Strings.t("done_title"),
        Strings.t("done_body", tostring(resultPath)),
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
            Strings.t("engine_down_title"),
            Strings.t("engine_down_body", tostring(discoveryError), tostring(path)),
            "warning"
        )
        return
    end

    local body = EngineClient.request(info, "GET", "/v1/health")
    if not body then
        LrDialogs.message(
            Strings.t("engine_dead_title"),
            Strings.t("engine_dead_body", info.port, tostring(path)),
            "warning"
        )
        return
    end

    LrDialogs.message(
        Strings.t("engine_ready_title"),
        Strings.t(
            "engine_ready_body",
            info.port,
            tostring(info.pid),
            tostring(EngineClient.jsonString(body, "version")),
            EngineClient.jsonBool(body, "model_loaded") and Strings.t("yes") or Strings.t("no"),
            tostring(Strings.language()),
            tostring(path)
        ),
        "info"
    )
end

return Session
