-- Menu entry: 文件 > 增效工具额外信息 > ColorFM：检查引擎状态
--
-- Everything runs in a task: the actions dialog, export and the HTTP wait all
-- yield, and none of them may be wrapped in pcall (Lua 5.1 cannot yield across
-- a C call). Errors surface through LrErrors.throwUserError inside Session.lua,
-- which Lightroom shows with our own message text.

local LrTasks = import "LrTasks"

local Session = require "Session"

LrTasks.startAsyncTask(function()
    Session.diagnose()
end, "ColorFM: check engine")
