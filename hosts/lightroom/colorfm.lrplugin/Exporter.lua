-- Exporter.lua
--
-- Turns the selected photo into the base TIFF the engine reads (v0.md §7.3).
-- Settings are explicit and never inherited from a user preset: a stray HDR or
-- 8-bit preset must not silently reach the engine.
--
-- The keys below are the ones verified in Lightroom Classic 15.1 by
-- TestSupport.lua (see README "Tested locally").

local LrExportSession = import "LrExportSession"
local LrFileUtils = import "LrFileUtils"
local LrPathUtils = import "LrPathUtils"

local Exporter = {}

--- ~/Documents/ColorFM-LR/lightroom
function Exporter.workRoot()
    local documents = LrPathUtils.getStandardFilePath("documents")
    return LrPathUtils.child(documents, "ColorFM-LR/lightroom")
end

local function settings(destination)
    return {
        LR_format = "TIFF",
        LR_export_bitDepth = 16,
        -- Hard-coded until the ICC boundary in colorfm-core lands (§9, §15.1).
        LR_export_colorSpace = "sRGB",
        LR_tiff_compressionMethod = "compressionMethod_None",
        LR_export_destinationType = "specificFolder",
        LR_export_destinationPathPrefix = destination,
        LR_export_useSubfolder = false,
        LR_size_doConstrain = false,
        LR_size_doNotEnlarge = true,
        LR_outputSharpeningOn = false,
        LR_reimportExportedPhoto = false,
        LR_collisionHandling = "overwrite",
    }
end

local function ensureDirectory(path)
    local ok, reason = LrFileUtils.createAllDirectories(path)
    if not ok then
        return nil, "无法创建导出目录: " .. tostring(reason or path)
    end
    return true
end

--- Exports one photo as a 16-bit sRGB TIFF.
--- Returns { path = "...", directory = "..." } or nil plus a message.
function Exporter.exportBase(photo, progressScope)
    local name = photo:getFormattedMetadata("fileName") or "photo"
    local directory = LrPathUtils.child(
        Exporter.workRoot(),
        "export-" .. os.date("%Y%m%d-%H%M%S")
    )

    local created, createError = ensureDirectory(directory)
    if not created then
        return nil, createError
    end

    local session = LrExportSession {
        photosToExport = { photo },
        exportSettings = settings(directory),
    }

    local total = session:countRenditions()
    local exportedPath
    local failure

    for index, rendition in session:renditions { stopIfCanceled = true } do
        local success, pathOrMessage = rendition:waitForRender()
        if success then
            exportedPath = exportedPath or pathOrMessage
        else
            failure = tostring(pathOrMessage)
        end
        if progressScope then
            progressScope:setPortionComplete(index, total)
        end
    end

    if not exportedPath then
        return nil, "TIFF 导出失败: " .. tostring(failure or "Lightroom 没有返回文件")
    end

    if LrFileUtils.exists(exportedPath) ~= "file" then
        return nil, "导出文件不存在: " .. tostring(exportedPath)
    end

    return {
        path = exportedPath,
        directory = directory,
        label = tostring(name),
    }
end

return Exporter
