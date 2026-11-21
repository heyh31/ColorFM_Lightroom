-- EngineClient.lua
--
-- The only place the plug-in talks to colorfm-engine (v0.md §5, §6). It reads
-- the discovery file the engine writes, sends the bearer token, and pulls a few
-- scalar fields out of the JSON envelope.
--
-- Why no JSON library: the plug-in never needs to understand arbitrary JSON.
-- It reads `state`, `id`, `result_path`, `error.code` and a handful of others
-- from documents this same engine produced. A tolerant scalar reader is smaller
-- and easier to audit than a bundled parser, and it cannot mangle the catalogue.
-- Every write is built by hand below, with explicit escaping.

local LrFileUtils = import "LrFileUtils"
local LrHttp = import "LrHttp"
local LrPathUtils = import "LrPathUtils"
local LrPrefs = import "LrPrefs"
local LrTasks = import "LrTasks"

local Strings = require "Strings"

local EngineClient = {}

local TIMEOUT_SECONDS = 8

--- ~/Library/Application Support/ColorFM-LR/engine.json
function EngineClient.discoveryPath()
    local home = LrPathUtils.getStandardFilePath("home")
    return LrPathUtils.child(home, "Library/Application Support/ColorFM-LR/engine.json")
end

-- --- JSON: read -------------------------------------------------------------

--- Finds the offset of the value for `key` (a top-level-ish key), skipping the
--- key when it appears as a value rather than a member name.
local function valueOffset(text, key)
    local needle = '"' .. key .. '"'
    local init = 1
    while true do
        local first, last = text:find(needle, init, true)
        if not first then
            return nil
        end

        local index = last + 1
        while index <= #text and text:sub(index, index):match("%s") do
            index = index + 1
        end

        if text:sub(index, index) == ":" then
            index = index + 1
            while index <= #text and text:sub(index, index):match("%s") do
                index = index + 1
            end
            return index
        end

        init = last + 1
    end
end

