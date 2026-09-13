-- ============================================================
-- MediaInspector_Pro
--   * one window for video, photos and audio
--   * the window fits the media it opens (mpv-style fit-to-frame)
--   * 24fps slow-motion conform, frame-exact stepping
--   * full-quality frame / image export
--   * GPU upscaling: RTX VSR, ArtCNN 2x, FSR, and GLSL shaders
--   * custom clickable control bar (replaces mpv's OSC)
--   * media-kind aware UI, activity log, state persistence
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
-- Supported media
--   Three sets, because the UI changes shape per kind - but folder
--   navigation walks the union, so a folder of mixed media browses as
--   one sequence rather than three invisible ones.
-- ============================================================

local function set_of(list)
    local t = {}
    for _, e in ipairs(list) do t[e] = true end
    return t
end

local EXT_VIDEO = set_of({
    "mp4", "mov", "m4v", "mkv", "avi", "webm", "wmv", "flv", "mpg", "mpeg",
    "m2ts", "mts", "ts", "m2v", "vob", "3gp", "3g2", "ogv", "ogm", "mxf",
    "asf", "rm", "rmvb", "divx", "f4v", "y4m", "gif", "apng", "dv", "amv",
    "nut", "roq", "h264", "h265", "hevc", "av1", "ivf",
})

local EXT_PHOTO = set_of({
    "jpg", "jpeg", "jpe", "jfif", "png", "bmp", "webp", "tif", "tiff",
    "heic", "heif", "avif", "jxl", "jp2", "j2k", "jpf", "jxr", "tga",
    "targa", "exr", "hdr", "pic", "dds", "ppm", "pgm", "pbm", "pnm", "pam",
    "pcx", "sgi", "xbm", "xpm", "ico", "cur", "qoi",
})

-- Camera raw: ffmpeg decodes several of these directly and refuses the
-- rest. Listed separately so folder navigation still walks past them.
local EXT_RAW = set_of({
    "dng", "cr2", "cr3", "nef", "nrw", "arw", "srf", "sr2", "raf", "orf",
    "rw2", "pef", "raw", "3fr", "erf", "kdc", "mos", "mrw", "x3f",
})

local EXT_AUDIO = set_of({
    "mp3", "wav", "flac", "aac", "m4a", "m4b", "ogg", "oga", "opus", "wma",
    "aiff", "aif", "aifc", "alac", "ape", "wv", "mka", "dsf", "dff", "ac3",
    "eac3", "dts", "dtshd", "thd", "mp2", "mpa", "spx", "tta", "caf", "au",
    "amr", "awb", "gsm", "shn", "mpc", "ra", "voc", "w64", "8svx", "aa3",
    "oma", "mid", "midi",
})

local EXT_ALL = {}
for _, s in ipairs({ EXT_VIDEO, EXT_PHOTO, EXT_RAW, EXT_AUDIO }) do
    for k in pairs(s) do EXT_ALL[k] = true end
end

local function ext_of(path)
    local e = path:match("%.([%a%d]+)$")
    return e and e:lower() or nil
end

-- ============================================================
-- Media kind
--   Driven by what mpv actually decoded, not by the extension: a .mkv
--   holding one still frame is a photo, an .mp4 with no video track is
--   audio, and an .mp3 with cover art must NOT be treated as a photo.
-- ============================================================

local MEDIA = { kind = "video", w = 0, h = 0, ext = "" }

local function detect_kind()
    local vt = mp.get_property_native("current-tracks/video")
    local at = mp.get_property_native("current-tracks/audio")
    if vt and vt.albumart then return "audio" end
    if vt and vt.image then
        -- An animated source (gif/apng/webp) reports image on the track but
        -- carries many frames; treat those as video so the timeline works.
        local n = mp.get_property_number("estimated-frame-count") or 0
        if n > 1 then return "video" end
        return "photo"
    end
    if vt then return "video" end
    if at then return "audio" end
    return "video"
end

local function refresh_media()
    MEDIA.kind = detect_kind()
    MEDIA.w = mp.get_property_number("width") or 0
    MEDIA.h = mp.get_property_number("height") or 0
    MEDIA.ext = ext_of(mp.get_property("path") or "") or ""
    mp.set_property("user-data/mi/kind", MEDIA.kind)
    return MEDIA.kind
end

local function is_photo() return MEDIA.kind == "photo" end
local function is_audio() return MEDIA.kind == "audio" end
local function is_video() return MEDIA.kind == "video" end

-- ============================================================
-- Activity log: routed to the control panel's textbox when it's
-- open, otherwise shown as an on-media OSD message.
-- ============================================================

local panel_open, panel_last_seen = false, 0
local log_seq, log_lines = 0, {}

local hide_overlay_on_panel = nil -- set below, once render() exists

mp.observe_property("user-data/mi/panel_open", "bool", function(_, v)
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
    mp.set_property("user-data/mi/log", "[" .. table.concat(parts, ",") .. "]")

    if not is_panel_open() then mp.osd_message(text, duration or 2) end
end

-- Settings live in mpv user-data so the control panel can change them
-- live over IPC; these are the fallbacks when it has not set them.
--
-- Read natively, NOT with mp.get_property: user-data holds mpv nodes, and
-- asking for a node in string form hands back its JSON encoding - so a
-- Windows path came out as "\"C:\\dir\\file\"", quotes and doubled
-- backslashes included, and every path setting silently failed to open.
local function setting(name, default)
    local v = mp.get_property_native("user-data/mi/set_" .. name)
    if type(v) ~= "string" then
        if v == nil then return default end
        v = tostring(v)
    end
    if v == "" then return default end
    return v
end

local function setting_num(name, default)
    return tonumber(setting(name, nil)) or default
end

local function setting_bool(name, default)
    local v = setting(name, nil)
    if v == nil then return default end
    return v == "yes" or v == "true" or v == "1"
end

-- MediaInspector_Pro.exe hosts mpv inside its own window (--wid) and draws
-- the controls there. Read from --script-opts rather than user-data, because
-- this has to be known at load time - before the host's IPC connection
-- exists - to decide who owns window sizing and whether the separate
-- PowerShell panel is even a thing.
local embedded = (mp.get_opt("mi-embedded") == "yes")

-- ============================================================
-- UI metrics
--   Declared up here because the window-fitting code below has to know how
--   much vertical space the chrome will claim before the window exists.
-- ============================================================

local BAR_H, MARGIN = 52, 12
local STATUS_H, SUBBAR_H = 24, 24

-- Ctrl+= / Ctrl+- step by this factor. Default is five steps below 1.0.
local UI_SCALE_STEP = 1.15
local UI_SCALE_DEFAULT = 1.0 / (UI_SCALE_STEP ^ 5)

local ui_scale = UI_SCALE_DEFAULT
local ui = { buttons = {}, seekbar = nil, speedbar = nil, zoombar = nil, osd_w = 0, osd_h = 0 }

-- Declared here rather than beside its definition: the crop editor and the
-- browse scope both live above the drawing code and have to ask for a redraw.
local render

-- Scale is driven by window HEIGHT, not width: a portrait clip fills a tall
-- narrow window, where width-based scaling would shrink the UI to nothing
-- exactly when the window is physically large.
local function scale_for_height(h)
    return math.max(1.0, math.min((h or 1080) / 900, 3.5)) * ui_scale
end

local function effective_scale()
    return scale_for_height(ui.osd_h > 0 and ui.osd_h or 1080)
end

-- Chrome = top status strip + bottom bar + the sub-bar (shuttle for video
-- and audio, zoom for photos). Every kind keeps all three rows, so the
-- height is the same either way - but it is computed rather than assumed so
-- the two stay in step if one kind ever drops a row.
local function chrome_px(window_h)
    local S = scale_for_height(window_h)
    return (STATUS_H + BAR_H + SUBBAR_H) * S
end

-- ============================================================
-- Fit-to-frame window sizing
--   mpv's own auto-resize sizes the window to the video, which then has
--   the control bar carved out of it - so a 1080p clip lost ~100px of image
--   to the chrome. This sizes the window to the media PLUS the chrome, so
--   the picture itself lands at its native size (or the largest fraction of
--   it that fits the display).
-- ============================================================

-- display-width/height only become real once the VO has a window on a
-- monitor, which is *after* file-loaded fires for the first file of a
-- session. Fitting against the placeholder produced a window sized for a
-- 1080p screen on a 4K one, so this returns nil until the numbers are
-- trustworthy and the caller retries.
local function display_area()
    local dw = mp.get_property_number("display-width")
    local dh = mp.get_property_number("display-height")
    if not dw or dw < 320 or not dh or dh < 240 then return nil end
    return dw, dh
end

-- Shader upscalers (CNN / FSR) reconstruct into a larger plane; the window
-- has to grow with them or they have nothing to fill. RTX enlarges the
-- decoded frame itself, so the source size is already the output size.
local function view_size()
    local w, h = MEDIA.w, MEDIA.h
    local mode = setting("upscale", "off")
    if (mode == "fsr" or mode == "cnn") and w > 0 and h > 0 then
        local f = setting_num("upscale_factor", 2)
        if f and f > 1 then
            w, h = w * f, h * f
        end
    end
    return w, h
end

local function fit_window()
    -- Embedded, mpv is a child window and cannot resize the frame around it;
    -- the host does the fitting. Report success either way so the retry loop
    -- below stops instead of spinning for two seconds on every file.
    if embedded then return true end
    if not setting_bool("fit_window", true) then return true end
    if mp.get_property_bool("fullscreen") then return true end
    if mp.get_property_bool("window-maximized") then return true end
    if mp.get_property_bool("window-minimized") then return false end

    local dw, dh = display_area()
    if not dw then return false end
    -- Leave room for the taskbar and the window frame itself.
    local max_w, max_h = math.floor(dw * 0.94), math.floor(dh * 0.90)

    local vw, vh = view_size()
    local win_w, win_h
    if is_audio() or vw <= 0 or vh <= 0 then
        -- Nothing to fit: a fixed compact strip, tall enough for the chrome
        -- plus a band for the cover art / level readout.
        win_w = math.min(max_w, 980)
        win_h = math.min(max_h, math.floor(chrome_px(560)) + 260)
    else
        -- Solve for the window height: the chrome height depends on the
        -- window height (UI scale is height-derived), so start from the
        -- unscaled media and settle over a few passes. It converges fast -
        -- three rounds is well past the point of movement.
        local c = chrome_px(vh)
        for _ = 1, 3 do
            local s = math.min(1.0, max_w / vw, (max_h - c) / vh)
            if s <= 0 then s = 0.1 end
            c = chrome_px(vh * s + c)
        end
        local s = math.min(1.0, max_w / vw, (max_h - c) / vh)
        if s <= 0 then s = 0.1 end
        win_w = math.max(480, math.floor(vw * s + 0.5))
        win_h = math.max(320, math.floor(vh * s + c + 0.5))
    end

    -- Geometry with only a size resizes without moving, so the window
    -- stays where the user put it.
    mp.set_property("geometry", string.format("%dx%d", win_w, win_h))
    return true
end

local function fit_now()
    if not fit_window() then
        emit("Window fitting is off, or the display size is not known yet", 2)
        return
    end
    if is_audio() then
        emit("Window fitted for audio", 1.2)
    else
        local vw, vh = view_size()
        emit(string.format("Window fitted to %dx%d on a %dx%d display",
            vw, vh,
            select(1, display_area()) or 0, select(2, display_area()) or 0), 2)
    end
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

local function target_fps()
    local fps = source_fps or detect_fps() or 60
    return math.min(160, fps)
end

local function slowmo_toggle()
    if not is_video() then
        emit("Slow-mo applies to video only", 1.5)
        return
    end
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
-- Paced exact seeking
-- ============================================================

-- Jumping the playhead to where the mouse points is the one place a seek is
-- the right tool - everything else steps frame by frame so nothing is
-- skipped. Even here the seek is exact rather than "keyframes": keyframe
-- precision snaps to whatever keyframe is nearest, which on footage with
-- ~1s keyframe spacing lands a whole second from where you pointed.
--
-- Only one seek is in flight at a time, paced to mpv's own completion
-- signal. Dragging is position tracking rather than accumulated motion, so
-- while one seek lands the mouse has already moved on and the newest target
-- simply replaces the queued one.
local seek_busy = false
local seek_pending_pct = nil

local function paced_seek_percent(pct)
    if seek_busy then
        seek_pending_pct = pct
        return
    end
    seek_busy = true
    mp.commandv("seek", pct, "absolute-percent", "exact")
end

-- Loading a new file cancels any in-flight seek without a playback-restart
-- for it, which would otherwise leave the pacing latched and scrubbing dead.
local function reset_seek_pacing()
    seek_busy, seek_pending_pct = false, nil
end

mp.register_event("playback-restart", function()
    seek_busy = false
    if seek_pending_pct then
        local pct = seek_pending_pct
        seek_pending_pct = nil
        paced_seek_percent(pct)
    end
end)

-- ============================================================
-- HDR toggle
-- ============================================================

-- target-colorspace-hint default is "no" (config/mpv.conf): HDR sources are
-- tone-mapped down and the swapchain stays SDR until toggled on here, which
-- switches to "auto" - PQ/HLG sources then switch the DXGI swapchain into
-- HDR, SDR sources stay SDR regardless.
local function hdr_forced_off()
    return mp.get_property("target-colorspace-hint") == "no"
end

local function media_is_hdr()
    local g = mp.get_property("video-params/gamma")
    return g == "pq" or g == "hlg"
end

-- No explicit render() call here: hdr_toggle is defined (and bound to
-- Ctrl+H) before the local `render` function exists further down the file,
-- so calling it here would resolve to a nonexistent global. The bar
-- observes target-colorspace-hint below and re-renders when it changes.
local function hdr_toggle()
    if not media_is_hdr() then
        emit("Not an HDR source - toggle ignored", 2)
        return
    end
    if hdr_forced_off() then
        mp.set_property("target-colorspace-hint", "auto")
        emit("HDR ON - PQ/HLG sources switch the display to HDR", 2)
    else
        mp.set_property("target-colorspace-hint", "no")
        emit("HDR OFF - forced SDR, HDR sources are tone-mapped down", 2)
    end
end

-- ============================================================
-- Zoom / pan (the photo viewer's main gesture, also usable on video)
--   video-zoom is log2: 0 = fit, 1 = 2x fit. video-pan-x/y are fractions
--   of the window, so they are resolution independent.
-- ============================================================

local ZOOM_MIN, ZOOM_MAX = -2.0, 4.0

-- Displayed scale relative to the source pixels, read back from the actual
-- output rectangle rather than recomputed - osd-dimensions already accounts
-- for the letterboxing that video-margin-ratio introduces for the bar.
local function display_scale()
    local d = mp.get_property_native("osd-dimensions")
    if not d or not d.w or MEDIA.w <= 0 then return 1.0 end
    local vis_w = d.w - (d.ml or 0) - (d.mr or 0)
    if vis_w <= 0 then return 1.0 end
    return vis_w / MEDIA.w
end

local function set_zoom(z)
    z = math.max(ZOOM_MIN, math.min(ZOOM_MAX, z))
    mp.set_property_number("video-zoom", z)
end

local function zoom_by(delta)
    set_zoom((mp.get_property_number("video-zoom") or 0) + delta)
end

local function zoom_fit()
    mp.set_property_number("video-zoom", 0)
    mp.set_property_number("video-pan-x", 0)
    mp.set_property_number("video-pan-y", 0)
    emit("Zoom: fit to window", 1.2)
end

local function zoom_actual()
    -- Solve for the zoom that puts one source pixel on one screen pixel:
    -- current scale is fit_scale * 2^zoom, so the delta is -log2(scale).
    local cur = display_scale()
    if cur <= 0 then return end
    local z = (mp.get_property_number("video-zoom") or 0) - (math.log(cur) / math.log(2))
    mp.set_property_number("video-pan-x", 0)
    mp.set_property_number("video-pan-y", 0)
    set_zoom(z)
    emit("Zoom: 1:1 (100% of source pixels)", 1.2)
end

local function rotate_by(deg)
    local r = ((mp.get_property_number("video-rotate") or 0) + deg) % 360
    mp.set_property_number("video-rotate", r)
    emit(string.format("Rotated to %d degrees", r), 1.2)
end

-- ============================================================
-- GPU upscaling
--   Four routes, all local and all on the GPU:
--     rtx    - NVIDIA RTX Video Super Resolution through D3D11 Video
--              Processing. The driver's own AI upscaler; it only accepts
--              hardware-decoded D3D11 surfaces, so it is skipped for photos
--              and for anything falling back to software decode.
--     cnn    - ArtCNN C4F16 DS, a trained 2x luma CNN (denoise+sharpen).
--              The reconstruction path for soft / compressed / low-res
--              footage. A user shader, so it works on photos and CPU
--              decode too. Window grows by upscale_factor so the extra
--              pixels have somewhere to land.
--     fsr    - AMD FidelityFX Super Resolution (EASU + RCAS). Spatial
--              edge-adaptive upsample to the window, capped at 2x. Same
--              window-grow as cnn. Cheaper than the CNN, weaker on mushy
--              sources.
--     shader - libplacebo user shaders from config/shaders, applied by the
--              gpu-next renderer itself. The route that also covers the
--              inspect/enhance checkboxes.
--   The filter-based one (rtx) lives under a label so switching modes never
--   leaves a stale stage behind. cnn/fsr shaders live in Upscale-*.glsl
--   and are appended by the mode, not the checkbox list.
-- ============================================================

local UPSCALE_LABEL = "miup"

local function hw_decoding()
    local h = mp.get_property("hwdec-current")
    return h ~= nil and h ~= "" and h ~= "no"
end

-- mpv logs a command error when `vf remove` is handed a label that is not
-- in the chain, which would put a scary line in the log every time the
-- upscaler is simply left off. Check the chain first instead.
local function filter_present(label)
    for _, f in ipairs(mp.get_property_native("vf") or {}) do
        if f.label == label then return true end
    end
    return false
end

local function clear_upscale_filter()
    if filter_present(UPSCALE_LABEL) then
        mp.commandv("vf", "remove", "@" .. UPSCALE_LABEL)
    end
end

-- ============================================================
-- Aspect-ratio crop
--   A ratio button sizes the largest even window of that shape that fits
--   the source. The viewer shows only that window (vf crop), and dragging
--   the picture slides the full frame underneath it - x/y of the crop,
--   not video-pan, so export and trim see the same pixels.
-- ============================================================

local CROP_LABEL = "microp"

-- `on` is a crop the filter is actually applying; `editing` is the adjust
-- mode, where the filter is off so the whole frame can be seen and the same
-- w/h/x/y are a box being dragged over it. `saved` is what to put back if
-- that adjustment is cancelled.
local crop = {
    on = false,
    editing = false,
    saved = nil,
    label = "",
    rw = 0, rh = 0,
    src_w = 0, src_h = 0,
    w = 0, h = 0, x = 0, y = 0,
    last_vf = 0,
}

-- The adjust mode hangs off one table rather than a dozen top-level locals:
-- Lua's main chunk allows only 200 of those and this script is near the line.
-- MIN is in source pixels - a box smaller than that is a slip of the hand.
local cropui = {
    MIN = 16,
    RATIOS = {
        { 0, 0, "" }, { 1, 1, "1:1" }, { 4, 3, "4:3" }, { 16, 9, "16:9" },
        { 9, 16, "9:16" }, { 3, 2, "3:2" }, { 2, 3, "2:3" }, { 21, 9, "21:9" },
    },
    HANDLES = { "nw", "n", "ne", "e", "se", "s", "sw", "w" },
    drag = nil,
}

local function even_px(n)
    n = math.floor((n or 0) + 0.5)
    if n < 2 then return 2 end
    if n % 2 ~= 0 then n = n - 1 end
    return n
end

local function decoder_size()
    local w = mp.get_property_number("video-dec-params/w")
        or mp.get_property_number("width")
        or MEDIA.w or 0
    local h = mp.get_property_number("video-dec-params/h")
        or mp.get_property_number("height")
        or MEDIA.h or 0
    return w, h
end

local function crop_size_for_ratio(sw, sh, rw, rh)
    if sw < 2 or sh < 2 or rw <= 0 or rh <= 0 then return sw, sh end
    local cw, ch
    if (sw / sh) > (rw / rh) then
        ch = even_px(sh)
        cw = even_px(ch * rw / rh)
        if cw > sw then
            cw = even_px(sw)
            ch = even_px(cw * rh / rw)
        end
    else
        cw = even_px(sw)
        ch = even_px(cw * rh / rw)
        if ch > sh then
            ch = even_px(sh)
            cw = even_px(ch * rw / rh)
        end
    end
    if cw < 2 then cw = 2 end
    if ch < 2 then ch = 2 end
    if cw > sw then cw = even_px(sw) end
    if ch > sh then ch = even_px(sh) end
    return cw, ch
end

-- The rectangle the picture occupies inside the OSD. mpv's margins already
-- account for the letterboxing, the space reserved for the bar and any zoom,
-- so this is the only thing that has to know how a source pixel reaches the
-- screen. Rotation is not handled: it would swap the axes under the box.
function cropui.video_rect()
    local d = mp.get_property_native("osd-dimensions")
    if not d or not d.w or not d.h then return nil end
    local x0, y0 = d.ml or 0, d.mt or 0
    local x1, y1 = d.w - (d.mr or 0), d.h - (d.mb or 0)
    if x1 - x0 < 8 or y1 - y0 < 8 then return nil end
    return x0, y0, x1, y1
end

-- While the crop is being adjusted the filter is off, so what is on screen is
-- the whole source frame and these two are a straight proportion.
function cropui.to_osd(px, py)
    local x0, y0, x1, y1 = cropui.video_rect()
    if not x0 or crop.src_w < 1 or crop.src_h < 1 then return nil end
    return x0 + (px / crop.src_w) * (x1 - x0), y0 + (py / crop.src_h) * (y1 - y0)
end

function cropui.to_src(ox, oy)
    local x0, y0, x1, y1 = cropui.video_rect()
    if not x0 or crop.src_w < 1 or crop.src_h < 1 then return nil end
    return (ox - x0) / (x1 - x0) * crop.src_w, (oy - y0) / (y1 - y0) * crop.src_h
end

-- Keep the box inside the frame and big enough to grab. No rounding to even
-- pixels here: that only matters at the point the filter is handed the numbers,
-- and rounding every drag step would make the box crawl.
function cropui.clamp()
    crop.w = math.max(cropui.MIN, math.min(crop.w, crop.src_w))
    crop.h = math.max(cropui.MIN, math.min(crop.h, crop.src_h))
    crop.x = math.max(0, math.min(crop.x, crop.src_w - crop.w))
    crop.y = math.max(0, math.min(crop.y, crop.src_h - crop.h))
end

local function clamp_crop_origin()
    local max_x = math.max(0, crop.src_w - crop.w)
    local max_y = math.max(0, crop.src_h - crop.h)
    crop.x = even_px(math.max(0, math.min(max_x, crop.x)))
    crop.y = even_px(math.max(0, math.min(max_y, crop.y)))
    if crop.x > max_x then crop.x = even_px(max_x) end
    if crop.y > max_y then crop.y = even_px(max_y) end
end

local function publish_crop()
    if crop.on or crop.editing then
        mp.set_property("user-data/mi/crop",
            string.format("%d:%d:%d:%d", even_px(crop.w), even_px(crop.h),
                even_px(crop.x), even_px(crop.y)))
        mp.set_property("user-data/mi/crop_ratio", crop.label)
    else
        mp.set_property("user-data/mi/crop", "")
        mp.set_property("user-data/mi/crop_ratio", "")
    end
    mp.set_property_bool("user-data/mi/crop_editing", crop.editing)
end

local function apply_crop_vf(refit)
    if not crop.on then return end
    clamp_crop_origin()
    local spec = string.format("crop=%d:%d:%d:%d", crop.w, crop.h, crop.x, crop.y)
    -- Replace only this labelled stage so look/upscale filters stay put.
    if filter_present(CROP_LABEL) then
        mp.commandv("vf", "remove", "@" .. CROP_LABEL)
    end
    mp.commandv("vf", "add", "@" .. CROP_LABEL .. ":" .. spec)
    crop.last_vf = mp.get_time()
    publish_crop()
    if refit then
        -- Window should match the cropped frame, not the full source.
        MEDIA.w, MEDIA.h = crop.w, crop.h
        mp.add_timeout(0.08, function()
            MEDIA.w, MEDIA.h = crop.w, crop.h
            fit_window()
        end)
    end
end

local function clear_crop(silent)
    if filter_present(CROP_LABEL) then
        mp.commandv("vf", "remove", "@" .. CROP_LABEL)
    end
    crop.on = false
    crop.label = ""
    crop.rw, crop.rh = 0, 0
    crop.w, crop.h, crop.x, crop.y = 0, 0, 0, 0
    publish_crop()
    if not silent then
        emit("Crop off - full frame", 1.2)
        local sw, sh = decoder_size()
        if sw > 0 then
            MEDIA.w, MEDIA.h = sw, sh
            mp.add_timeout(0.08, function()
                MEDIA.w, MEDIA.h = sw, sh
                fit_window()
            end)
        end
    end
end

local function set_crop_aspect(rw, rh, label)
    rw, rh = tonumber(rw), tonumber(rh)
    if not rw or not rh or rw <= 0 or rh <= 0 then return end

    -- A ratio chosen while the box is open reshapes the box; it does not
    -- apply the crop behind the mode the user is still standing in.
    if crop.editing then
        crop.rw, crop.rh = rw, rh
        crop.label = label or string.format("%d:%d", rw, rh)
        cropui.shape_to_ratio()
        publish_crop()
        emit("Crop locked to " .. crop.label, 1.5)
        render()
        return
    end
    local sw, sh
    if crop.src_w >= 2 and crop.src_h >= 2 then
        sw, sh = crop.src_w, crop.src_h
    else
        sw, sh = decoder_size()
    end
    if sw < 2 or sh < 2 then
        emit("No video size to crop yet", 2)
        return
    end
    crop.src_w, crop.src_h = sw, sh
    crop.rw, crop.rh = rw, rh
    crop.label = label or (string.format("%d:%d", rw, rh))
    crop.w, crop.h = crop_size_for_ratio(sw, sh, rw, rh)
    crop.x = even_px((sw - crop.w) / 2)
    crop.y = even_px((sh - crop.h) / 2)
    crop.on = true
    apply_crop_vf(true)
    emit(string.format("Crop %s  %dx%d  drag the picture to reframe",
        crop.label, crop.w, crop.h), 2)
end

-- ---- adjust mode ----

-- Reshape the box to the locked ratio around its own centre, keeping as much
-- of its current size as the frame allows.
function cropui.shape_to_ratio()
    if crop.rw <= 0 or crop.rh <= 0 then return end
    local ar = crop.rw / crop.rh
    local cx, cy = crop.x + crop.w / 2, crop.y + crop.h / 2
    local w, h = crop.w, crop.w / ar
    if h > crop.src_h then h = crop.src_h; w = h * ar end
    if w > crop.src_w then w = crop.src_w; h = w / ar end
    crop.w, crop.h = w, h
    crop.x, crop.y = cx - w / 2, cy - h / 2
    cropui.clamp()
end

function cropui.start()
    if crop.editing then return end
    local sw, sh = decoder_size()
    if sw < 2 or sh < 2 then emit("No video size to crop yet", 2) return end
    crop.src_w, crop.src_h = sw, sh

    if crop.on and crop.w >= cropui.MIN and crop.h >= cropui.MIN then
        crop.saved = { on = true, label = crop.label, rw = crop.rw, rh = crop.rh,
                       w = crop.w, h = crop.h, x = crop.x, y = crop.y }
    else
        crop.saved = { on = false }
        -- Nothing cropped yet: start inset from the frame rather than filling
        -- it, so every handle is on screen and grabbable straight away.
        crop.w, crop.h = sw * 0.8, sh * 0.8
        crop.x, crop.y = (sw - crop.w) / 2, (sh - crop.h) / 2
    end

    -- The filter comes off for the duration: you frame against the whole
    -- picture, and it goes back on at Apply.
    if filter_present(CROP_LABEL) then
        mp.commandv("vf", "remove", "@" .. CROP_LABEL)
    end
    crop.on = false
    crop.editing = true
    cropui.clamp()
    publish_crop()
    emit("Crop: drag the box or its handles.  Enter applies, Esc cancels.", 3)
    render()
end

function cropui.apply()
    if not crop.editing then return end
    crop.editing = false
    crop.saved = nil
    crop.w, crop.h = even_px(crop.w), even_px(crop.h)
    crop.x, crop.y = even_px(crop.x), even_px(crop.y)

    -- A box that is the whole frame is not a crop; treat it as clearing one.
    if crop.w >= crop.src_w and crop.h >= crop.src_h then
        clear_crop(false)
        render()
        return
    end

    crop.on = true
    apply_crop_vf(true)
    emit(string.format("Crop %s  %dx%d at %d,%d",
        crop.label ~= "" and crop.label or "custom", crop.w, crop.h, crop.x, crop.y), 2)
    render()
end

function cropui.cancel()
    if not crop.editing then return end
    crop.editing = false
    local s = crop.saved
    crop.saved = nil
    if s and s.on then
        crop.label, crop.rw, crop.rh = s.label, s.rw, s.rh
        crop.w, crop.h, crop.x, crop.y = s.w, s.h, s.x, s.y
        crop.on = true
        apply_crop_vf(false)
        emit("Crop left as it was", 1.5)
    else
        clear_crop(true)
        emit("Crop cancelled", 1.5)
    end
    render()
end

function cropui.toggle()
    if crop.editing then cropui.apply() else cropui.start() end
end

-- Back to the biggest box the frame (and the locked ratio) allows.
function cropui.full()
    if not crop.editing then return end
    if crop.rw > 0 and crop.rh > 0 then
        crop.w, crop.h = crop_size_for_ratio(crop.src_w, crop.src_h, crop.rw, crop.rh)
    else
        crop.w, crop.h = crop.src_w, crop.src_h
    end
    crop.x, crop.y = (crop.src_w - crop.w) / 2, (crop.src_h - crop.h) / 2
    cropui.clamp()
    publish_crop()
    render()
end

function cropui.cycle_ratio()
    if not crop.editing then return end
    local i = 1
    for n, r in ipairs(cropui.RATIOS) do
        if r[1] == crop.rw and r[2] == crop.rh then i = n break end
    end
    local nxt = cropui.RATIOS[(i % #cropui.RATIOS) + 1]
    crop.rw, crop.rh, crop.label = nxt[1], nxt[2], nxt[3]
    cropui.shape_to_ratio()
    publish_crop()
    emit(crop.rw > 0 and ("Crop locked to " .. crop.label) or "Crop ratio free", 1.5)
    render()
end

-- Handle centres, in source pixels.
function cropui.handle_pos(id)
    local l, t = crop.x, crop.y
    local r, b = crop.x + crop.w, crop.y + crop.h
    local mx, my = (l + r) / 2, (t + b) / 2
    if id == "nw" then return l, t end
    if id == "n"  then return mx, t end
    if id == "ne" then return r, t end
    if id == "e"  then return r, my end
    if id == "se" then return r, b end
    if id == "s"  then return mx, b end
    if id == "sw" then return l, b end
    return l, my
end

-- What the pointer is over: a handle name, "move" for the inside of the box,
-- or nil for the picture around it.
function cropui.hit(ox, oy)
    if not crop.editing then return nil end
    local tol = 11 * effective_scale()
    for _, id in ipairs(cropui.HANDLES) do
        local hx, hy = cropui.handle_pos(id)
        local sx, sy = cropui.to_osd(hx, hy)
        if sx and math.abs(ox - sx) <= tol and math.abs(oy - sy) <= tol then return id end
    end
    local x0, y0 = cropui.to_osd(crop.x, crop.y)
    local x1, y1 = cropui.to_osd(crop.x + crop.w, crop.y + crop.h)
    if x0 and ox >= x0 and ox <= x1 and oy >= y0 and oy <= y1 then return "move" end
    return nil
end

function cropui.grab(mode, ox, oy)
    local px, py = cropui.to_src(ox, oy)
    if not px then return end
    cropui.drag = { mode = mode, px = px, py = py,
                       x = crop.x, y = crop.y, w = crop.w, h = crop.h }
end

-- Resizing anchors the side you are not holding: drag the west handle and the
-- east edge stays where it is. With a ratio locked the other axis follows,
-- centred on the axis the handle does not move along.
function cropui.drag_to(ox, oy)
    if not cropui.drag then return end
    local px, py = cropui.to_src(ox, oy)
    if not px then return end
    local d = cropui.drag
    local dx, dy = px - d.px, py - d.py

    if d.mode == "move" then
        crop.x, crop.y = d.x + dx, d.y + dy
        cropui.clamp()
    else
        local m = d.mode
        local l, t, r, b = d.x, d.y, d.x + d.w, d.y + d.h
        if m:find("w") then l = math.min(d.x + dx, r - cropui.MIN) end
        if m:find("e") then r = math.max(d.x + d.w + dx, l + cropui.MIN) end
        if m:find("n") then t = math.min(d.y + dy, b - cropui.MIN) end
        if m:find("s") then b = math.max(d.y + d.h + dy, t + cropui.MIN) end
        l, t = math.max(0, l), math.max(0, t)
        r, b = math.min(crop.src_w, r), math.min(crop.src_h, b)

        if crop.rw > 0 and crop.rh > 0 then
            local ar = crop.rw / crop.rh
            local w, h = r - l, b - t
            if m == "n" or m == "s" then w = h * ar else h = w / ar end
            if w > crop.src_w then w = crop.src_w; h = w / ar end
            if h > crop.src_h then h = crop.src_h; w = h * ar end
            if m:find("w") then l = r - w
            elseif m:find("e") then r = l + w
            else l = (l + r) / 2 - w / 2; r = l + w end
            if m:find("n") then t = b - h
            elseif m:find("s") then b = t + h
            else t = (t + b) / 2 - h / 2; b = t + h end
            -- Re-anchoring can push the box off the frame; slide it back whole
            -- rather than squashing it out of ratio.
            if l < 0 then r = r - l; l = 0 end
            if t < 0 then b = b - t; t = 0 end
            if r > crop.src_w then l = l - (r - crop.src_w); r = crop.src_w end
            if b > crop.src_h then t = t - (b - crop.src_h); b = crop.src_h end
        end

        crop.x, crop.y, crop.w, crop.h = l, t, r - l, b - t
        cropui.clamp()
    end
    publish_crop()
    render()
end

function cropui.release()
    if not cropui.drag then return false end
    cropui.drag = nil
    publish_crop()
    render()
    return true
end

local function crop_center()
    if not (crop.on or crop.editing) then return end
    crop.x = even_px((crop.src_w - crop.w) / 2)
    crop.y = even_px((crop.src_h - crop.h) / 2)
    if crop.editing then
        cropui.clamp(); publish_crop(); render()
    else
        apply_crop_vf(false)
    end
    emit("Crop centered", 1.2)
end

-- Works on the box while it is being adjusted and on the applied crop
-- otherwise, so Alt+Arrows mean the same thing either side of Apply.
local function crop_nudge(dx, dy)
    if not (crop.on or crop.editing) then return end
    crop.x = crop.x + dx
    crop.y = crop.y + dy
    if crop.editing then
        cropui.clamp(); publish_crop(); render()
    else
        apply_crop_vf(false)
    end
end

-- Dragging the picture moves the *source* under a fixed window, so a
-- drag to the right decreases crop x (more of the left of the frame).
local crop_drag = nil

local function crop_drag_begin(x, y)
    crop_drag = { x = x, y = y, cx = crop.x, cy = crop.y, moved = false }
end

local function crop_drag_to(x, y)
    if not crop_drag or not crop.on then return end
    local d = mp.get_property_native("osd-dimensions")
    if not d or not d.w then return end
    local vis_w = d.w - (d.ml or 0) - (d.mr or 0)
    local vis_h = d.h - (d.mt or 0) - (d.mb or 0)
    if vis_w < 1 or vis_h < 1 then return end
    local sx = vis_w / crop.w
    local sy = vis_h / crop.h
    crop.x = crop_drag.cx - (x - crop_drag.x) / sx
    crop.y = crop_drag.cy - (y - crop_drag.y) / sy
    if math.abs(x - crop_drag.x) > 3 or math.abs(y - crop_drag.y) > 3 then
        crop_drag.moved = true
    end
    local now = mp.get_time()
    if now - crop.last_vf < 0.03 then
        clamp_crop_origin()
        publish_crop()
        return
    end
    apply_crop_vf(false)
end

mp.register_script_message("mi-crop-aspect", function(rw, rh, label)
    set_crop_aspect(rw, rh, label)
end)
mp.register_script_message("mi-crop-clear", function()
    crop.editing = false
    crop.saved = nil
    clear_crop(false)
    render()
end)
mp.register_script_message("mi-crop-edit", function() cropui.toggle() end)

-- Typed numbers from the panel land here, so a hand-entered rect is the same
-- state the box and the ratio buttons drive - one crop, one owner.
mp.register_script_message("mi-crop-rect", function(w, h, x, y)
    local sw, sh = decoder_size()
    if sw < 2 or sh < 2 then emit("No video size to crop yet", 2) return end
    w, h = tonumber(w) or 0, tonumber(h) or 0
    if w < cropui.MIN or h < cropui.MIN then emit("Crop size is too small", 2) return end
    crop.editing = false
    crop.saved = nil
    crop.src_w, crop.src_h = sw, sh
    crop.rw, crop.rh, crop.label = 0, 0, ""
    crop.w, crop.h = w, h
    crop.x, crop.y = tonumber(x) or 0, tonumber(y) or 0
    cropui.clamp()
    crop.w, crop.h = even_px(crop.w), even_px(crop.h)
    crop.on = true
    apply_crop_vf(true)
    render()
end)
mp.register_script_message("mi-crop-center", function() crop_center() end)
mp.register_script_message("mi-crop-nudge", function(dx, dy)
    crop_nudge(tonumber(dx) or 0, tonumber(dy) or 0)
end)

local function apply_shaders()
    mp.commandv("change-list", "glsl-shaders", "clr", "")
    local list = setting("shaders", "")
    if list == "" then return 0 end
    local n = 0
    for p in list:gmatch("[^,]+") do
        p = p:gsub("^%s+", ""):gsub("%s+$", "")
        if p ~= "" then
            mp.commandv("change-list", "glsl-shaders", "append", p)
            n = n + 1
        end
    end
    return n
end

-- Mode shaders are not in the checkbox list (filenames start with Upscale-).
-- Forward slashes are fine on Windows and match how mpv resolves config-dir.
local UPSCALE_SHADERS = {
    cnn = "Upscale-ArtCNN.glsl",
    fsr = "Upscale-FSR.glsl",
}

local function append_mode_shader(mode)
    local name = UPSCALE_SHADERS[mode]
    if not name then return false end
    local dir = mp.get_property("config-dir") or ""
    mp.commandv("change-list", "glsl-shaders", "append", dir .. "/shaders/" .. name)
    return true
end

-- RTX Video Super Resolution is a D3D11 video-processor stage, so it only
-- sees frames still living on the GPU as D3D11 textures. mpv.conf asks for
-- hwdec=auto-safe, which on this machine settles on d3d11va-COPY: those
-- frames are read back to system RAM and the filter has nothing to work
-- with. So the mode owns the decode path while it is on, and hands it back
-- when it is turned off.
--
-- The pool size has to come down with it. Direct decode allocates one fixed
-- texture array, and the 256-frame pool mpv.conf asks for (which exists so
-- reverse playback can hold a whole keyframe range) blows past what D3D11
-- will allocate: the decoder fails with "Static surface pool size exceeded"
-- and silently drops to software. Measured on a 4060 Ti.
-- Matches hwdec in mpv.conf. Restoring to anything else would quietly leave
-- decoding worse than it was found.
local HWDEC_DEFAULT = "auto"
local HWDEC_FRAMES_DEFAULT = 256
local HWDEC_FRAMES_DIRECT = 16
-- Only RTX is here. scale_cuda and the libplacebo avfilter were both tried:
-- CUDA frames cannot be imported by the D3D11 renderer at all, and under
-- the Vulkan renderer both filters loaded, reported themselves enabled, and
-- left the frame at its original size. Neither is shipped as an option
-- rather than pretending to upscale.
local UPSCALE_HWDEC = { rtx = "d3d11va" }

local function restore_hwdec()
    if mp.get_property("hwdec") ~= HWDEC_DEFAULT then
        mp.set_property_number("hwdec-extra-frames", HWDEC_FRAMES_DEFAULT)
        mp.set_property("hwdec", HWDEC_DEFAULT)
    end
end

-- Switching hwdec re-initialises the decoder asynchronously, and how long
-- that takes depends on where the playhead is and how big the next keyframe
-- range is. A fixed sleep guessed wrong often enough to matter (measured:
-- the filter went on while hwdec-current still read "no", so it attached to
-- nothing), so the request is parked and fired by the property itself.
local pending_up = nil

local function add_gpu_filter(mode, quiet)
    local want = UPSCALE_HWDEC[mode]
    local cur = mp.get_property("hwdec-current") or "no"
    if cur ~= want then
        restore_hwdec()
        if not quiet then
            emit(string.format("RTX upscaling needs the direct %s decode path; this source ended up on %s. Left off.",
                want, cur), 4)
        end
        return
    end

    local factor = setting_num("upscale_factor", 2)
    local hdr = setting_bool("rtx_hdr", false)
    local opts = string.format("d3d11vpp=scaling-mode=nvidia:scale=%g", factor)
    if hdr then opts = opts .. ":nvidia-true-hdr=yes" end
    local label = string.format("RTX Video Super Resolution ON (%gx%s)", factor,
        hdr and " + RTX Video HDR" or "")

    if not mp.commandv("vf", "add", "@" .. UPSCALE_LABEL .. ":" .. opts) then
        restore_hwdec()
        if not quiet then emit("The driver rejected RTX Video Super Resolution - left off", 3) end
        return
    end
    if not quiet then emit(label, 2.5) end
end

mp.observe_property("hwdec-current", "string", function(_, v)
    if not pending_up then return end
    if v ~= UPSCALE_HWDEC[pending_up.mode] then return end
    local pu = pending_up
    pending_up = nil
    add_gpu_filter(pu.mode, pu.quiet)
end)

local function apply_upscale(quiet)
    local mode = setting("upscale", "off")
    pending_up = nil
    clear_upscale_filter()
    apply_shaders()

    local want = UPSCALE_HWDEC[mode]
    if want then
        if is_photo() then
            restore_hwdec()
            fit_window()
            if not quiet then emit("RTX needs a video source - use CNN 2x or FSR for photos", 3) end
            return
        end
        if is_audio() then restore_hwdec(); fit_window(); return end

        -- The D3D11 video processor is reachable only from the D3D11
        -- renderer; under Vulkan there is no such stage to attach to.
        local api = mp.get_property("gpu-api")
        if api ~= nil and api ~= "d3d11" and api ~= "auto" then
            if not quiet then
                emit("RTX Video Super Resolution needs the D3D11 renderer - switch it back in the control panel's Upscale section", 5)
            end
            return
        end

        if mp.get_property("hwdec-current") == want then
            add_gpu_filter(mode, quiet)
            return
        end

        pending_up = { mode = mode, quiet = quiet }
        -- Pool size first: it is only read when the decoder re-inits, which
        -- is exactly what changing hwdec triggers.
        mp.set_property_number("hwdec-extra-frames", HWDEC_FRAMES_DIRECT)
        mp.set_property("hwdec", want)
        mp.add_timeout(4.0, function()
            if not pending_up then return end
            local pu = pending_up
            pending_up = nil
            add_gpu_filter(pu.mode, pu.quiet)   -- reports why it did not take
        end)
        return
    end

    restore_hwdec()

    if UPSCALE_SHADERS[mode] then
        if is_audio() then
            if not quiet then emit("No picture to upscale", 2) end
            return
        end
        append_mode_shader(mode)
        -- Grow the window so the extra luma has somewhere to land. On a
        -- display that cannot fit it, fit_window caps and the CNN still
        -- reconstructs (its WHEN also fires on sub-1600p sources).
        fit_window()
        if not quiet then
            local factor = setting_num("upscale_factor", 2)
            if mode == "cnn" then
                emit(string.format("CNN 2x (ArtCNN) ON  %gx window  - reconstruction for low-res / compressed sources",
                    factor), 2.5)
            else
                emit(string.format("FSR (spatial) ON  %gx window", factor), 2.5)
            end
        end
        return
    end

    -- Off: put the window back to native size if a shader mode had grown it.
    fit_window()
    if not quiet then
        local n = 0
        for _ in setting("shaders", ""):gmatch("[^,]+") do n = n + 1 end
        if n > 0 then
            emit(string.format("GPU upscaler off - %d shader%s active", n, n == 1 and "" or "s"), 2)
        else
            emit("GPU upscaling off", 1.5)
        end
    end
end

-- Cycles the four routes from the keyboard, so it is reachable without the
-- control panel open. CNN is first after off: that is the one that helps
-- a soft 1080p doorbell cam, which is why this binding exists.
local function upscale_cycle()
    local order = { "off", "cnn", "fsr", "rtx" }
    local cur = setting("upscale", "off")
    local idx = 1
    for i, m in ipairs(order) do if m == cur then idx = i end end
    mp.set_property("user-data/mi/set_upscale", order[(idx % #order) + 1])
    apply_upscale(false)
end

-- ============================================================
-- Export -> <player>\Exports
--   One path for all three kinds: the screenshot is taken from the decoded,
--   filtered frame ("video" mode), so crop, colour adjustments and any
--   active upscaler are already baked into what lands on disk - and a photo
--   is just a one-frame video as far as this is concerned.
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

-- sws flag names, keyed by the control panel's dropdown. Lanczos is the
-- default because a plain `scale=` uses bilinear, which throws away exactly
-- the detail an export is meant to preserve.
local SCALERS = {
    lanczos = "lanczos+accurate_rnd+full_chroma_int",
    spline  = "spline+accurate_rnd+full_chroma_int",
    bicubic = "bicubic+accurate_rnd+full_chroma_int",
    neighbor = "neighbor",
}

local function export_frame()
    local path = mp.get_property("path")
    if not path then emit("No file loaded", 1.5) return end
    if is_audio() then
        emit("Nothing to export from an audio-only file", 2)
        return
    end

    local dir = setting("export_dir", nil)
    if dir == nil or dir == "" then dir = export_dir(); ensure_exports() end
    local fmt = setting("export_format", "jpg")
    local scale = setting_num("export_scale", 100)
    local algo = SCALERS[setting("export_scaler", "lanczos")] or SCALERS.lanczos

    local filename = path:match("([^\\/]+)$") or path
    local base = filename:gsub("%.[^.]+$", "")

    local out_name
    if is_photo() then
        out_name = string.format("%s_export_%s.%s", base, os.date("%H%M%S"), fmt)
    else
        local frame_num = mp.get_property_number("estimated-frame-number") or 0
        local t = mp.get_property_number("time-pos") or 0
        local tc = string.format("%02d.%02d.%02d.%03d",
            math.floor(t / 3600), math.floor((t % 3600) / 60), math.floor(t % 60),
            math.floor((t - math.floor(t)) * 1000))
        out_name = string.format("%s_frame%06d_%s.%s", base, frame_num, tc, fmt)
    end
    out_name = out_name:gsub('[<>:"/\\|?*]', "_")
    local out_path = dir .. "\\" .. out_name

    -- "video" = the raw decoded, filtered frame at its native resolution,
    -- with no OSD burned in.
    local function grab()
        mp.set_property("screenshot-format", fmt)
        mp.commandv("screenshot-to-file", out_path, "video")
        local w = mp.get_property_number("video-out-params/w") or MEDIA.w
        local h = mp.get_property_number("video-out-params/h") or MEDIA.h
        emit(string.format("Exported %s  (%s, %dx%d)", out_name, fmt:upper(), w, h), 2.5)
    end

    if scale == 100 or scale <= 0 then
        grab()
        return
    end

    -- Resolution is applied by temporarily adding a filter, so what lands on
    -- disk is the real resampled frame rather than a post-hoc resize. A bare
    -- `scale=` uses bilinear, which throws away exactly the detail an export
    -- exists to preserve, hence the explicit flags.
    local want_w = math.floor(MEDIA.w * scale / 100 + 0.5)
    mp.commandv("vf", "add", "@miexport:" ..
        string.format("scale=w=iw*%f:h=ih*%f:flags=%s", scale / 100, scale / 100, algo))

    -- The chain rebuild is asynchronous: grabbing straight after the add
    -- captured the frame the OLD chain had already produced, so a "200%"
    -- export silently wrote at 100%. Wait for the output size to actually
    -- change before taking the shot.
    local tries = 0
    local function when_ready()
        tries = tries + 1
        local w = mp.get_property_number("video-out-params/w") or 0
        if math.abs(w - want_w) <= 2 or tries > 20 then
            if tries > 20 then
                emit(string.format("Export resampler never took effect - saving at %dx%d instead",
                    mp.get_property_number("video-out-params/w") or MEDIA.w,
                    mp.get_property_number("video-out-params/h") or MEDIA.h), 3)
            end
            grab()
            mp.commandv("vf", "remove", "@miexport")
            return
        end
        mp.add_timeout(0.1, when_ready)
    end
    mp.add_timeout(0.1, when_ready)
end

-- ============================================================
-- Media info
-- ============================================================

local function human_bytes(n)
    if not n or n <= 0 then return "?" end
    local units = { "B", "KB", "MB", "GB", "TB" }
    local i = 1
    while n >= 1024 and i < #units do n = n / 1024; i = i + 1 end
    if i <= 2 then return string.format("%.0f %s", n, units[i]) end
    return string.format("%.1f %s", n, units[i])
end

local function meta(key)
    local v = mp.get_property("metadata/by-key/" .. key)
    if v == nil or v == "" then return nil end
    return v
end

local function media_info()
    local lines = {}
    local path = mp.get_property("path")
    if not path then return { "No file loaded" } end
    lines[#lines + 1] = mp.get_property("filename") or path
    lines[#lines + 1] = string.format("%s  |  %s  |  %s",
        MEDIA.kind:upper(), (MEDIA.ext ~= "" and MEDIA.ext:upper() or "?"),
        human_bytes(mp.get_property_number("file-size")))

    if MEDIA.w > 0 then
        local mp_count = MEDIA.w * MEDIA.h / 1e6
        lines[#lines + 1] = string.format("%dx%d  (%.1f MP)  %s  %s",
            MEDIA.w, MEDIA.h,
            mp_count,
            mp.get_property("video-params/pixelformat") or "?",
            mp.get_property("video-params/gamma") or "")
        lines[#lines + 1] = string.format("primaries %s  |  colormatrix %s  |  %s levels",
            mp.get_property("video-params/primaries") or "?",
            mp.get_property("video-params/colormatrix") or "?",
            mp.get_property("video-params/colorlevels") or "?")
    end

    local vc = mp.get_property("video-codec")
    if vc then
        lines[#lines + 1] = "Video: " .. vc ..
            (is_video() and string.format("  |  %.3f fps", source_fps or detect_fps() or 0) or "")
    end
    local ac = mp.get_property("audio-codec")
    if ac then
        lines[#lines + 1] = string.format("Audio: %s  |  %s Hz  |  %s", ac,
            mp.get_property("audio-params/samplerate") or "?",
            mp.get_property("audio-params/channel-count") or "?")
    end

    local title, artist = meta("title"), meta("artist")
    if title or artist then
        lines[#lines + 1] = string.format("%s%s", title or "",
            artist and ("  -  " .. artist) or "")
    end
    local made = meta("creation_time") or meta("date")
    if made then lines[#lines + 1] = "Created: " .. made end

    lines[#lines + 1] = "Decode: " ..
        (hw_decoding() and ("hardware (" .. mp.get_property("hwdec-current") .. ")") or "software (CPU)")
    return lines
end

local function show_info()
    emit(table.concat(media_info(), "\n"), 6)
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
-- Sibling media navigation
--   Two scopes, because a folder of takes is usually not only takes: by
--   default the arrows and the << >> buttons walk video and nothing else,
--   so stills, thumbnails and sidecar audio do not get paged through. The
--   other scope is every supported file, which browses a mixed folder as
--   one sequence. Assigned below, once save_state() exists to persist it.
-- ============================================================

local browse_all = false
local browse_scope_toggle

local function sibling_list(dir)
    local allowed = browse_all and EXT_ALL or EXT_VIDEO
    local files = {}
    for _, f in ipairs(utils.readdir(dir, "files") or {}) do
        local e = ext_of(f)
        if e and allowed[e] then files[#files + 1] = f end
    end
    table.sort(files, function(a, b) return a:lower() < b:lower() end)
    return files
end

local function play_sibling(offset)
    local path = mp.get_property("path")
    if not path then emit("No file loaded", 1.5) return end
    local dir, filename = path:match("^(.*)[\\/]([^\\/]+)$")
    if not dir then emit("Cannot resolve folder", 1.5) return end

    local files = sibling_list(dir)
    if #files == 0 then
        emit(browse_all and "No other media in this folder"
                         or "No video in this folder - press b to browse everything", 2.5)
        return
    end

    -- The open file need not be in the list at all: it is a photo, say, while
    -- the scope is video only. Step from where it would sort rather than from
    -- a hardcoded index 1, which always jumped to the top of the folder.
    local idx, before = nil, 0
    local key = filename:lower()
    for i, f in ipairs(files) do
        if f == filename then idx = i break end
        if f:lower() < key then before = i end
    end

    local new_idx
    if idx then
        new_idx = ((idx - 1 + offset) % #files) + 1
    elseif offset >= 0 then
        new_idx = (before % #files) + 1
    else
        new_idx = before == 0 and #files or before
    end
    mp.commandv("loadfile", dir .. "\\" .. files[new_idx], "replace")
    emit(string.format("(%d/%d) %s", new_idx, #files, files[new_idx]), 1.5)
end

local function next_media() play_sibling(1) end
local function prev_media() play_sibling(-1) end

-- ============================================================
-- Control bar
-- ============================================================

-- ASS is SDR. On an HDR swapchain, translucent greys wash out; keep the bar
-- nearly opaque and the text fully white so it still reads against PQ video.
-- Every colour here is the matching entry from Theme in src/MainForm.cs, so
-- the bar over the picture and the cards beside it are one palette. ASS wants
-- &HBBGGRR&, the reverse of the RGB byte order used there - photo, audio and
-- HDR had been transcribed straight across and so rendered as each other's
-- opposite: the photo accent came out blue and the audio one yellow.
local COL_BG        = "&H1E1818&"  -- CardBg         24,  24,  30
local COL_BTN       = "&H2C2424&"  -- button face    36,  36,  44
local COL_BORDER    = "&H423636&"  -- card border    54,  54,  66
local COL_TRACK     = "&H322A2A&"  -- slider track   42,  42,  50
local COL_TEXT      = "&HFFFFFF&"
local COL_DIM       = "&H968C8C&"  -- Dim           140, 140, 150
local COL_TEXT_DARK = "&H141010&"  -- text on accent  16,  16,  20
local COL_YELLOW, COL_BLUE, COL_GREEN = "&H00D0FF&", "&HFF9838&", "&H78D040&"
local COL_PHOTO, COL_AUDIO = "&H58A8F0&", "&HF0C858&"
local COL_HDR = "&HFF5AD2&"
local COL_ACCENT = COL_YELLOW

-- Win11Card rounds at 8px and Win11Button at 6px; kept in unscaled units
-- here so the bar's corners stay the panel's corners at any UI scale.
local R_CARD, R_BTN = 8, 6

-- Shuttle range. One constant so the drawing, the slider and the wheel all
-- agree on what the far end of the track means.
local SHUTTLE_MAX = 3.0

local help_visible = false
local last_mb, last_mt = -1, -1

local SHORTCUTS = {
    { "Left / Right  or  < / >  or  PgUp / PgDn", "Previous / next file in folder" },
    { "b", "Browse videos only / every media file" },
    { "Shift+Left / Shift+Right", "Step one frame" },
    { "s", "Slow-mo conform (video)" },
    { "e", "Export frame / image to Exports" },
    { "i", "Media info" },
    { "u", "Cycle GPU upscaler (CNN / FSR / RTX)" },
    { "z  /  x", "Zoom to fit  /  zoom 1:1" },
    { "r  /  Shift+R", "Rotate right / left" },
    { "w", "Fit the window to the media again" },
    { "Ctrl+H", "Toggle HDR (force SDR / allow HDR)" },
    { "Ctrl+A", "Sound settings" },
    { "9 / 0   m   a", "Volume, mute, audio track" },
    { "[ / ]   Backspace", "Speed nudge, reset speed" },
    { "Space   f", "Play/pause, fullscreen" },
    { "Ctrl+= / Ctrl+- / Ctrl+0", "UI scale up / down / reset" },
    { "h  /  F1", "Toggle this panel" },
    { "Wheel", "Video: shuttle speed.  Photo: zoom" },
    { "Ctrl+Wheel   Drag", "Zoom   /   pan a zoomed image" },
    { "c", "Adjust the crop on the picture" },
    { "Enter / Esc  (adjusting)", "Apply the crop / cancel" },
    { "Drag (crop on)", "Move the full frame inside the crop" },
    { "Alt+Arrows", "Nudge crop position" },
}

local function kind_tier()
    if is_photo() then return "photo", COL_PHOTO end
    if is_audio() then return "audio", COL_AUDIO end
    local fps = source_fps
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

local function round_rect(ass, x0, y0, x1, y1, r, colour, alpha)
    if x1 <= x0 or y1 <= y0 then return end
    ass:new_event()
    ass:pos(0, 0)
    ass:append(string.format("{\\an7\\bord0\\shad0\\1c%s\\1a%s}", colour, alpha or "&H00&"))
    ass:draw_start()
    if ass.round_rect_cw and r and r > 0 then
        ass:round_rect_cw(x0, y0, x1, y1, r)
    else
        ass:rect_cw(x0, y0, x1, y1)
    end
    ass:draw_stop()
end

local function glass_border(ass, x0, y0, x1, y1, r, colour, alpha, width)
    if x1 <= x0 or y1 <= y0 then return end
    ass:new_event()
    ass:pos(0, 0)
    ass:append(string.format("{\\an7\\bord%.2f\\shad0\\3c%s\\3a%s\\1a&HFF&}",
        width or 1, colour or "&HFFFFFF&", alpha or "&HC0&"))
    ass:draw_start()
    if ass.round_rect_cw and r and r > 0 then
        ass:round_rect_cw(x0, y0, x1, y1, r)
    else
        ass:rect_cw(x0, y0, x1, y1)
    end
    ass:draw_stop()
end

-- Segoe UI is named explicitly: mpv would otherwise fall back to its generic
-- sans and the bar would not be set in the face the control cards use.
local function text(ass, x, y, align, size, colour, str)
    ass:new_event()
    ass:pos(x, y)
    ass:append(string.format(
        "{\\an%d\\bord2.2\\shad0\\3c&H000000&\\3a&H20&\\fnSegoe UI\\fs%d\\1c%s}%s",
        align, math.floor(size + 0.5), colour, str))
end

local function clamp(v, lo, hi) return math.max(lo, math.min(hi, v)) end

-- The panel's sliders draw a white disc ringed in the accent colour
-- (Win11Slider.OnPaint); every thumb on the bar is that same object.
local function thumb(ass, x, y, r, colour)
    round_rect(ass, x - r, y - r, x + r, y + r, r, COL_TEXT, "&H00&")
    glass_border(ass, x - r, y - r, x + r, y + r, r, colour or COL_ACCENT, "&H00&", 2)
end

-- Playback rate as one signed number: negative is reverse, zero is paused.
-- The shuttle, the wheel and the keyboard all read and write it through
-- these two, so they cannot drift apart on what "0.5x backward" means.
local function signed_speed()
    if mp.get_property_bool("pause") then return 0 end
    local sp = mp.get_property_number("speed") or 1.0
    return (mp.get_property("play-direction") == "backward") and -sp or sp
end

local function apply_signed_speed(speed)
    speed = clamp(speed, -SHUTTLE_MAX, SHUTTLE_MAX)
    if math.abs(speed) < 0.05 then          -- snap to a clean stop
        mp.set_property_bool("pause", true)
        mp.set_property_number("speed", 1.0)
        return
    end
    local dir = speed < 0 and "backward" or "forward"
    if dir ~= (mp.get_property("play-direction") or "forward") then
        mp.set_property("play-direction", dir)
    end
    mp.set_property_number("speed", math.abs(speed))
    mp.set_property_bool("pause", false)
end

local function inside(b, x, y) return x >= b[1] and x <= b[3] and y >= b[2] and y <= b[4] end

local function toggle_help()
    -- With the panel open the shortcut list lives there permanently, so
    -- don't also cover the media with the overlay version of it.
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
    local pw = math.min(w * 0.94, 820 * S)
    local ph = pad * 2 + row_h * (#SHORTCUTS + 1)
    local x0, y0 = (w - pw) / 2, math.max(8, (h - ph) / 2)

    rect(ass, 0, 0, w, h, "&H000000&", "&H99&")
    round_rect(ass, x0, y0, x0 + pw, y0 + ph, R_CARD * S, COL_BG, "&H08&")
    glass_border(ass, x0, y0, x0 + pw, y0 + ph, R_CARD * S, COL_BORDER, "&H20&")
    text(ass, x0 + pad, y0 + pad, 7, fs + 3, COL_ACCENT, "Shortcuts   (click anywhere to close)")
    for i, r in ipairs(SHORTCUTS) do
        local y = y0 + pad + row_h * i
        text(ass, x0 + pad, y, 7, fs, COL_ACCENT, r[1])
        text(ass, x0 + pad + pw * 0.44, y, 7, fs, COL_TEXT, r[2])
    end
end

-- The crop box, drawn over the picture while the adjust mode is on. Source
-- pixels are the state; everything here is that state mapped to the screen.
function cropui.draw(ass, S)
    local vx0, vy0, vx1, vy1 = cropui.video_rect()
    if not vx0 then return end
    local x0, y0 = cropui.to_osd(crop.x, crop.y)
    local x1, y1 = cropui.to_osd(crop.x + crop.w, crop.y + crop.h)
    if not x0 or not x1 then return end

    -- Dimming what falls outside, in four pieces, leaves the frame you are
    -- keeping as the only part of the picture at full brightness.
    rect(ass, vx0, vy0, vx1, y0, "&H000000&", "&H90&")
    rect(ass, vx0, y1, vx1, vy1, "&H000000&", "&H90&")
    rect(ass, vx0, y0, x0, y1, "&H000000&", "&H90&")
    rect(ass, x1, y0, vx1, y1, "&H000000&", "&H90&")

    -- Thirds, the way a camera's guide grid draws them.
    for i = 1, 2 do
        local gx = x0 + (x1 - x0) * i / 3
        local gy = y0 + (y1 - y0) * i / 3
        rect(ass, gx - 0.5 * S, y0, gx + 0.5 * S, y1, "&HFFFFFF&", "&HB0&")
        rect(ass, x0, gy - 0.5 * S, x1, gy + 0.5 * S, "&HFFFFFF&", "&HB0&")
    end

    glass_border(ass, x0, y0, x1, y1, 0, COL_ACCENT, "&H00&", 2)

    local k = 5 * S
    for _, id in ipairs(cropui.HANDLES) do
        local hx, hy = cropui.handle_pos(id)
        local ox, oy = cropui.to_osd(hx, hy)
        if ox then
            round_rect(ass, ox - k, oy - k, ox + k, oy + k, 2 * S, COL_TEXT, "&H00&")
            glass_border(ass, ox - k, oy - k, ox + k, oy + k, 2 * S, COL_ACCENT, "&H00&", 2)
        end
    end

    -- The size sits above the box, or inside it when the box is against the
    -- top of the frame and there is no room left over the picture.
    local label = string.format("%d x %d   %s", even_px(crop.w), even_px(crop.h),
        crop.rw > 0 and crop.label or "free")
    local ly, align = y0 - 8 * S, 2
    if ly < (STATUS_H + 6) * S then ly, align = y0 + 8 * S, 8 end
    text(ass, (x0 + x1) / 2, ly, align, 13 * S, COL_TEXT, label)
end

-- Audio has no picture, so the empty frame gets the file's identity instead
-- of a black rectangle. Cover art, when the file has any, is a real video
-- track and draws itself - this only fills in around it.
local function draw_audio_face(ass, w, h, S, top, bottom)
    local title = meta("title") or (mp.get_property("filename") or "")
    local artist = meta("artist") or meta("album_artist")
    local album = meta("album")
    local cy = (top + bottom) / 2
    text(ass, w / 2, cy - 18 * S, 5, 22 * S, COL_ACCENT, title)
    if artist then text(ass, w / 2, cy + 12 * S, 5, 15 * S, COL_TEXT, artist) end
    if album then text(ass, w / 2, cy + 36 * S, 5, 13 * S, COL_DIM, album) end
end

local function upscale_label()
    local m = setting("upscale", "off")
    if m == "rtx" then return "RTX", true end
    if m == "cnn" then return "CNN", true end
    if m == "fsr" then return "FSR", true end
    local n = 0
    for _ in setting("shaders", ""):gmatch("[^,]+") do n = n + 1 end
    if n > 0 then return "GLSL", true end
    return "Up", false
end

-- Speed shuttle: reverse at the left, forward at the right, a detent at the
-- centre for a standstill, and a tick at the speed a slow-mo conform would
-- pick - the clip's "correct" rate, there to aim at.
local function draw_shuttle(ass, x0, x1, cy, S, signed)
    local trk, k = 5 * S, 6 * S
    local mid, half = (x0 + x1) / 2, (x1 - x0) / 2
    round_rect(ass, x0, cy - trk / 2, x1, cy + trk / 2, trk / 2, COL_TRACK, "&H10&")
    round_rect(ass, mid - 1 * S, cy - trk, mid + 1 * S, cy + trk, 1 * S, COL_DIM, "&H00&")

    local fps_val = source_fps or detect_fps() or 30
    local conform = fps_val > 0 and (target_fps() / fps_val) or 1.0
    local def_x = mid + half * clamp(conform / SHUTTLE_MAX, -1, 1)
    round_rect(ass, def_x - 1.5 * S, cy - trk, def_x + 1.5 * S, cy + trk, 1 * S, COL_ACCENT, "&H50&")

    -- Fills out from the detent rather than from the left end, the way the
    -- panel's centre-zero sliders do.
    local tx = mid + half * clamp(signed / SHUTTLE_MAX, -1, 1)
    round_rect(ass, math.min(mid, tx), cy - trk / 2, math.max(mid, tx), cy + trk / 2,
        trk / 2, COL_ACCENT, "&H00&")
    thumb(ass, tx, cy, k)
end

render = function()
    local w, h = mp.get_osd_size()
    if not w or w <= 0 or not h or h <= 0 then return end
    ui.osd_w, ui.osd_h = w, h
    ui.buttons = {}

    local S = effective_scale()
    local bar_h, margin = BAR_H * S, MARGIN * S
    local status_h, sub_h = STATUS_H * S, SUBBAR_H * S
    local tier_name, tier_colour = kind_tier()
    COL_ACCENT = tier_colour

    mp.set_property_native("user-data/mi/ui_scale", S)
    mp.set_property("user-data/mi/tier", tier_name)

    -- Reserve real space so the bar never covers the picture.
    local mb, mt = (bar_h + sub_h) / h, status_h / h
    if math.abs(mb - last_mb) > 0.002 then
        mp.set_property_number("video-margin-ratio-bottom", mb); last_mb = mb
    end
    if math.abs(mt - last_mt) > 0.002 then
        mp.set_property_number("video-margin-ratio-top", mt); last_mt = mt
    end

    local ass = assdraw.ass_new()
    local sub_y0, sub_y1 = h - bar_h - sub_h, h - bar_h
    local by0, by1 = h - bar_h, h

    -- The dock is Win11Card at OSD scale: the same fill, the same one-pixel
    -- border in the same colour, and the same specular line along the top.
    local dock_pad = 6 * S
    local dock_y = sub_y0 - 2 * S
    round_rect(ass, dock_pad, dock_y, w - dock_pad, h - 3 * S, R_CARD * S, COL_BG, "&H14&")
    glass_border(ass, dock_pad, dock_y, w - dock_pad, h - 3 * S, R_CARD * S, COL_BORDER, "&H20&")
    round_rect(ass, dock_pad + R_CARD * S, dock_y, w - dock_pad - R_CARD * S, dock_y + 1 * S,
        0, "&HFFFFFF&", "&HE0&")

    if is_audio() then draw_audio_face(ass, w, h, S, status_h, sub_y0) end
    if crop.editing then cropui.draw(ass, S) end

    local dur = mp.get_property_number("duration") or 0
    local pos = mp.get_property_number("time-pos") or 0
    local paused = mp.get_property_bool("pause")
    local muted = mp.get_property_bool("mute")
    local vol = mp.get_property_number("volume") or 0

    local cy0, cy1 = by0 + 6 * S, by1 - 6 * S
    local fs = 14 * S
    local gap = 5 * S

    local lx = margin
    local function left(bw, label, active, fn)
        local x0, x1 = lx, lx + bw
        lx = x1 + gap
        local btn_r = R_BTN * S
        round_rect(ass, x0, cy0, x1, cy1, btn_r, active and COL_ACCENT or COL_BTN, active and "&H00&" or "&H10&")
        glass_border(ass, x0, cy0, x1, cy1, btn_r, active and COL_ACCENT or COL_BORDER, "&H20&")
        text(ass, (x0 + x1) / 2, (cy0 + cy1) / 2, 5, fs, active and COL_TEXT_DARK or COL_TEXT, label)
        ui.buttons[#ui.buttons + 1] = { x0, cy0, x1, cy1, fn }
    end

    local rx = w - margin
    local function right(bw, label, active, fn, colour)
        local x1, x0 = rx, rx - bw
        rx = x0 - gap
        local btn_r = R_BTN * S
        local ac = colour or COL_ACCENT
        round_rect(ass, x0, cy0, x1, cy1, btn_r, active and ac or COL_BTN, active and "&H00&" or "&H10&")
        glass_border(ass, x0, cy0, x1, cy1, btn_r, active and ac or COL_BORDER, "&H20&")
        text(ass, (x0 + x1) / 2, (cy0 + cy1) / 2, 5, fs, active and COL_TEXT_DARK or COL_TEXT, label)
        ui.buttons[#ui.buttons + 1] = { x0, cy0, x1, cy1, fn }
    end

    -- ---- left cluster ----
    if not is_photo() then
        left(58 * S, paused and "Play" or "Pause", false, function() mp.commandv("cycle", "pause") end)
    end
    if crop.editing then
        -- A mode is on, so the way out of it is the most prominent thing in
        -- the bar; the file-stepping buttons would only leave it by surprise.
        left(62 * S, "Apply", true, cropui.apply)
        left(66 * S, "Cancel", false, cropui.cancel)
        left(48 * S, "Full", false, cropui.full)
        local ratio_label = crop.rw > 0 and crop.label or "Free"
        left((#ratio_label * 8 + 18) * S, ratio_label, crop.rw > 0, cropui.cycle_ratio)
    else
        left(34 * S, "<<", false, prev_media)
        left(34 * S, ">>", false, next_media)
        local scope_label = browse_all and "All media" or "Videos"
        left((#scope_label * 8 + 18) * S, scope_label, browse_all,
            function() browse_scope_toggle() end)
        if is_photo() then
            left(44 * S, "Fit", false, zoom_fit)
            left(44 * S, "1:1", false, zoom_actual)
        end
        left(34 * S, "i", false, show_info)
        left(30 * S, "?", help_visible, toggle_help)
    end

    -- ---- right cluster ----
    local up_label, up_on = upscale_label()
    right(56 * S, up_label, up_on, upscale_cycle)

    local hdr_off = hdr_forced_off()
    local hdr_live = not hdr_off and media_is_hdr()
    -- Uses COL_HDR (not the kind accent) so the button's own colour carries
    -- the HDR state independent of whatever tier colour is active.
    right(56 * S, hdr_off and "HDR Off" or "HDR", hdr_live, hdr_toggle, COL_HDR)

    if is_photo() then
        right(72 * S, "Export", false, export_frame)
        right(40 * S, "Rot", false, function() rotate_by(90) end)
        if not crop.editing then right(52 * S, "Crop", crop.on, cropui.start) end
    elseif is_audio() then
        right(52 * S, muted and "Mute" or (math.floor(vol) .. "%"), muted,
            function() mp.commandv("cycle", "mute") end)
        right(66 * S, "Sound", false, audio_menu)
    else
        right(52 * S, muted and "Mute" or (math.floor(vol) .. "%"), muted,
            function() mp.commandv("cycle", "mute") end)
        right(66 * S, "Sound", false, audio_menu)
        right(72 * S, "Export", false, export_frame)
        if not crop.editing then right(52 * S, "Crop", crop.on, cropui.start) end
        right(86 * S, slowmo_active and string.format("%.1fx", (source_fps or 24) / 24) or "Slow-mo",
            slowmo_active, slowmo_toggle)
    end

    -- ---- centre of the bar: the shuttle, or a readout for photos ----
    if is_photo() then
        local label = string.format("%dx%d   %.0f%%   %s", MEDIA.w, MEDIA.h,
            display_scale() * 100, MEDIA.ext:upper())
        text(ass, (lx + rx) / 2, (cy0 + cy1) / 2, 5, fs, COL_TEXT, label)
        ui.speedbar = nil
    else
        local mid_y = (cy0 + cy1) / 2
        local signed = signed_speed()
        local time_str = fmt_time(pos) .. " / " .. fmt_time(dur)
        local speed_str = signed == 0 and "Paused" or string.format("%.2fx", signed)

        -- Both readouts are pinned to the ends and the shuttle runs between
        -- them, so neither number moves as the thumb travels.
        text(ass, lx, mid_y, 4, fs, COL_TEXT, time_str)
        text(ass, rx, mid_y, 6, fs, COL_ACCENT, speed_str)

        local sx0 = lx + (#time_str * 8 + 16) * S
        local sx1 = rx - (#speed_str * 8 + 16) * S
        if sx1 - sx0 > 40 * S then
            draw_shuttle(ass, sx0, sx1, mid_y, S, signed)
            ui.speedbar = { sx0, cy0, sx1, cy1 }
        else
            ui.speedbar = nil
        end
    end

    -- ---- strip above the bar: the timeline, or zoom for photos ----
    -- The timeline gets the full width because scrubbing is the one control
    -- whose precision is worth the whole window; the shuttle only has to
    -- resolve six speeds and sits in the bar with the buttons it belongs to.
    local sub_x0, sub_x1 = 12 * S, w - 12 * S
    local sub_cy = (sub_y0 + sub_y1) / 2
    local trk = 5 * S
    local k = 6 * S

    if is_photo() then
        -- Zoom, log-scaled: the left end is 0.25x of fit, the right end 16x.
        round_rect(ass, sub_x0, sub_cy - trk / 2, sub_x1, sub_cy + trk / 2, trk / 2, COL_TRACK, "&H10&")
        local z = mp.get_property_number("video-zoom") or 0
        local fit_x = sub_x0 + (sub_x1 - sub_x0) * ((0 - ZOOM_MIN) / (ZOOM_MAX - ZOOM_MIN))
        round_rect(ass, fit_x - 1.5 * S, sub_cy - trk, fit_x + 1.5 * S, sub_cy + trk, 1 * S, COL_DIM, "&H00&")
        local tx = sub_x0 + (sub_x1 - sub_x0) * clamp((z - ZOOM_MIN) / (ZOOM_MAX - ZOOM_MIN), 0, 1)
        round_rect(ass, math.min(fit_x, tx), sub_cy - trk / 2, math.max(fit_x, tx),
            sub_cy + trk / 2, trk / 2, COL_ACCENT, "&H00&")
        thumb(ass, tx, sub_cy, k)
        ui.zoombar = { sub_x0, sub_y0, sub_x1, sub_y1 }
        ui.seekbar = nil
    else
        round_rect(ass, sub_x0, sub_cy - trk / 2, sub_x1, sub_cy + trk / 2, trk / 2, COL_TRACK, "&H10&")
        if dur > 0 then
            -- How far the demuxer has read ahead, behind the played part: on a
            -- slow source it says whether a scrub will land instantly.
            local cache = mp.get_property_number("demuxer-cache-time")
            if cache and cache > pos then
                local cx = sub_x0 + (sub_x1 - sub_x0) * clamp(cache / dur, 0, 1)
                round_rect(ass, sub_x0, sub_cy - trk / 2, cx, sub_cy + trk / 2, trk / 2, COL_DIM, "&H90&")
            end
            local fx = sub_x0 + (sub_x1 - sub_x0) * clamp(pos / dur, 0, 1)
            round_rect(ass, sub_x0, sub_cy - trk / 2, fx, sub_cy + trk / 2, trk / 2, COL_ACCENT, "&H00&")
            thumb(ass, fx, sub_cy, k)
        end
        ui.seekbar = { sub_x0, sub_y0, sub_x1, sub_y1 }
        ui.zoombar = nil
    end

    -- ---- top-left status strip ----
    local status
    local res = MEDIA.w > 0 and string.format("%dx%d   |   ", MEDIA.w, MEDIA.h) or ""
    local hwdec = mp.get_property("hwdec-current") or "no"
    local hw_tag = (hwdec ~= "no" and hwdec ~= "") and string.format("HW (%s)   |   ", hwdec) or "SW (CPU)   |   "
    local hdr_tag = hdr_live and "HDR   |   " or ""
    local up_tag = up_on and (up_label .. "   |   ") or ""

    if is_photo() then
        status = string.format("PHOTO   |   %s%s%s%s%s   |   Zoom %.0f%%",
            res, MEDIA.ext:upper() .. "   |   ", hw_tag, hdr_tag, up_tag, display_scale() * 100)
    elseif is_audio() then
        status = string.format("AUDIO   |   %s   |   %s Hz   |   %sch   |   %s",
            mp.get_property("audio-codec-name") or "?",
            mp.get_property("audio-params/samplerate") or "?",
            mp.get_property("audio-params/channel-count") or "?",
            fmt_time(pos))
    else
        local cur_speed_val = mp.get_property_number("speed") or 1.0
        local pb_fps = (source_fps or 0) * cur_speed_val
        local mode = slowmo_active
            and string.format("SLOW-MO %.0f>%gfps   |   Playback: %.0f fps", source_fps or 0, target_fps(), pb_fps)
            or string.format("%.0f fps   |   Playback: %.0f fps", source_fps or 0, pb_fps)
        status = string.format("%s%s%s%s%s   |   Frame %d   |   %s", res, hw_tag, hdr_tag, up_tag, mode,
            mp.get_property_number("estimated-frame-number") or 0, fmt_time(pos))
    end

    local chip_w = math.min(w - 20 * S, (#status * 7.6 + 28) * S)
    local chip_x0, chip_y0 = 8 * S, 4 * S
    local chip_x1, chip_y1 = chip_x0 + chip_w, chip_y0 + status_h - 2 * S
    round_rect(ass, chip_x0, chip_y0, chip_x1, chip_y1, R_BTN * S, COL_BG, "&H14&")
    glass_border(ass, chip_x0, chip_y0, chip_x1, chip_y1, R_BTN * S, COL_BORDER, "&H20&")
    text(ass, chip_x0 + 10 * S, (chip_y0 + chip_y1) / 2, 4, 12 * S, COL_ACCENT, status)

    if help_visible then draw_help(ass, w, h, S) end
    mp.set_osd_ass(w, h, ass.text)
end

-- ============================================================
-- Mouse
-- ============================================================

-- Timeline scrubbing: mouse x maps straight to a position on the bar, so
-- the playhead simply follows the pointer. Seeks are paced and exact (see
-- above) - it lands on the frame you point at rather than the nearest
-- keyframe, and never queues up more seeks than the source can service.
local function seek_to_x(x)
    if not ui.seekbar then return end
    local sx0, sx1 = ui.seekbar[1], ui.seekbar[3]
    local dur = mp.get_property_number("duration") or 0
    if dur <= 0 or sx1 <= sx0 then return end
    paced_seek_percent(math.max(0, math.min(1, (x - sx0) / (sx1 - sx0))) * 100)
end

local function scrub_begin(x)
    -- Scrubbing against live playback fights the seek, so grabbing pauses -
    -- and letting go hands playback back the way it was found, rather than
    -- leaving a clip stopped because it was nudged along the timeline.
    ui.resume_after_scrub = not mp.get_property_bool("pause")
    mp.set_property_bool("pause", true)
    ui.dragging_seekbar = true
    seek_to_x(x)
end

-- Where along a slider the pointer landed, 0..1.
local function fraction_along(box, x)
    if not box or box[3] <= box[1] then return nil end
    return clamp((x - box[1]) / (box[3] - box[1]), 0, 1)
end

-- ---- shuttle (video / audio) ----
local function set_speed_from_x(x)
    local pct = fraction_along(ui.speedbar, x)
    if not pct then return end
    apply_signed_speed((pct - 0.5) * 2 * SHUTTLE_MAX)
end

-- ---- zoom slider (photos) ----
local function set_zoom_from_x(x)
    local pct = fraction_along(ui.zoombar, x)
    if not pct then return end
    set_zoom(ZOOM_MIN + pct * (ZOOM_MAX - ZOOM_MIN))
end

-- ---- pan (drag a zoomed image) ----
local pan_from = nil

local function pan_begin(x, y)
    pan_from = {
        x = x, y = y,
        px = mp.get_property_number("video-pan-x") or 0,
        py = mp.get_property_number("video-pan-y") or 0,
    }
end

local function pan_to(x, y)
    if not pan_from or ui.osd_w <= 0 or ui.osd_h <= 0 then return end
    mp.set_property_number("video-pan-x", pan_from.px + (x - pan_from.x) / ui.osd_w)
    mp.set_property_number("video-pan-y", pan_from.py + (y - pan_from.y) / ui.osd_h)
end

local function drag_end()
    if ui.dragging_seekbar and ui.resume_after_scrub then
        mp.set_property_bool("pause", false)
    end
    ui.resume_after_scrub = false
    ui.dragging_seekbar = false
    ui.dragging_speed = false
    ui.dragging_zoom = false
    pan_from = nil
    if cropui.release() then return end
    if crop_drag then
        local clicked = not crop_drag.moved
        if crop.on then apply_crop_vf(false) end
        crop_drag = nil
        -- A click without a drag still toggles playback.
        if clicked and not is_photo() then mp.commandv("cycle", "pause") end
    end
end

mp.add_key_binding("MBTN_LEFT", "ui_mbtn_left", function(e)
    if e.event == "up" then drag_end() return end
    if e.event ~= "down" then return end
    if help_visible then toggle_help() return end

    local x, y = mp.get_mouse_pos()
    for _, b in ipairs(ui.buttons) do
        if inside(b, x, y) then b[5]() return end
    end
    if ui.seekbar and inside(ui.seekbar, x, y) then
        scrub_begin(x)
        return
    end
    if ui.speedbar and inside(ui.speedbar, x, y) then
        ui.dragging_speed = true
        set_speed_from_x(x)
        return
    end
    if ui.zoombar and inside(ui.zoombar, x, y) then
        ui.dragging_zoom = true
        set_zoom_from_x(x)
        return
    end

    -- While the crop is being adjusted the picture is the box: grab a handle
    -- to resize, the inside to move, and clicking off it does nothing rather
    -- than starting playback under the overlay.
    if crop.editing then
        local hit = cropui.hit(x, y)
        if hit then cropui.grab(hit, x, y) end
        return
    end

    -- Picture clicks. Crop applied: drag slides the full frame inside the
    -- ratio window. Photos pan when zoomed. Video otherwise play/pause.
    local chrome_bottom = ui.osd_h - (BAR_H + SUBBAR_H) * effective_scale()
    if y < chrome_bottom then
        if crop.on then
            crop_drag_begin(x, y)
        elseif is_photo() then
            pan_begin(x, y)
        else
            mp.commandv("cycle", "pause")
        end
    end
end, { complex = true })

mp.observe_property("mouse-pos", "native", function(_, v)
    if not v then return end
    if ui.dragging_seekbar then
        seek_to_x(v.x)
    elseif ui.dragging_speed then
        set_speed_from_x(v.x)
    elseif ui.dragging_zoom then
        set_zoom_from_x(v.x)
    elseif cropui.drag then
        cropui.drag_to(v.x, v.y)
    elseif crop_drag then
        crop_drag_to(v.x, v.y)
    elseif pan_from then
        pan_to(v.x, v.y)
    end
end)

-- ============================================================
-- Speed shuttle / wheel
-- ============================================================

local function adjust_speed(delta)
    apply_signed_speed(signed_speed() + delta)
end

-- One wheel, two meanings: a photo has no timeline to shuttle, so the wheel
-- does the thing a photo viewer's wheel does.
local function wheel_up()
    if is_photo() then zoom_by(0.15) else adjust_speed(0.1) end
end
local function wheel_down()
    if is_photo() then zoom_by(-0.15) else adjust_speed(-0.1) end
end

mp.observe_property("speed", "number", function(_, speed)
    if not speed then return end
    local fps = source_fps or detect_fps() or 30
    -- Drop frames at the decoder level when fast-forwarding high-fps video,
    -- otherwise the decoder buffer starves and playback lags out.
    if speed > 1.0 and fps > 60 then
        mp.set_property("framedrop", "decoder")
    else
        mp.set_property("framedrop", "vo")
    end
end)

-- ============================================================
-- UI scale
-- ============================================================

local function scale_report()
    emit(string.format("UI scale %.0f%%", effective_scale() * 100), 1.2)
end

local function ui_scale_up()
    ui_scale = math.min(ui_scale * UI_SCALE_STEP, 3.0); render(); scale_report()
end
local function ui_scale_down()
    ui_scale = math.max(ui_scale / UI_SCALE_STEP, 0.4); render(); scale_report()
end
local function ui_scale_reset()
    ui_scale = UI_SCALE_DEFAULT; render(); scale_report()
end

-- ============================================================
-- Session state: last file + UI scale, so the next launch resumes.
-- MediaInspector_Pro.exe reads this to reopen the last file; it saves its
-- own window position separately, since mpv exposes no window-position
-- property and is a child window here anyway.
-- ============================================================

-- Remember the path as it loads: by the time the shutdown event fires mpv
-- has already cleared the "path" property, which was silently saving an
-- empty filename and losing the resume-last-file behaviour.
local last_path = nil

local function save_state()
    local path = mp.get_property("path") or last_path
    if path then last_path = path end
    local f = io.open(state_path(), "w")
    if not f then return end
    f:write(string.format('{"file":"%s","uiScale":%.4f,"browseAll":%s}',
        path and json_escape(path) or "", ui_scale, tostring(browse_all)))
    f:close()
end

-- Mirrored into user-data as well as the state file, so the control panel's
-- toggle and the bar's button are reading and writing the one value: the
-- panel writes the slot, the observer below picks the change up here.
local function set_browse_all(v, quiet)
    v = v and true or false
    if v ~= browse_all then
        browse_all = v
        save_state()
        if not quiet then
            emit(v and "Browsing every media file in the folder"
                    or "Browsing video files only", 2)
        end
        render()
    end
    mp.set_property("user-data/mi/set_browse_all", v and "yes" or "no")
end

browse_scope_toggle = function() set_browse_all(not browse_all) end

mp.observe_property("user-data/mi/set_browse_all", "native", function(_, val)
    if type(val) ~= "string" then return end
    local want = (val == "yes" or val == "true" or val == "1")
    if want ~= browse_all then set_browse_all(want, true) end
end)

-- The window can only be fitted once the decoder has reported real
-- dimensions, which for some containers lands after file-loaded. The fit is
-- therefore armed here and fired by whichever event first has the numbers.
local fit_pending = false
local fit_tries = 0

local function try_fit()
    if not fit_pending then return end
    if MEDIA.w <= 0 and not is_audio() then return end
    if fit_window() then
        fit_pending = false
        return
    end
    -- Not ready (no window on a monitor yet). Come back shortly rather than
    -- fitting to a guessed display size - at most ~2s of retries, after
    -- which whatever mpv's own autofit chose stands.
    fit_tries = fit_tries + 1
    if fit_tries < 14 then
        mp.add_timeout(0.15, try_fit)
    else
        fit_pending = false
    end
end

mp.register_event("file-loaded", function()
    reset_seek_pacing()
    local kind = refresh_media()
    detect_fps()

    if kind == "photo" then
        mp.set_property_number("speed", 1.0)
        mp.set_property("play-direction", "forward")
        slowmo_active = false
    elseif kind == "audio" then
        mp.set_property_number("speed", 1.0)
        mp.set_property("play-direction", "forward")
        slowmo_active = false
    else
        local tgt = target_fps()
        local fps = source_fps or 30
        local def_speed = fps > 0 and (tgt / fps) or 1.0
        slowmo_active = math.abs(def_speed - 1.0) > 0.01
        mp.set_property_number("speed", def_speed)
        mp.set_property("play-direction", "forward")
    end

    -- Every file starts from a clean view: a zoom or pan left over from the
    -- previous image would otherwise silently crop the next one.
    mp.set_property_number("video-zoom", 0)
    mp.set_property_number("video-pan-x", 0)
    mp.set_property_number("video-pan-y", 0)
    mp.set_property_number("video-rotate", 0)
    -- A box sized for the last file means nothing over this one.
    local had_crop = crop.on or crop.editing
    crop.editing = false
    crop.saved = nil
    if had_crop then clear_crop(true) end

    fit_pending = true
    fit_tries = 0
    try_fit()
    apply_upscale(true)

    if kind == "photo" then
        emit(string.format("%s  -  %dx%d %s", mp.get_property("filename") or "",
            MEDIA.w, MEDIA.h, MEDIA.ext:upper()), 2)
    elseif kind == "audio" then
        emit(string.format("%s  -  %s", mp.get_property("filename") or "",
            mp.get_property("audio-codec-name") or "audio"), 2)
    elseif source_fps then
        emit(string.format("%s  -  %.2f fps", mp.get_property("filename") or "", source_fps), 2)
    end

    save_state()
    render()
end)

mp.register_event("video-reconfig", function()
    MEDIA.w = mp.get_property_number("width") or MEDIA.w
    MEDIA.h = mp.get_property_number("height") or MEDIA.h
    try_fit()
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
    browse_all = body:match('"browseAll"%s*:%s*true') ~= nil

    -- Seed the remembered path from what the last session left. Without this a
    -- single run that never opened a file - the host started idle, or a probe
    -- ran against the config - wrote an empty name over the real one, and every
    -- launch after that opened to a black window and wrote the emptiness back.
    local file = body:match('"file"%s*:%s*"(.-)"')
    if file and file ~= "" then
        last_path = file:gsub('\\(.)', '%1')
    end
end
set_browse_all(browse_all, true)

-- ============================================================
-- Bindings / observers
-- ============================================================

local function refit_window() fit_now() end

mp.add_key_binding(nil, "slowmo_toggle", slowmo_toggle)
mp.add_key_binding(nil, "export_frame", export_frame)
mp.add_key_binding(nil, "audio_menu", audio_menu)
mp.add_key_binding(nil, "next_media", next_media)
mp.add_key_binding(nil, "prev_media", prev_media)
mp.add_key_binding(nil, "browse_scope_toggle", function() browse_scope_toggle() end)
mp.add_key_binding(nil, "crop_edit_toggle", cropui.toggle)
mp.add_key_binding(nil, "crop_edit_apply", function()
    -- Bound to Enter, which otherwise means nothing here: files are stepped
    -- through with the arrows, not with mpv's playlist.
    if crop.editing then cropui.apply() end
end)
mp.add_key_binding(nil, "crop_edit_cancel", function()
    -- Bound to Esc. Outside the adjust mode it keeps Esc's usual job.
    if crop.editing then cropui.cancel() else mp.set_property_bool("fullscreen", false) end
end)
mp.add_key_binding(nil, "toggle_help", toggle_help)
mp.add_key_binding(nil, "hdr_toggle", hdr_toggle)
mp.add_key_binding(nil, "ui_scale_up", ui_scale_up)
mp.add_key_binding(nil, "ui_scale_down", ui_scale_down)
mp.add_key_binding(nil, "ui_scale_reset", ui_scale_reset)
mp.add_key_binding(nil, "wheel_up", wheel_up)
mp.add_key_binding(nil, "wheel_down", wheel_down)
mp.add_key_binding(nil, "zoom_fit", zoom_fit)
mp.add_key_binding(nil, "zoom_actual", zoom_actual)
mp.add_key_binding(nil, "zoom_in", function() zoom_by(0.15) end)
mp.add_key_binding(nil, "zoom_out", function() zoom_by(-0.15) end)
mp.add_key_binding(nil, "rotate_cw", function() rotate_by(90) end)
mp.add_key_binding(nil, "rotate_ccw", function() rotate_by(-90) end)
mp.add_key_binding(nil, "fit_window", refit_window)
mp.add_key_binding(nil, "show_info", show_info)
mp.add_key_binding(nil, "upscale_cycle", upscale_cycle)
mp.add_key_binding(nil, "apply_upscale", function() apply_upscale(false) end)
mp.add_key_binding("Alt+LEFT", "crop_nudge_left", function() crop_nudge(-8, 0) end, { repeatable = true })
mp.add_key_binding("Alt+RIGHT", "crop_nudge_right", function() crop_nudge(8, 0) end, { repeatable = true })
mp.add_key_binding("Alt+UP", "crop_nudge_up", function() crop_nudge(0, -8) end, { repeatable = true })
mp.add_key_binding("Alt+DOWN", "crop_nudge_down", function() crop_nudge(0, 8) end, { repeatable = true })

-- If the panel opens while the on-video shortcut overlay is up, drop the
-- overlay: the panel is now showing that list.
hide_overlay_on_panel = function()
    if help_visible then help_visible = false; render() end
end

for _, p in ipairs({ "pause", "time-pos", "duration", "mute", "volume", "osd-dimensions",
                     "video-params/gamma", "target-colorspace-hint", "video-zoom",
                     "video-rotate", "user-data/mi/set_upscale", "user-data/mi/set_shaders" }) do
    mp.observe_property(p, "native", render)
end

-- ============================================================
-- Active-setting flags -> control panel
--   The panel draws a green dot beside every control that is currently
--   doing something. Collapsing the state into one JSON blob here keeps
--   that to a single IPC round trip on the panel's 500ms tick - polling a
--   dozen properties separately would have multiplied the tick's pipe
--   traffic, and Send-Mpv is a synchronous request/reply each time.
--   Published only on change, so an idle player writes nothing.
-- ============================================================
local last_flags = nil

local function publish_flags()
    local function truthy(p) return (mp.get_property(p) or "no") ~= "no" end
    local shader_n = 0
    for _ in setting("shaders", ""):gmatch("[^,]+") do shader_n = shader_n + 1 end
    local speed = mp.get_property_number("speed", 1) or 1

    local s = utils.format_json({
        deband     = mp.get_property_bool("deband", false),
        mute       = mp.get_property_bool("mute", false),
        fullscreen = mp.get_property_bool("fullscreen", false),
        ontop      = mp.get_property_bool("ontop", false),
        paused     = mp.get_property_bool("pause", false),
        loop       = truthy("loop-file"),
        hdr        = truthy("target-colorspace-hint"),
        -- ab-loop-a reads "no" when unset, so truthy() covers it.
        abloop     = truthy("ab-loop-a"),
        upscale    = setting("upscale", "off") ~= "off",
        shaders    = shader_n > 0,
        slowmo     = math.abs(speed - 1.0) > 0.01,
        crop       = crop.on,
        crop_1_1   = crop.on and crop.label == "1:1",
        crop_4_3   = crop.on and crop.label == "4:3",
        crop_3_4   = crop.on and crop.label == "3:4",
        crop_16_9  = crop.on and crop.label == "16:9",
        crop_9_16  = crop.on and crop.label == "9:16",
        crop_3_2   = crop.on and crop.label == "3:2",
        crop_2_3   = crop.on and crop.label == "2:3",
        crop_5_4   = crop.on and crop.label == "5:4",
        crop_4_5   = crop.on and crop.label == "4:5",
        crop_21_9  = crop.on and crop.label == "21:9",
    })
    if s ~= last_flags then
        last_flags = s
        mp.set_property("user-data/mi/flags", s)
    end
end

-- hwdec-current is deliberately absent: hardware decoding is not a setting
-- the panel exposes, so nothing draws a dot for it. The separate
-- hwdec-current observer above still drives the RTX upscaler's hand-off.
for _, p in ipairs({ "deband", "mute", "fullscreen", "ontop", "pause", "speed",
                     "loop-file", "target-colorspace-hint", "ab-loop-a",
                     "user-data/mi/set_upscale", "user-data/mi/set_shaders" }) do
    mp.observe_property(p, "native", publish_flags)
end

refresh_media()
render()
publish_flags()
