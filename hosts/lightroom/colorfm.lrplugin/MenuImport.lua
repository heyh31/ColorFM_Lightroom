local LrDialogs = import "LrDialogs"
local LrTasks = import "LrTasks"

local Strings = require "Strings"
local TestSupport = require "TestSupport"

LrTasks.startAsyncTask(function()
    local paths = TestSupport.chooseTiffFiles()
    if not paths or #paths == 0 then
        return
    end

    local result = TestSupport.importPaths(paths)
    LrDialogs.message(
        Strings.t("test_import_title"),
        TestSupport.describeImportResult(result),
        "info"
    )
end, "ColorFM Lightroom import test")
