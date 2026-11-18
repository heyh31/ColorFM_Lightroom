local LrDialogs = import "LrDialogs"
local LrTasks = import "LrTasks"
local TestSupport = require "TestSupport"

LrTasks.startAsyncTask(function()
    local exported = TestSupport.exportCurrentPhoto()
    local imported = TestSupport.importPaths(exported.paths, exported.photo)

    LrDialogs.message(
        "ColorFM:导出并导入测试成功",
        string.format(
            "导出目录:\n%s\n\n%s\n\n结果以新照片导入，并堆叠在原片下方；原片未修改。",
            exported.directory,
            TestSupport.describeImportResult(imported)
        ),
        "info"
    )
end, "ColorFM Lightroom roundtrip test")
