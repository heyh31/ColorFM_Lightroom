local LrDialogs = import "LrDialogs"
local LrTasks = import "LrTasks"

local Strings = require "Strings"
local TestSupport = require "TestSupport"

LrTasks.startAsyncTask(function()
    local exported = TestSupport.exportCurrentPhoto()
    local imported = TestSupport.importPaths(exported.paths, exported.photo)

    LrDialogs.message(
        Strings.t("test_roundtrip_title"),
        Strings.t(
            "test_roundtrip_body",
            exported.directory,
            TestSupport.describeImportResult(imported)
        ),
        "info"
    )
end, "ColorFM Lightroom roundtrip test")