--- Reads a JSON string member. Returns nil when absent or not a string.
function EngineClient.jsonString(text, key)
    if type(text) ~= "string" then
        return nil
    end

    local start = valueOffset(text, key)
    if not start or text:sub(start, start) ~= '"' then
        return nil
    end

    local out = {}
    local index = start + 1
    while index <= #text do
        local char = text:sub(index, index)
        if char == "\\" then
            local nextChar = text:sub(index + 1, index + 1)
            if nextChar == "n" then
                out[#out + 1] = "\n"
            elseif nextChar == "t" then
                out[#out + 1] = "\t"
            elseif nextChar == "r" then
                out[#out + 1] = "\r"
            else
                -- \" \\ \/ and \uXXXX: the engine only ever escapes quotes and
                -- backslashes, and paths stay raw UTF-8.
                out[#out + 1] = nextChar
            end
            index = index + 2
        elseif char == '"' then
            return table.concat(out)
        else
            out[#out + 1] = char
            index = index + 1
        end
    end

    return nil
end

--- Reads a JSON number member.
function EngineClient.jsonNumber(text, key)
    local start = valueOffset(text, key)
    if not start then
        return nil
    end
    local raw = text:match("^-?%d+%.?%d*", start)
    if not raw then
        return nil
    end
    return tonumber(raw)
end

function EngineClient.jsonBool(text, key)
    local start = valueOffset(text, key)
    if not start then
        return nil
    end
    return text:sub(start, start + 3) == "true"
end

--- True when the envelope reports success.
function EngineClient.envelopeOk(text)
    return EngineClient.jsonBool(text, "ok") == true
end

--- Error code of a failed envelope, or nil.
function EngineClient.errorCode(text)
    local code = EngineClient.jsonString(text, "code")
    return code
end

-- --- JSON: write ------------------------------------------------------------

local function quote(value)
    local escaped = tostring(value):gsub('[\\"]', "\\%0")
    escaped = escaped:gsub("\n", "\\n"):gsub("\r", "\\r"):gsub("\t", "\\t")
    return '"' .. escaped .. '"'
end

local function number(value)
    if not value then
        return "null"
    end
    return string.format("%.4f", value)
end

--- Builds a flat JSON object from a table of pre-encoded fragments.
local function object(fields)
    local parts = {}
    for _, pair in ipairs(fields) do
        if pair[2] ~= nil then
            parts[#parts + 1] = quote(pair[1]) .. ":" .. pair[2]
        end
    end
    return "{" .. table.concat(parts, ",") .. "}"
end

EngineClient.object = object
EngineClient.quote = quote
EngineClient.number = number

-- --- discovery and transport -------------------------------------------------

--- Reads engine.json. Returns { port, token, pid } or nil plus a reason.
function EngineClient.readDiscovery()
    local path = EngineClient.discoveryPath()
    if LrFileUtils.exists(path) ~= "file" then
        return nil, Strings.t("discovery_missing")
    end

    local text, readError = LrFileUtils.readFile(path)
    if not text then
        return nil, Strings.t("discovery_unreadable", tostring(readError))
    end

    local port = EngineClient.jsonNumber(text, "http_port")
    local token = EngineClient.jsonString(text, "token")
    if not port or not token then
        return nil, Strings.t("discovery_malformed")
    end

    return {
        port = port,
        token = token,
        pid = EngineClient.jsonNumber(text, "pid"),
    }
end

local function headers(token)
    return {
        { field = "Authorization", value = "Bearer " .. token },
        { field = "Content-Type", value = "application/json" },
        { field = "Accept", value = "application/json" },
    }
end

local function urlFor(info, path)
    return string.format("http://127.0.0.1:%d%s", info.port, path)
end

local function httpCall(method, url, payload, requestHeaders)
    -- No pcall here on purpose: LrHttp yields the task while it waits, and Lua
    -- 5.1 refuses to yield across a C call ("Yielding is not allowed within a C
    -- or metamethod call"). A failed request comes back as nil plus a message.
    local body, detail
    if method == "GET" then
        body, detail = LrHttp.get(url, requestHeaders, TIMEOUT_SECONDS)
    else
        body, detail = LrHttp.post(url, payload, requestHeaders, TIMEOUT_SECONDS)
    end

    if type(body) ~= "string" then
        return nil, tostring(detail or Strings.t("no_response"))
    end
    return body, nil
end

--- Sends one request. Returns bodyText, or nil plus a message.
function EngineClient.request(info, method, path, payload)
    local body, transportError = httpCall(method, urlFor(info, path), payload, headers(info.token))
    if not body then
        return nil, Strings.t("transport_failed", tostring(transportError))
    end

    -- A stale token means a different engine instance owns the port now.
    if EngineClient.errorCode(body) == "E_UNAUTHORIZED" then
        local discovered = EngineClient.readDiscovery()
        if discovered and discovered.token ~= info.token then
            info.token = discovered.token
            info.port = discovered.port
            body, transportError = httpCall(method, urlFor(info, path), payload, headers(info.token))
            if not body then
                return nil, Strings.t("transport_failed", tostring(transportError))
            end
        end
    end

    return body, nil
end

--- GET /v1/health. Returns true when the engine answers with the capability the
--- plug-in needs.
function EngineClient.ping(info)
    if not info then
        return false
    end
    local body = EngineClient.request(info, "GET", "/v1/health")
    return body ~= nil and body:find("lightroom-sessions", 1, true) ~= nil
end

-- --- starting the desktop app ------------------------------------------------

local function shellQuote(value)
    return "'" .. tostring(value):gsub("'", "'\\''") .. "'"
end

--- Reads the per-plug-in preference table, or nil when the host does not
--- provide it. No pcall: this accessor must never yield, and a guarded call is
--- enough to keep a missing `LrPrefs` from breaking the workflow.
function EngineClient.prefs()
    if type(LrPrefs) ~= "table" then
        return nil
    end
    if type(LrPrefs.prefsForPlugin) ~= "function" then
        return nil
    end
    return LrPrefs.prefsForPlugin()
end

--- Dev convenience: when the plug-in lives inside a source checkout, the app
--- that checkout builds sits a few directories up. This keeps a working copy
--- usable without configuring a path first.
local function checkoutApp()
    if type(_PLUGIN) ~= "table" or type(_PLUGIN.path) ~= "string" then
        return nil
    end

    local candidates = {
        "apps/desktop/src-tauri/target/release/bundle/macos/ColorFM-LR.app",
        "apps/desktop/src-tauri/target/release/colorfm-desktop",
    }

    local root = _PLUGIN.path
    for _ = 1, 8 do
        root = LrPathUtils.parent(root)
        if not root or root == "" or root == "/" then
            return nil
        end
        for _, relative in ipairs(candidates) do
            local candidate = LrPathUtils.child(root, relative)
            if LrFileUtils.exists(candidate) then
                return candidate
            end
        end
    end

    return nil
end

function EngineClient.appPath()
    -- Lightroom's Lua sandbox removes parts of `os` (`os.getenv` is nil), so
    -- every global we reach for is probed before use.
    local prefs = EngineClient.prefs()
    if prefs then
        local configured = prefs.colorfmAppPath
        if configured and configured ~= "" and LrFileUtils.exists(configured) then
            return configured
        end
    end

    -- Kept for future hosts; on current builds this branch never runs.
    if type(os) == "table" and type(os.getenv) == "function" then
        local fromEnvironment = os.getenv("COLORFM_APP")
        if fromEnvironment and fromEnvironment ~= "" and LrFileUtils.exists(fromEnvironment) then
            return fromEnvironment
        end
    end

    return checkoutApp()
end

--- Brings the desktop app forward, starting it when needed.
--- A configured path may be a .app bundle (production) or a bare executable
--- (a dev build such as target/debug/colorfm-desktop).
function EngineClient.launchApp()
    local path = EngineClient.appPath()
    local command

    if path and path:sub(-4) == ".app" then
        -- `open <bundle>` activates a running instance and starts a stopped one.
        command = "open " .. shellQuote(path)
    elseif path then
        -- `open` would hand a bare binary to Terminal, so detach it ourselves.
        command = "nohup " .. shellQuote(path) .. " >/dev/null 2>&1 &"
    else
        command = "open -a ColorFM-LR"
    end

    local status = LrTasks.execute(command)
    return status == 0
end

--- Looks for a live engine, starting the app if necessary.
--- Returns info, or nil plus a message for the user.
function EngineClient.connect()
    local existing = EngineClient.readDiscovery()
    if existing and EngineClient.ping(existing) then
        return existing
    end

    if not EngineClient.launchApp() then
        return nil, table.concat({
            Strings.t("launch_failed_head"),
            "",
            Strings.t("launch_failed_installed"),
            Strings.t("launch_failed_checkout"),
            Strings.t("launch_failed_manual"),
        }, "\n")
    end

    -- Starting a WebView takes a few seconds; the engine writes engine.json
    -- before the window is ready, so discovery is the right signal.
    for _ = 1, 40 do
        LrTasks.sleep(0.5)
        local discovered = EngineClient.readDiscovery()
        if discovered and EngineClient.ping(discovered) then
            return discovered
        end
    end

    return nil, Strings.t("launch_timeout")
end

-- --- session API ------------------------------------------------------------

--- POST /v1/lightroom/sessions. Returns session id, or nil plus a message.
function EngineClient.createSession(info, options)
    local source = nil
    if options.catalogPath or options.photoUuid or options.photoName or options.rawPath then
        source = object({
            { "catalog_path", options.catalogPath and quote(options.catalogPath) },
            { "photo_uuid", options.photoUuid and quote(options.photoUuid) },
            { "photo_name", options.photoName and quote(options.photoName) },
            { "raw_path", options.rawPath and quote(options.rawPath) },
        })
    end

    local payload = object({
        { "content_path", quote(options.contentPath) },
        { "label", options.label and quote(options.label) },
        { "strength", options.strength and number(options.strength) },
        -- Where the result must be written. The plug-in aims this at the
        -- original photo's folder so the import can stack next to it.
        { "output_path", options.outputPath and quote(options.outputPath) },
        { "source", source },
    })

    local body, requestError = EngineClient.request(info, "POST", "/v1/lightroom/sessions", payload)
    if not body then
        return nil, requestError
    end
    if not EngineClient.envelopeOk(body) then
        return nil, Strings.t("session_create_failed", tostring(EngineClient.errorCode(body)))
    end

    local id = EngineClient.jsonString(body, "id")
    if not id then
        return nil, Strings.t("session_no_id")
    end
    return id
end

function EngineClient.getSession(info, sessionId)
    local body, requestError = EngineClient.request(
        info,
        "GET",
        "/v1/lightroom/sessions/" .. sessionId
    )
    if not body then
        return nil, requestError
    end
    if not EngineClient.envelopeOk(body) then
        return nil, Strings.t("session_read_failed", tostring(EngineClient.errorCode(body)))
    end
    return {
        id = EngineClient.jsonString(body, "id"),
        state = EngineClient.jsonString(body, "state"),
        resultPath = EngineClient.jsonString(body, "result_path"),
        errorCode = EngineClient.errorCode(body),
        label = EngineClient.jsonString(body, "label"),
        contentPath = EngineClient.jsonString(body, "content_path"),
        referencePath = EngineClient.jsonString(body, "reference_path"),
        rawPath = EngineClient.jsonString(body, "raw_path"),
        notice = EngineClient.jsonString(body, "notice"),
        strength = EngineClient.jsonNumber(body, "strength"),
    }
end

local function simplePost(info, sessionId, action)
    local body, requestError = EngineClient.request(
        info,
        "POST",
        "/v1/lightroom/sessions/" .. sessionId .. "/" .. action
    )
    if not body then
        return nil, requestError
    end
    if not EngineClient.envelopeOk(body) then
        return nil, tostring(EngineClient.errorCode(body))
    end
    return EngineClient.jsonString(body, "state")
end

function EngineClient.cancel(info, sessionId)
    return simplePost(info, sessionId, "cancel")
end

function EngineClient.markImported(info, sessionId)
    return simplePost(info, sessionId, "imported")
end

return EngineClient
