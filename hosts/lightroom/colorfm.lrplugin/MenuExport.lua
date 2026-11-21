local LrDialogs = import "LrDialogs"
local LrShell = import "LrShell"
local LrTasks = import "LrTasks"

local Strings = require "Strings"
local TestSupport = require "TestSupport"

LrTasks.startAsyncTask(function()
    local result = TestSupport.exportCurrentPhoto()

    LrDialogs.message(
        Strings.t("test_export_title"),
        Strings.t(
            "test_export_body",
            #result.paths,
            table.concat(result.paths, "\n"),
            result.directory
        ),
        "info"
    )

    LrShell.revealInShell(result.paths[1])
end, "ColorFM Lightroom export test")
