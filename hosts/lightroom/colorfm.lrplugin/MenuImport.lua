local LrDialogs = import "LrDialogs"
local LrTasks = import "LrTasks"
local TestSupport = require "TestSupport"

LrTasks.startAsyncTask(function()
    local paths = TestSupport.chooseTiffFiles()
    if not paths or #paths == 0 then
        return
    end

    local result = TestSupport.importPaths(paths)
    LrDialogs.message(
        "ColorFM:TIFF 导入完成",
        TestSupport.describeImportResult(result),
        "info"
    )
end, "ColorFM Lightroom import test")
