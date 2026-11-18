local LrApplication = import "LrApplication"
local LrDialogs = import "LrDialogs"
local LrErrors = import "LrErrors"
local LrExportSession = import "LrExportSession"
local LrFileUtils = import "LrFileUtils"
local LrLogger = import "LrLogger"
local LrPathUtils = import "LrPathUtils"
local LrProgressScope = import "LrProgressScope"

local logger = LrLogger("ColorFM_Lightroom_Test")
logger:enable("logfile")

local TestSupport = {}

local function log(message)
    logger:trace(message)
end

local function fail(message)
    log("FAIL: " .. message)
    LrErrors.throwUserError(message)
end

local function ensureDirectory(path)
    local ok, reason = LrFileUtils.createAllDirectories(path)
    if not ok then
        fail("无法创建测试目录: " .. tostring(reason or path))
    end
end

local function targetPhoto()
    local catalog = LrApplication.activeCatalog()
    local photo = catalog:getTargetPhoto()

    if not photo then
        fail("请先在 Lightroom 中选择一张照片。")
    end

    if photo:getRawMetadata("isVideo") then
        fail("ColorFM 导出测试只支持静态照片。")
    end

    if not photo:checkPhotoAvailability() then
        fail("当前照片的文件不可用或已移动。")
    end

    return catalog, photo
end

local function testRoot()
    local documents = LrPathUtils.getStandardFilePath("documents")
    return LrPathUtils.child(documents, "ColorFM-LR-Lightroom-Test")
end

local function timestamp()
    return os.date("%Y%m%d-%H%M%S")
end

local function exportSettings(destination)
    return {
        LR_format = "TIFF",
        LR_export_bitDepth = 16,
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

--- Export the current target photo as a 16-bit sRGB TIFF.
--- No engine or network call is made.
function TestSupport.exportCurrentPhoto()
    local _, photo = targetPhoto()
    local photoId = tostring(photo.localIdentifier or "photo")
    local runDirectory = LrPathUtils.child(
        testRoot(),
        "export-" .. timestamp() .. "-" .. photoId
    )

    ensureDirectory(runDirectory)
    log("Export destination: " .. runDirectory)

    local session = LrExportSession {
        photosToExport = { photo },
        exportSettings = exportSettings(runDirectory),
    }

    local exportedPaths = {}
    local failures = {}
    local total = session:countRenditions()
    local progress = LrProgressScope {
        title = "ColorFM 测试:导出 TIFF",
    }

    for index, rendition in session:renditions { stopIfCanceled = true } do
        local success, pathOrMessage = rendition:waitForRender()

        if success then
            exportedPaths[#exportedPaths + 1] = pathOrMessage
            log("Exported: " .. pathOrMessage)
        else
            failures[#failures + 1] = tostring(pathOrMessage)
            log("Export failed: " .. tostring(pathOrMessage))
        end

        progress:setPortionComplete(index, total)
    end

    progress:done()

    if #exportedPaths == 0 then
        local detail = #failures > 0
            and table.concat(failures, "\n")
            or "Lightroom 未返回导出文件路径。"
        fail("TIFF 导出失败。\n" .. detail)
    end

    return {
        paths = exportedPaths,
        failures = failures,
        directory = runDirectory,
        photo = photo,
    }
end

--- Import paths as new catalog photos. If stackWithPhoto is provided, the new
--- photo is placed below it. The original photo and its develop settings are
--- never modified.
function TestSupport.importPaths(paths, stackWithPhoto)
    local catalog = LrApplication.activeCatalog()
    local pending = {}
    local existing = {}

    for _, path in ipairs(paths) do
        local photo = catalog:findPhotoByPath(path)
        if photo then
            existing[#existing + 1] = path
        else
            pending[#pending + 1] = path
        end
    end

    local imported = {}
    if #pending > 0 then
        catalog:withWriteAccessDo(
            "ColorFM 测试:导入新照片",
            function()
                for _, path in ipairs(pending) do
                    local photo
                    if stackWithPhoto then
                        photo = catalog:addPhoto(path, stackWithPhoto, "below")
                    else
                        photo = catalog:addPhoto(path)
                    end
                    imported[#imported + 1] = photo
                    log("Imported: " .. path)
                end
            end,
            { timeout = 60 }
        )
    end

    return {
        imported = imported,
        existing = existing,
    }
end

function TestSupport.chooseTiffFiles()
    return LrDialogs.runOpenPanel {
        title = "选择要导入的 ColorFM/测试 TIFF",
        prompt = "选择一张或多张 TIFF",
        canChooseFiles = true,
        canChooseDirectories = false,
        allowsMultipleSelection = true,
        fileTypes = { "tif", "tiff" },
    }
end

function TestSupport.describeImportResult(result)
    local lines = {}

    if #result.imported > 0 then
        lines[#lines + 1] = string.format("新建并导入 %d 张照片。", #result.imported)
    end

    if #result.existing > 0 then
        lines[#lines + 1] = string.format("已存在 %d 张，未重复导入。", #result.existing)
    end

    return table.concat(lines, "\n")
end

return TestSupport
