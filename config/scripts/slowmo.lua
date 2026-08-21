-- ============================================================
-- SlowmoPlayer
--   * 24fps slow-motion conform toggle
--   * full-quality frame export to <player>/Exports
--   * custom clickable control bar (replaces mpv's OSC)
--   * fps-tiered accent colour, activity log, state persistence
-- ============================================================

local assdraw = require 'mp.assdraw'
local utils = require 'mp.utils'

-- ============================================================
-- Paths / state file
-- ============================================================

local function project_root()
    local cd = mp.get_property("config-dir") or ""
    return (cd:gsub("[\\/][^\\/]+$", ""))
end

local ROOT = nil
local function root()
    if not ROOT then ROOT = project_root() end
    return ROOT
end

local function export_dir() return root() .. "\\Exports" end
local function state_path() return root() .. "\\state_player.json" end

local function json_escape(s)
    return (s:gsub('[%c\\"]', function(c)
        local map = { ['\\'] = '\\\\', ['"'] = '\\"', ['\n'] = '\\n', ['\r'] = '\\r', ['\t'] = '\\t' }
        return map[c] or string.format('\\u%04x', c:byte())
    end))
end

-- ============================================================
-- Activity log: routed to the control panel's textbox when it's
-- open, otherwise shown as an on-video OSD message.
-- ============================================================

local panel_open, panel_last_seen = false, 0
local log_seq, log_lines = 0, {}

local hide_overlay_on_panel = nil -- set below, once render() exists

mp.observe_property("user-data/slowmo/panel_open", "bool", function(_, v)
    panel_open = v == true
    if panel_open then
        panel_last_seen = mp.get_time()
        if hide_overlay_on_panel then hide_overlay_on_panel() end
    end
end)

local function is_panel_open()
    if not panel_open then return false end
    if mp.get_time() - panel_last_seen > 3.0 then panel_open = false end
    return panel_open
end

local function emit(text, duration)
    log_seq = log_seq + 1
    local stamp = os.date("%H:%M:%S")
    table.insert(log_lines, { seq = log_seq, text = stamp .. "  " .. text:gsub("\n", " | ") })
    while #log_lines > 60 do table.remove(log_lines, 1) end

    local parts = {}
    for _, l in ipairs(log_lines) do
        parts[#parts + 1] = string.format('{"seq":%d,"text":"%s"}', l.seq, json_escape(l.text))
    end
    mp.set_property("user-data/slowmo/log", "[" .. table.concat(parts, ",") .. "]")

    if not is_panel_open() then mp.osd_message(text, duration or 2) end
end

-- ============================================================
-- Slow-motion conform
-- ============================================================

local slowmo_active, source_fps = false, nil

local function detect_fps()
    source_fps = mp.get_property_number("container-fps")
        or mp.get_property_number("estimated-vf-fps")
    return source_fps
end

-- Settings live in mpv user-data so the control panel can change them
-- live over IPC; these are the fallbacks when it hasn't set them.
local function setting(name, default)
    local v = mp.get_property("user-data/slowmo/set_" .. name)
    if v == nil or v == "" then return default end
    return v
end

local function setting_num(name, default)
    return tonumber(setting(name, nil)) or default
end

local function target_fps()
    local t = setting_num("target_fps", 24)
    if t < 1 then t = 1 end
    return t
end

local function slowmo_toggle()
    local fps = source_fps or detect_fps()
    local tgt = target_fps()
    if not fps or fps <= tgt + 0.5 then
        emit(string.format("Source is %s fps - already at/below %g fps target",
            fps and string.format("%.2f", fps) or "unknown", tgt), 2)
        return
    end
    if slowmo_active then
        mp.set_property("speed", 1.0)
        slowmo_active = false
        emit("Slow-mo OFF - normal speed", 1.5)
    else
        mp.set_property("speed", tgt / fps)
        slowmo_active = true
        emit(string.format("Slow-mo ON - %.2f fps to %g fps (%.1fx slower)", fps, tgt, fps / tgt), 2.5)
    end
end

-- ============================================================
-- Frame export -> <player>\Exports
-- ============================================================

local exports_ready = false
local function ensure_exports()
    if exports_ready then return end
    mp.command_native({
        name = "subprocess", playback_only = false,
        args = { "cmd", "/c", "if not exist \"" .. export_dir() .. "\" mkdir \"" .. export_dir() .. "\"" },
    })
    exports_ready = true
end

local function export_frame()
    local path = mp.get_property("path")
    if not path then emit("No file loaded", 1.5) return end

    local dir = setting("export_dir", nil)
    if dir == nil or dir == "" then dir = export_dir(); ensure_exports() end
    local fmt = setting("export_format", "png")
    local scale = setting_num("export_scale", 100)

    local filename = path:match("([^\\/]+)$") or path
    local base = filename:gsub("%.[^.]+$", "")
    local frame_num = mp.get_property_number("estimated-frame-number") or 0
    local t = mp.get_property_number("time-pos") or 0
    local tc = string.format("%02d.%02d.%02d.%03d",
        math.floor(t / 3600), math.floor((t % 3600) / 60), math.floor(t % 60),
        math.floor((t - math.floor(t)) * 1000))

    -- Resolution / crop are applied by temporarily adding a filter: the
    -- screenshot is taken from the filtered frame, so what you export is
    -- exactly what the settings ask for rather than a post-hoc resize.
    local temp_vf = nil
    if scale ~= 100 and scale > 0 then
        temp_vf = string.format("scale=iw*%f:ih*%f", scale / 100, scale / 100)
        mp.commandv("vf", "add", "@slowmoexp:" .. temp_vf)
    end

    mp.set_property("screenshot-format", fmt)
    local out_name = (base .. string.format("_frame%06d_%s.%s", frame_num, tc, fmt)):gsub('[<>:"/\\|?*]', "_")
    -- "video" = raw decoded frame at native resolution, no OSD burned in
    mp.commandv("screenshot-to-file", dir .. "\\" .. out_name, "video")

    if temp_vf then mp.commandv("vf", "remove", "@slowmoexp") end
    emit(string.format("Exported %s (%s, %d%%)", out_name, fmt:upper(), scale), 2.5)
end

-- ============================================================
-- Sound summary
-- ============================================================

local function audio_menu()
    local vol = mp.get_property_number("volume") or 0
    local muted = mp.get_property_bool("mute")
    local aid = mp.get_property_number("aid") or 0
    local desc = "none"
    for _, tr in ipairs(mp.get_property_native("track-list") or {}) do
        if tr.type == "audio" and tr.id == aid then
            desc = string.format("#%d %s%s", tr.id, tr.codec or "?", tr.lang and (" [" .. tr.lang .. "]") or "")
        end
    end
    emit(string.format("Sound: %d%%%s | Track %s | %s | delay %.0fms",
        vol, muted and " (muted)" or "", desc,
        mp.get_property("audio-device") or "auto",
        (mp.get_property_number("audio-delay") or 0) * 1000), 4)
end

-- ============================================================
-- Sibling video navigation
-- ============================================================

local VIDEO_EXTS = { mp4 = true, mov = true, m4v = true }

local function play_sibling(offset)
    local path = mp.get_property("path")
    if not path then emit("No file loaded", 1.5) return end
    local dir, filename = path:match("^(.*)[\\/]([^\\/]+)$")
    if not dir then emit("Cannot resolve folder", 1.5) return end

    local files = {}
    for _, f in ipairs(utils.readdir(dir, "files") or {}) do
        local ext = f:match("%.([%a%d]+)$")
        if ext and VIDEO_EXTS[ext:lower()] then files[#files + 1] = f end
    end
    if #files == 0 then emit("No other videos in this folder", 1.5) return end
    table.sort(files, function(a, b) return a:lower() < b:lower() end)

    local idx = 1
    for i, f in ipairs(files) do if f == filename then idx = i break end end
    local new_idx = ((idx - 1 + offset) % #files) + 1
    mp.commandv("loadfile", dir .. "\\" .. files[new_idx], "replace")
    emit(string.format("(%d/%d) %s", new_idx, #files, files[new_idx]), 1.5)
end

local function next_video() play_sibling(1) end
local function prev_video() play_sibling(-1) end

-- ============================================================
-- Control panel process (separate window)
-- ============================================================

local function panel_query(script)
    return mp.command_native({
        name = "subprocess", capture_stdout = true, playback_only = false,
        args = { "powershell", "-NoProfile", "-NonInteractive", "-Command", script },
    })
end

-- $PID excludes the querying process itself, whose own command line
-- contains the search text and would otherwise always match.
local FIND_PANEL =
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'powershell.exe' " ..
    "-and $_.CommandLine -like '*ControlPanel.ps1*' -and $_.ProcessId -ne $PID }"

local function control_panel_running()
    local r = panel_query("if (" .. FIND_PANEL .. ") { 'yes' }")
    return r ~= nil and r.status == 0 and r.stdout ~= nil and r.stdout:find("yes") ~= nil
end

local function kill_control_panel()
    panel_query(FIND_PANEL .. " | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }")
end

local function launch_control_panel()
    mp.command_native({
        name = "subprocess", playback_only = false, detach = true,
        args = { "powershell", "-NoLogo", "-NoProfile", "-WindowStyle", "Hidden",
                 "-ExecutionPolicy", "Bypass", "-File", root() .. "\\ControlPanel.ps1" },
    })
end

local function toggle_control_panel()
    if control_panel_running() then
        kill_control_panel()
        panel_open = false -- force-killed, so it never clears its own heartbeat
        emit("Control panel closed", 1.2)
    else
        launch_control_panel()
        emit("Control panel opened", 1.2)
    end
end

mp.register_event("shutdown", kill_control_panel)

-- ============================================================
-- Control bar
-- ============================================================

local BAR_H, MARGIN = 52, 12
local COL_BG, COL_BG_A = "&H1A1A1A&", "&H30&"
local COL_BTN, COL_BTN_A = "&H323232&", "&H15&"
local COL_TEXT, COL_TEXT_DARK = "&HFFFFFF&", "&H000000&"
local COL_TRACK = "&H505050&"
local COL_YELLOW, COL_BLUE, COL_GREEN = "&H00D2FF&", "&HFF901E&", "&H71CC2E&"
local COL_ACCENT = COL_YELLOW

local ui_scale = 1.0
local help_visible = false
local ui = { buttons = {}, seekbar = nil, dragging = false, osd_w = 0, osd_h = 0 }
local last_mb, last_mt = -1, -1

local SHORTCUTS = {
    { "Left / Right", "Seek 1 second" },
    { "Shift+Left / Shift+Right", "Step one frame" },
    { "s", "Slow-mo conform to 24fps" },
    { "e  /  right-click", "Export frame to Exports folder" },
    { "< / >  or  PgUp / PgDn", "Previous / next video in folder" },
    { "Ctrl+A", "Sound settings" },
    { "9 / 0   m   a", "Volume, mute, audio track" },
    { "[ / ]   Backspace", "Speed nudge, reset speed" },
    { "Space   f", "Play/pause, fullscreen" },
    { "Ctrl+= / Ctrl+- / Ctrl+0", "UI scale up / down / reset" },
    { "Ctrl+P", "Show / hide control panel window" },
    { "h  /  F1", "Toggle this panel" },
    { "Wheel   Side-scroll", "Zoom   Scrub" },
}

-- Scale is driven by window HEIGHT, not width: a portrait clip fills a tall
-- narrow window, where width-based scaling would shrink the UI to nothing
-- exactly when the window is physically large.
local function effective_scale()
    local h = ui.osd_h > 0 and ui.osd_h or 1080
    return math.max(1.0, math.min(h / 900, 3.5)) * ui_scale
end

local function fps_tier(fps)
    if fps and fps > 60.5 then return "green", COL_GREEN end
    if fps and fps > 30.5 then return "blue", COL_BLUE end
    return "yellow", COL_YELLOW
end

local function fmt_time(t)
    if not t or t ~= t then return "0:00" end
    t = math.max(t, 0)
    local hh, mm, ss = math.floor(t / 3600), math.floor((t % 3600) / 60), math.floor(t % 60)
    if hh > 0 then return string.format("%d:%02d:%02d", hh, mm, ss) end
    return string.format("%d:%02d", mm, ss)
end

local function rect(ass, x0, y0, x1, y1, colour, alpha)
    if x1 <= x0 or y1 <= y0 then return end
    ass:new_event()
    ass:pos(0, 0)
    ass:append(string.format("{\\an7\\bord0\\shad0\\1c%s\\1a%s}", colour, alpha or "&H00&"))
    ass:draw_start()
    ass:rect_cw(x0, y0, x1, y1)
    ass:draw_stop()
end

local function text(ass, x, y, align, size, colour, str)
    ass:new_event()
    ass:pos(x, y)
    ass:append(string.format("{\\an%d\\bord1.5\\shad0\\3c&H000000&\\fs%d\\1c%s}%s",
        align, math.floor(size + 0.5), colour, str))
end

local function inside(b, x, y) return x >= b[1] and x <= b[3] and y >= b[2] and y <= b[4] end

local render

local function toggle_help()
    -- With the panel open the shortcut list lives there permanently, so
    -- don't also cover the video with the overlay version of it.
    if is_panel_open() then
        help_visible = false
        emit("Shortcuts are listed in the control panel", 2)
        render()
        return
    end
    help_visible = not help_visible
    render()
end

local function draw_help(ass, w, h, S)
    local pad, row_h, fs = 26 * S, 30 * S, 15 * S
    local pw = math.min(w * 0.94, 780 * S)
    local ph = pad * 2 + row_h * (#SHORTCUTS + 1)
    local x0, y0 = (w - pw) / 2, math.max(8, (h - ph) / 2)

    rect(ass, 0, 0, w, h, "&H000000&", "&H99&")
    rect(ass, x0, y0, x0 + pw, y0 + ph, COL_BG, "&H0A&")
    text(ass, x0 + pad, y0 + pad, 7, fs + 3, COL_ACCENT, "Shortcuts   (click anywhere to close)")
    for i, r in ipairs(SHORTCUTS) do
        local y = y0 + pad + row_h * i
        text(ass, x0 + pad, y, 7, fs, COL_ACCENT, r[1])
        text(ass, x0 + pad + pw * 0.42, y, 7, fs, COL_TEXT, r[2])
    end
end

render = function()
    local w, h = mp.get_osd_size()
    if not w or w <= 0 or not h or h <= 0 then return end
    ui.osd_w, ui.osd_h = w, h
    ui.buttons = {}

    local S = effective_scale()
    local bar_h, margin = BAR_H * S, MARGIN * S
    local status_h = 24 * S
    local tier_name, tier_colour = fps_tier(source_fps)
    COL_ACCENT = tier_colour

    mp.set_property_native("user-data/slowmo/ui_scale", S)
    mp.set_property("user-data/slowmo/fps_tier", tier_name)

    -- Reserve real space so the bar never covers the video image.
    local mb, mt = bar_h / h, status_h / h
    if math.abs(mb - last_mb) > 0.002 then
        mp.set_property_number("video-margin-ratio-bottom", mb); last_mb = mb
    end
    if math.abs(mt - last_mt) > 0.002 then
        mp.set_property_number("video-margin-ratio-top", mt); last_mt = mt
    end

    local ass = assdraw.ass_new()
    local by0, by1 = h - bar_h, h
    rect(ass, 0, by0, w, by1, COL_BG, COL_BG_A)

    local dur = mp.get_property_number("duration") or 0
    local pos = mp.get_property_number("time-pos") or 0
    local paused = mp.get_property_bool("pause")
    local muted = mp.get_property_bool("mute")
    local vol = mp.get_property_number("volume") or 0

    local bh = bar_h - 12 * S
    local cy0, cy1 = by0 + 6 * S, by1 - 6 * S
    local fs = 14 * S
    local gap = 5 * S

    local lx = margin
    local function left(bw, label, active, fn)
        local x0, x1 = lx, lx + bw
        lx = x1 + gap
        rect(ass, x0, cy0, x1, cy1, active and COL_ACCENT or COL_BTN, COL_BTN_A)
        text(ass, (x0 + x1) / 2, (cy0 + cy1) / 2, 5, fs, active and COL_TEXT_DARK or COL_TEXT, label)
        ui.buttons[#ui.buttons + 1] = { x0, cy0, x1, cy1, fn }
    end

    local rx = w - margin
    local function right(bw, label, active, fn)
        local x1, x0 = rx, rx - bw
        rx = x0 - gap
        rect(ass, x0, cy0, x1, cy1, active and COL_ACCENT or COL_BTN, COL_BTN_A)
        text(ass, (x0 + x1) / 2, (cy0 + cy1) / 2, 5, fs, active and COL_TEXT_DARK or COL_TEXT, label)
        ui.buttons[#ui.buttons + 1] = { x0, cy0, x1, cy1, fn }
    end

    left(58 * S, paused and "Play" or "Pause", false, function() mp.commandv("cycle", "pause") end)
    left(34 * S, "<<", false, prev_video)
    left(34 * S, ">>", false, next_video)
    left(30 * S, "?", help_visible, toggle_help)
    left(56 * S, "Panel", false, toggle_control_panel)

    right(52 * S, muted and "Mute" or (math.floor(vol) .. "%"), muted, function() mp.commandv("cycle", "mute") end)
    right(66 * S, "Sound", false, audio_menu)
    right(72 * S, "Export", false, export_frame)
    right(86 * S, slowmo_active and string.format("%.1fx", (source_fps or 24) / 24) or "Slow-mo",
        slowmo_active, slowmo_toggle)

    -- Time readout, then the seek bar fills whatever is left between them.
    local time_str = fmt_time(pos) .. " / " .. fmt_time(dur)
    local time_w = (#time_str * 8 + 12) * S
    text(ass, lx, (cy0 + cy1) / 2, 4, fs, COL_TEXT, time_str)
    lx = lx + time_w

    local sx0, sx1 = lx + 4 * S, rx - 4 * S
    if sx1 - sx0 > 30 * S then
        local sy = (cy0 + cy1) / 2
        local th = 5 * S
        rect(ass, sx0, sy - th / 2, sx1, sy + th / 2, COL_TRACK, COL_BTN_A)
        if dur > 0 then
            local fx = sx0 + (sx1 - sx0) * math.max(0, math.min(1, pos / dur))
            rect(ass, sx0, sy - th / 2, fx, sy + th / 2, COL_ACCENT, COL_BTN_A)
            local k = 6 * S
            rect(ass, fx - k, sy - k * 1.5, fx + k, sy + k * 1.5, COL_ACCENT, COL_BTN_A)
        end
        ui.seekbar = { sx0, by0, sx1, by1 }
    else
        ui.seekbar = nil
    end

    -- Top-left status strip
    local mode = slowmo_active
        and string.format("SLOW-MO %.0f>%gfps", source_fps or 0, target_fps())
        or string.format("%.0f fps", source_fps or 0)
    local vw = mp.get_property_number("width")
    local vh = mp.get_property_number("height")
    local res = (vw and vh) and string.format("%dx%d   |   ", vw, vh) or ""
    local status = string.format("%s%s   |   Frame %d   |   %s", res, mode,
        mp.get_property_number("estimated-frame-number") or 0, fmt_time(pos))
    rect(ass, 0, 0, math.min(w, (#status * 7.6 + 20) * S), status_h, COL_BG, COL_BG_A)
    text(ass, 10 * S, status_h / 2, 4, 13 * S, COL_ACCENT, status)

    if help_visible then draw_help(ass, w, h, S) end
    mp.set_osd_ass(w, h, ass.text)
end

-- ============================================================
-- Mouse
-- ============================================================

local function seek_to_x(x)
    if not ui.seekbar then return end
    local sx0, sx1 = ui.seekbar[1], ui.seekbar[3]
    local dur = mp.get_property_number("duration") or 0
    if dur <= 0 or sx1 <= sx0 then return end
    mp.commandv("seek", math.max(0, math.min(1, (x - sx0) / (sx1 - sx0))) * 100,
        "absolute-percent", "exact")
end

mp.add_key_binding("MBTN_LEFT", "ui_mbtn_left", function(e)
    if e.event == "up" then ui.dragging = false return end
    if e.event ~= "down" then return end
    if help_visible then toggle_help() return end

    local x, y = mp.get_mouse_pos()
    if ui.seekbar and inside(ui.seekbar, x, y) then
        ui.dragging = true
        seek_to_x(x)
        return
    end
    for _, b in ipairs(ui.buttons) do
        if inside(b, x, y) then b[5]() return end
    end
    if y < ui.osd_h - BAR_H * effective_scale() then mp.commandv("cycle", "pause") end
end, { complex = true })

mp.observe_property("mouse-pos", "native", function(_, v)
    if ui.dragging and v then seek_to_x(v.x) end
end)

-- ============================================================
-- UI scale
-- ============================================================

local function scale_report()
    emit(string.format("UI scale %.0f%%", effective_scale() * 100), 1.2)
end

local function ui_scale_up()
    ui_scale = math.min(ui_scale * 1.15, 3.0); render(); scale_report()
end
local function ui_scale_down()
    ui_scale = math.max(ui_scale / 1.15, 0.4); render(); scale_report()
end
local function ui_scale_reset()
    ui_scale = 1.0; render(); scale_report()
end

-- ============================================================
-- Session state: last file + UI scale, so the next launch resumes.
-- Launch.ps1 reads this; window geometry is saved there (mpv exposes
-- no window position property, so it needs the Win32 window rect).
-- ============================================================

-- Remember the path as it loads: by the time the shutdown event fires mpv
-- has already cleared the "path" property, which was silently saving an
-- empty filename and losing the resume-last-video behaviour.
local last_path = nil

local function save_state()
    local path = mp.get_property("path") or last_path
    if path then last_path = path end
    local f = io.open(state_path(), "w")
    if not f then return end
    f:write(string.format('{"file":"%s","uiScale":%.4f}',
        path and json_escape(path) or "", ui_scale))
    f:close()
end

mp.register_event("file-loaded", function()
    slowmo_active = false
    mp.set_property("speed", 1.0)
    mp.set_property("video-zoom", 0)
    local fps = detect_fps()
    if fps then emit(string.format("%s  -  %.2f fps",
        (mp.get_property("filename") or ""), fps), 2) end
    save_state()
    render()
end)

mp.register_event("shutdown", save_state)
mp.add_periodic_timer(5, save_state)

-- Restore the saved UI scale (written by the previous session).
local sf = io.open(state_path(), "r")
if sf then
    local body = sf:read("*a") or ""
    sf:close()
    local saved = tonumber(body:match('"uiScale"%s*:%s*([%d%.]+)'))
    if saved and saved >= 0.4 and saved <= 3.0 then ui_scale = saved end
end

-- ============================================================
-- Bindings / observers
-- ============================================================

mp.add_key_binding(nil, "slowmo_toggle", slowmo_toggle)
mp.add_key_binding(nil, "export_frame", export_frame)
mp.add_key_binding(nil, "audio_menu", audio_menu)
mp.add_key_binding(nil, "next_video", next_video)
mp.add_key_binding(nil, "prev_video", prev_video)
mp.add_key_binding(nil, "toggle_help", toggle_help)
mp.add_key_binding(nil, "toggle_control_panel", toggle_control_panel)
mp.add_key_binding(nil, "ui_scale_up", ui_scale_up)
mp.add_key_binding(nil, "ui_scale_down", ui_scale_down)
mp.add_key_binding(nil, "ui_scale_reset", ui_scale_reset)

-- If the panel opens while the on-video shortcut overlay is up, drop the
-- overlay: the panel is now showing that list.
hide_overlay_on_panel = function()
    if help_visible then help_visible = false; render() end
end

for _, p in ipairs({ "pause", "time-pos", "duration", "mute", "volume", "osd-dimensions" }) do
    mp.observe_property(p, "native", render)
end
mp.register_event("video-reconfig", render)

render()
