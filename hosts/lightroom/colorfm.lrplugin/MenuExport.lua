local LrDialogs = import "LrDialogs"
local LrShell = import "LrShell"
local LrTasks = import "LrTasks"
local TestSupport = require "TestSupport"

LrTasks.startAsyncTask(function()
    local result = TestSupport.exportCurrentPhoto()

    LrDialogs.message(
        "ColorFM:TIFF 导出成功",
        string.format(
            "已导出 %d 张 TIFF。\n\n%s\n\n测试目录:\n%s",
            #result.paths,
            table.concat(result.paths, "\n"),
            result.directory
        ),
        "info"
    )

    LrShell.revealInShell(result.paths[1])
end, "ColorFM Lightroom export test")
