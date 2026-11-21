local LrApplication = import "LrApplication"
local LrDialogs = import "LrDialogs"
local LrErrors = import "LrErrors"
local LrExportSession = import "LrExportSession"
local LrFileUtils = import "LrFileUtils"
local LrLogger = import "LrLogger"
local LrPathUtils = import "LrPathUtils"
local LrProgressScope = import "LrProgressScope"

local Strings = require "Strings"

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
        fail(Strings.t("test_mkdir_failed", tostring(reason or path)))
    end
end

local function targetPhoto()
    local catalog = LrApplication.activeCatalog()
    local photo = catalog:getTargetPhoto()

    if not photo then
        fail(Strings.t("select_photo_first"))
    end

    if photo:getRawMetadata("isVideo") then
        fail(Strings.t("test_photos_only"))
    end

    if not photo:checkPhotoAvailability() then
        fail(Strings.t("file_missing"))
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
        title = Strings.t("test_export_scope"),
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
            or Strings.t("test_no_path")
        fail(Strings.t("test_export_failed", detail))
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
            Strings.t("test_import_title"),
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
        title = Strings.t("test_pick_title"),
        prompt = Strings.t("test_pick_prompt"),
        canChooseFiles = true,
        canChooseDirectories = false,
        allowsMultipleSelection = true,
        fileTypes = { "tif", "tiff" },
    }
end

function TestSupport.describeImportResult(result)
    local lines = {}

    if #result.imported > 0 then
        lines[#lines + 1] = Strings.t("test_imported_n", #result.imported)
    end

    if #result.existing > 0 then
        lines[#lines + 1] = Strings.t("test_existing_n", #result.existing)
    end

    return table.concat(lines, "\n")
end

return TestSupport
