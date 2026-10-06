# MediaInspector_Pro

One window for **video, photos and audio**, built for inspecting footage
rather than watching it: scrub fast, step frame-by-frame, zoom a still to
its actual pixels, conform 120fps footage to a slow-motion preview, upscale
on the GPU, and export any frame at full source quality.

Built on [mpv](https://mpv.io) (FFmpeg + libplacebo) with a custom config,
keybindings and Lua UI — so it gets real GPU decode, frame-exact stepping,
native ProRes/HEVC support and lossless full-resolution export without
reinventing a media pipeline.

## Running it

Run **MediaInspector_Pro.bat**, or drag any media file onto it. It starts the
packaged build if there is one and falls back to running from source, so it
launches either way.

With no file given it **reopens the last file you had open**, in the **same
window position** as last time, at the **UI scale you last set**. Opening a
file while a window is already up reuses that window rather than starting a
second player - both would otherwise fight over the same IPC pipe, whose name
is fixed, so one instance runs at a time.

Run **Register-FileTypes.bat** once to get "Open with MediaInspector_Pro" in
Explorer's right-click menu for every supported extension. It writes the exe's
path into the registry, so re-run it after moving the project folder.

## Building

```
cd app
npm install          # once: Electron, plus koffi for the few Win32 calls
npm start            # run from source
npm run build        # package it: dist\MediaInspector_Pro-win32-x64\MediaInspector_Pro.exe
```

Packaging bundles Chromium and Node, so the output folder is ~300MB - the price
of the UI toolkit, not of this app. `dist/` is git-ignored.

The exe finds the project by walking up from wherever it sits, which is how it
locates `config/`, `Exports/` and the player's state file; a copy of `config/`
ships inside the package as a fallback for a folder that has been moved
somewhere else, and `MI_ROOT` overrides both.

The icon is `app.ico`, drawn by `tools\make-icon.py` from the same palette as
everything else - the crop brackets around a play triangle, with the brackets
dropped below 48px where they stop reading. Regenerate it and rebuild to change
it.

The picture is a native child window that mpv paints into, positioned over the
page, which is why the panel lays out *around* it rather than over it. Node
talks to mpv over the JSON IPC pipe and keeps the connection open, subscribing
to property changes, so the panel is a listener rather than a poller.
`--shot=<file>.png` renders the panel, writes a PNG of it and exits, for
checking the panel's own layout without a screen grab.

## One window

The app hosts mpv **inside itself**: mpv is started with `--wid` pointing at
a panel the app owns, so the picture renders as a child window and the
controls sit in the same frame. There is no second window and no separate
control-panel process.

The split between picture and controls is a draggable splitter. Widening the
window gives the extra space to the **picture**; dragging the splitter is
what resizes the control pane, and the card grid reflows into more columns
as it widens (measured 1 → 2 → 3).

Because mpv is a child window it cannot resize or fullscreen the frame around
it, so the host owns fit-to-frame sizing, fullscreen, always-on-top, and the
renderer restart. The Lua script is told it is embedded via `--script-opts`
and stands down from those jobs.

## Fit-to-frame windows

Every file opens in a window sized to **the media itself**: a 1920×1080
photo on a 4K display opens as a 1920×1080 image with the control chrome
added underneath (measured: a 1920×1215 window), a 720×1280 clip opens at
720×1280, and anything larger than the screen is scaled down to the largest
size that still fits.

This is deliberately not mpv's own `auto-window-resize`. That sizes the
window to the video and then has the control bar carved *out* of it, so a
1080p clip lost ~100px of picture to the chrome. `fit_window()` in
`config/scripts/mediainspector.lua` solves for the window height instead —
the chrome's height depends on the UI scale, which depends on the window
height, so it settles over a few passes — and adds the chrome on top.

Only the window **position** is restored between runs; the size always comes
from whatever you open. Turn the whole behaviour off with the control
panel's **Window** checkbox if you would rather drag the window once and
keep it.

## Media kinds

The UI reshapes itself around what mpv actually decoded, not around the file
extension — a `.mkv` holding one still frame is a photo, an `.mp4` with no
video track is audio, and an `.mp3` with cover art is audio, not a photo.

| | Video | Photo | Audio |
|---|---|---|---|
| Accent colour | fps tier (yellow / blue / green) | amber | cyan |
| Bottom-left | play/pause, prev/next, info | prev/next, fit, 1:1, info | play/pause, prev/next, info |
| Centre | time + shuttle + speed | dimensions, zoom %, format | time + shuttle + speed |
| Strip above the bar | timeline | zoom slider | timeline |
| Click the picture | play/pause | drag to pan | play/pause |
| Wheel | shuttle speed | zoom | shuttle speed |

Prev/next walks the **video** files in the folder by default. The scope
button beside the `<<` `>>` arrows (or `b`, or the control panel's *Browse
videos only* toggle) switches it to every supported media file, so a mixed
folder of clips, stills and audio browses as one sequence. The choice is
remembered between sessions. Stepping from a file outside the current scope
- a photo, while the scope is video only - moves to the next video from
where that file sorts, rather than jumping to the top of the folder.

### Formats

Video, photo and audio extension tables live at the top of
`config/scripts/mediainspector.lua` and are mirrored in the control panel's
file dialog and in `Register-FileTypes.ps1`. Between them they cover what
FFmpeg can demux: H.264/HEVC/AV1/VP9/ProRes/MPEG containers, JPEG, PNG,
WebP, TIFF, HEIC, AVIF, JXL, EXR, HDR, DDS, the netpbm family, common camera
raw, and MP3/FLAC/AAC/Opus/WAV/DSD/AIFF and friends.

Camera raw is listed but is only as good as FFmpeg's decoder for that
specific body — some open, some don't.

## Controls

The bottom bar is drawn by [config/scripts/mediainspector.lua](config/scripts/mediainspector.lua)
and replaces mpv's default OSC entirely (so only one thing handles clicks).
It never covers the picture — `video-margin-ratio` reserves real space for
it, so the image is letterboxed slightly instead of being overlaid.

| Key | Action |
|---|---|
| `Left` / `Right` or `<` / `>` or `PgUp` / `PgDn` | Previous / next file in the same folder |
| `b` | Browse videos only / every media file |
| `Shift+Left` / `Shift+Right` | Step one frame |
| `s` | Slow-mo: conform source fps to the 24fps target |
| `e` | Export frame / image to `Exports/` |
| `i` | Media info (dimensions, codec, colour, decode path) |
| `u` | Cycle GPU upscaler (CNN 2x → FSR → RTX) |
| `z` / `x` | Zoom to fit / zoom to 1:1 actual pixels |
| `r` / `Shift+R` | Rotate right / left |
| `w` | Refit the window to the media |
| `t` | Motion trail: bright → dark → X-ray → off |
| `Ctrl+H` | Toggle HDR (force SDR tone-map / allow HDR passthrough) |
| `Ctrl+A` | Sound settings |
| `9` / `0`, `m`, `a` | Volume, mute, audio track |
| `[` / `]`, `Backspace` | Speed nudge, reset speed |
| `Space`, `f` | Play/pause, fullscreen (double-click fullscreen disabled) |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | UI scale up / down / reset |
| `h` / `F1` | Shortcuts overlay |
| Wheel | Shuttle speed on video/audio, zoom on a photo |
| `Ctrl` + Wheel | Zoom, whatever is open |

## Scrubbing

The **timeline** is the full-width strip above the buttons, because position
is the one control whose precision is worth the whole window; a dimmer fill
behind the played part shows how far the demuxer has read ahead. Dragging it
is straight position tracking — the playhead follows the pointer. Seeks are
exact and paced to the player's own completion signal: only one is ever in
flight, so it lands on the frame you point at instead of snapping to the
nearest keyframe, and never queues up more seeks than the source can
service. Grabbing it pauses; letting go resumes if it had been playing.

The **shuttle** sits in the middle of the button bar, between the running
time on the left and the current speed on the right. Which side of centre
the thumb is on is the direction, how far out it is is the speed, and the
centre notch is a hard stop. A second tick marks where the slow-mo conform
would sit, so the clip's "correct" playback speed is something to aim for.
Wheel up/down nudges the same control.

### Backward playback is the fragile half

mpv can only decode forward, so playing backward means decoding a run of
frames, holding them, and handing them back in reverse. The reversal buffer
holds **decoded** frames, so at 4K it fills fast — roughly 12MB per frame,
i.e. the 1GiB default is only ~80 frames, less than one keyframe range of
60fps footage. `video-reversal-buffer` and `demuxer-max-back-bytes` in
`config/mpv.conf` are sized for that. mpv's own manual still calls backward
playback "extremely fragile" and warns it "may not always work".

## Photos

Fit and 1:1 are the two anchors. **1:1** solves for the zoom that puts one
source pixel on one screen pixel by reading the real output rectangle back
out of `osd-dimensions`, rather than recomputing it — which means it stays
correct with the control bar's letterboxing in the way.

Drag anywhere on the image to pan; the wheel zooms; the strip above the bar
(where video keeps its timeline) is a zoom slider from ¼× to 16× of fit,
filling out from a tick at fit. Every file resets zoom,
pan and rotation, so a zoom left over from the last image never silently
crops the next one.

## GPU upscaling

Three reconstruction modes plus a shader checklist, all local, all in the
control panel's **Upscale / Enhance** section. `u` cycles them.

### CNN 2x (ArtCNN) — the one for low-res

A small trained CNN (`Upscale-ArtCNN.glsl`, ArtCNN C4F16 DS) that **doubles
luma** and was trained to denoise and sharpen in the same pass. This is the
reconstruction path for soft, compressed, low-res footage: doorbell cams,
social-media re-encodes, 720p, anything that looks like 480p even when the
container says 1080p.

It is a user shader, so it works on **photos and CPU-decoded video** too —
unlike RTX. The window grows by the Factor dropdown so the extra pixels
have somewhere to land (capped to the display). On a 1080p source that
already fills the screen, the CNN still runs: it reconstructs at 2x and
the renderer downscales into the window, which is what you want when
zooming in to inspect.

Skip it on native 4K — an 8K luma plane is not worth the VRAM, and the
shader's `WHEN` already refuses anything 1600p or taller unless the window
is actually larger than the source.

### FSR (spatial)

AMD FidelityFX Super Resolution 1.0.2 (EASU + RCAS). Edge-adaptive spatial
upsample to the window, capped at 2x, then mpv's own scaler takes over.
Cheaper than the CNN, weaker on mushy sources. Same window-grow as CNN 2x.
Also a user shader, so photos and software decode are fine.

### RTX Video Super Resolution

NVIDIA's driver-side AI upscaler, reached through the D3D11 video processor
(`d3d11vpp=scaling-mode=nvidia`). Measured here: a 720×1280 clip comes out
of the filter at 1440×2560. **RTX Video HDR** (`nvidia-true-hdr`) is the
same stage's SDR→HDR pass, on a checkbox beside it.

It only accepts frames that are still D3D11 textures, which has two
consequences the app handles for you:

* The default decode path is copy-back (see [GPU](#gpu)): the frames are read
  back to system RAM and the filter has nothing to work with. So the mode
  takes over `hwdec` while it is on, switching to direct `d3d11va`, and hands
  it back when it is turned off.
* Direct decode allocates one fixed texture array, and a large pool blows
  past what D3D11 will allocate — the decoder fails with *"Static surface
  pool size exceeded"* and silently drops to software. The pool comes down to
  16 while RTX is engaged.

Switching `hwdec` re-initialises the decoder asynchronously, so the filter
is parked and fired by the `hwdec-current` property rather than after a
guessed sleep. It is skipped for photos and for anything on software decode
(ProRes, 4:4:4), and it says so in the activity log instead of failing
quietly.

### GLSL shaders

Every `.glsl` in `config/shaders/` that is **not** named `Upscale-*`
appears as a checkbox. These run inside libplacebo as part of the render
pass, so they work on **everything** — photos, album art, CPU-decoded
video, any renderer backend. The `Upscale-*` files are the CNN / FSR mode
shaders above and are driven by the dropdown, not ticked here.

Bundled enhance: **CAS** and **CAS-Strong**, AMD FidelityFX Contrast Adaptive
Sharpening. It sharpens in inverse proportion to local contrast, so edges
gain definition while flat areas stay clean and clipped highlights are left
alone — which is what you want *after* an upscale, where an unsharp mask
would leave halos. Deband and bilateral denoise sit in front of them.
Drop Anime4K / FSRCNNX / ravu in the same folder and hit **Rescan**; see
[config/shaders/README.md](config/shaders/README.md).

### Renderer scalers and backend

`scale` / `cscale` / `dscale` are a separate axis — they decide how the
picture is resampled to the window whichever route is picked. The default is
`ewa_lanczos4sharpest`.

The **Renderer API** dropdown switches libplacebo between D3D11 and Vulkan.
`gpu-api` cannot change on a running player, so the app writes
`config/render.conf` and restarts mpv in place — the window and every
control stay put. Vulkan is what enables Vulkan video decoding; D3D11 is
what RTX Video Super Resolution needs, so the two are mutually exclusive.

### What is deliberately missing

`scale_cuda` and the `libplacebo` avfilter are **not** offered. Both were
tried: CUDA frames cannot be imported by the D3D11 renderer at all
(*"CUDA hwdec only works with OpenGL or Vulkan backends"*), and under the
Vulkan renderer both filters loaded, reported themselves enabled, and left
the frame at its original size. An option that does nothing is worse than no
option.

## fps colour code

For video, the bar, seek fill and status text are coloured by the clip's
real frame rate: **yellow** at 30fps or below, **blue** around 60fps,
**green** above 60fps — so a glance tells you whether a clip is worth
slow-mo-ing. Photos are **amber** and audio **cyan**. The control panel
mirrors whichever is active.

## Cropping

`c`, the bar's **Crop** button, or the panel's *Adjust on the Picture* opens
the crop box over the video. The filter comes off while it is open, so you
frame against the whole picture: drag the inside to move the box, drag any of
the eight handles to resize it, and thirds guides and a live size readout sit
inside it. **Apply** (or Enter) puts the filter back at that rectangle;
**Cancel** (or Esc) leaves the crop exactly as it was. **Full** takes the box
back out to the whole frame, and the ratio button locks it to 1:1, 16:9, 9:16
and the rest, or leaves it free — a locked ratio is preserved as you resize
from any handle.

There is one crop rectangle, and the picture, the ratio buttons and the
W/H/X/Y boxes are all views of it: the boxes track the drag live, and typing
numbers into them moves the box. Once applied, dragging the picture still
slides the frame inside the crop, and Alt+Arrows nudge it — both work on the
box while it is open too.

## Audio X-ray

Every audio file is analysed as it opens: the panel's **Audio X-ray** card
shows the whole file as a spectrogram (time across, frequency up, click to
jump) and gives a verdict on what the file really is. A video's soundtrack is
analysed on request with **Analyse**.

The verdict is about the top of the spectrum, because that is where lossy
encoders leave their fingerprint. LAME at 128 kbps low-passes at about 16–17
kHz, and the cut is a brick wall — around 60 dB gone in a few hundred hertz.
Decoding that MP3 and saving it as FLAC keeps the wall, so a cliff inside a
lossless container means an upconvert, and the frequency it sits at says
roughly what bitrate it came from. Real recordings roll off gradually, if at
all. A hi-res file (88.2 kHz and up) whose content stops just past 22–24 kHz
is flagged as upsampled from CD-rate audio.

Measured on generated sources: genuine 44.1 and 96 kHz FLAC read as lossless;
MP3s at 128 and 192 kbps re-saved as FLAC read as upconverts with cutoffs at
16.6 and 18.7 kHz; a 44.1 kHz file resampled to 96 kHz reads as upsampled; a
recording low-passed gently at 6 kHz does *not* trip it.

It is a strong hint rather than proof — a master can be band-limited on
purpose — and the card says "probably" for that reason. The audio is decoded
by mpv itself (encode mode, to a temporary mono WAV) and analysed in
`app/xray.js`, so there is still nothing to install but mpv. Long files are
read for their first 30 minutes.

**Live spectrogram** (a toggle on the same card) replaces cover art with a
scrolling spectrogram for audio files: mpv splits the audio inside
`lavfi-complex`, one copy to the speakers and one through `showspectrum` to
become the picture. The bar draws a kHz scale over it, and the cutoff the
analysis found as a line the spectrogram visibly runs into.

## Speed ramp

The **Speed ramp** card is a graph of speed over the clip: click to add a
point, drag to shape it, double-click to remove one. The curve eases between
points in log-speed (1× to 0.25× passes 0.5× halfway) and holds flat outside
them. Points sit on the bar's timeline as ticks.

* **Play the ramp** makes playback follow the curve. Touching the speed by
  hand — the shuttle, a preset, the wheel, Slow-mo — hands control back and
  switches the ramp off.
* The dashed **24 fps** line is the slowest speed that still shows 24 real
  frames a second for this clip's frame rate (0.2× on 120fps footage). Below
  it frames start to repeat.
* **Dip here** eases down to that speed around the playhead and back up.
  **Snap to action** finds the moment with the most movement first (mean
  frame-to-frame difference over a small grey copy of the clip, drawn faintly
  behind the curve) and puts the dip there. It searches the whole of a clip
  up to 40 s long, and the 30 s around the playhead in a longer one, because
  every frame it searches has to be decoded.
* **Export ramp** renders it to `Exports/` at 60 fps (a slower source keeps its
  own rate), video only. The range is the Trim card's In/Out if Out is set,
  otherwise the curve plus a second either side.

The export retimes the source with one `setpts` expression. Each slice of the
range adds `clip(T - start, 0, length) / speed` to the output clock, so there
is no nesting however many slices the eased parts need. mpv applies
`--start`/`--end` to the timestamps coming *out* of the filters, which is why
the ramped clock starts at the range's start rather than at zero.
`app/ramp.js`, the Lua script and the panel each evaluate the same curve, and
have to agree.

## Motion trail

`t`, or the **Motion trail** card, puts a live effect on the picture:

| Mode | What it shows | Filter |
|---|---|---|
| Bright | Light subjects leave a fading trail | `lagfun` |
| Dark | The same for dark subjects on light | `negate,lagfun,negate` |
| X-ray | Only what moves; anything still goes black | `tblend=difference` + levels |

**Length** sets how long a trail lasts, or how hard X-ray amplifies. These are
software filters, so they stand down while RTX upscaling owns the decoder and
come back when it lets go.

**Render still** makes a time-slice photo (a chronophotograph): the subject at
evenly spaced moments, laid over one clean background. The background is the
per-pixel median over the range, which the moving subject never wins, and each
copy is cut out where it differs from that plate — so it needs a still camera.
Copies, the difference threshold and whether early copies fade are on the
card. The range is the Trim card's In/Out, or the 3 seconds from the playhead.
Frames come from mpv in encode mode; the compositing is `app/motion.js`.

## Controls

Every control is a card in the grid beside the picture: transport, media,
view, crop, audio, audio X-ray, playback options, the colour sliders, GPU
upscaling, trim, speed ramp, motion trail, window and export settings, and the
shortcut list. Every card but the
transport folds, and remembers whether it was folded, because ten of them do
not fit on a screen and the ones a given job needs are never all of them.

Two rules shape it, both borrowed from how editing tools are built.

**A control shows its own state.** Speed is a segmented control with the live
speed lit rather than four buttons that look identical whichever one you
pressed; mute, loop, A-B loop, HDR, deband, the crop ratio and always-on-top
light up when they are on. All of it is driven from the same status push the
player sends, so the panel cannot drift out of step with it. A folded card
still says what is engaged inside it, on its header. This is what surfaced
that `loop-file=inf` and `deband=yes` have been on the whole time: the
settings were in `config/mpv.conf`, but nothing on screen said so.

**The accent means "engaged" and nothing else.** It marks what is on, what is
selected and where the playhead is. Primary actions get a lighter face rather
than a coloured one, because a saturated slab reads as a state and an action
is not a state — a play button filled with accent looks like it is announcing
something. What is left is a panel where the lit controls are the ones worth
looking at.

The transport carries the timecode, a scrubber and the button cluster, in that
order, because that is the order they are read in: where am I, take me
somewhere, play. The scrubber throttles to one seek in flight, so dragging it
lands where the pointer is instead of queueing a run of them.

The divide between the cards and the picture subtracts the space the player
reserves for its own bar, so the fit is exact rather than close.

The shape they fit is the shape **on screen**, which is not what mpv's size
properties report. A phone shoots 3840x2160 with a rotate-90 flag, and `width`,
`height`, `dwidth`, `dheight` and `video-params/dw|dh` all report it unrotated -
so a portrait clip was being laid out as landscape and sat in a letterbox a
third as wide as the window. `video-params/rotate` plus the viewer's own
`video-rotate` decide whether the two are swapped.

The divide between the cards and the picture follows the media: the picture
is given the shape it actually wants and the cards take the rest, so a
portrait clip fills its side of the window instead of sitting in a wide
letterbox, and the extra width usually buys a second column of cards. It
re-derives on every resize and whenever the displayed shape changes — a new
file, or a crop applied or cleared — and never shrinks the cards below one
column or the picture below its minimum. Dragging the splitter yourself wins
until the next resize or file.

They drive the player over mpv's JSON IPC socket — real player commands, not
simulated keypresses. The grid mirrors the media-kind accent colour, dims
controls that don't apply to the open file rather than hiding them, and
remembers every setting between runs in `state_panel.json`. Messages that
would pop up over the picture surface as a toast along the bottom instead.

The header says what you are looking at and nothing about what the player is
doing: the media kind, the filename, and the specs worth knowing before
touching anything — dimensions, frame rate, codec, decode path, HDR. What the
player is *doing* is the transport card's job, so none of it is said twice.

Note: the IPC socket name is fixed, so one instance runs at a time — fine for
normal use, not for two files open side by side.

## Frame / image export

`e` grabs the raw decoded frame at native resolution before any overlay —
not a screen capture — and writes it to **`Exports/`** inside the app's
folder (not next to the source, which may be read-only or scattered). The
source name is in the filename so exports never collide.

Because the grab happens on the *filtered* frame, crop, the colour
adjustment sliders and any active upscaler are already baked into what lands
on disk. Scale % above 100 upscales on export through a resampler you pick
(lanczos by default — a bare `scale=` filter uses bilinear, which throws
away exactly the detail an export is meant to preserve).

## GPU

`vo=gpu-next` + `gpu-api=d3d11` (libplacebo), a 10-bit swapchain, Windows
HDR signalling (`target-colorspace-hint`), `video-sync=display-resample`, and
a 3GB demuxer cache so scrubbing large 4K120 files doesn't stall on disk.

Decoding is on the GPU by default, copy-back: `hwdec=d3d11va-copy,nvdec-copy,auto-copy`
with a 32-surface pool. Direct `d3d11va` plus the 256-surface pool reverse
playback used to ask for overflowed what D3D11 will allocate, and the decoder
dropped silently to the CPU — an NVIDIA card showed **CPU decode** in the
header. Copy-back has no such ceiling, works under both renderer APIs, and is
what the colour sliders, crop and motion trail need anyway, since they filter
frames in RAM. Reverse playback keeps working because its decoded frames sit in
`video-reversal-buffer`, in RAM. Clip exports ask for GPU decode too. The
header chip says which path is live (`HW d3d11va-copy` when it is working);
ProRes and 4:4:4 H.264 still decode on the CPU, as no GPU decodes them.

HDR is **off by default** — every file, HDR source included, plays back
tone-mapped to SDR until you opt in with `Ctrl+H`, the bar's **HDR** button,
or the control panel's **HDR** button. Once on, HDR only actually engages
for PQ/HLG sources. When it's engaged, the bar's HDR button, the status
strip and the control panel status all light up in the same magenta accent.
The setting isn't persisted, so every fresh launch starts back at off.

Caveat: no Windows GPU exposes a ProRes decoder, so ProRes `.mov` decodes on
CPU via FFmpeg's SIMD path — still fast, but RTX upscaling is unavailable
for it. Everything after decode (scaling, colour, output) is GPU regardless.

## Files

```
MediaInspector_Pro/
├── MediaInspector_Pro.bat   runs the packaged build, or the source
├── Register-FileTypes.bat   adds the Explorer right-click verb
├── app/                     the shell
│   ├── main.js              window, embedding, IPC wiring, --shot
│   ├── player.js            mpv process + --wid embedding
│   ├── mpv-ipc.js           mpv JSON IPC over a named pipe
│   ├── native.js            the few Win32 calls embedding needs
│   ├── state.js             saved panel state
│   ├── xray.js              spectrum analysis and the lossless verdict
│   ├── motion.js            motion profile and the time-slice still
│   ├── ramp.js              speed-ramp curve and its export
│   └── renderer/            the control panel (HTML/CSS/JS; fx.js = the X-ray, ramp and trail cards)
├── dist/                    the packaged exe (npm run build)
├── Exports/                 exported frames, clips, ramps and time-slices land here
├── state_*                  saved session state (auto-generated)
└── config/
    ├── mpv.conf             GPU, cache, export, IPC settings
    ├── input.conf           keybindings
    ├── render.conf          renderer API override (auto-generated)
    ├── scripts/
    │   └── mediainspector.lua   UI, media kinds, window fit, upscaling
    └── shaders/
        ├── 01-Deband.glsl
        ├── 02-Denoise-Bilateral.glsl
        ├── CAS.glsl / CAS-Strong.glsl
        ├── Upscale-ArtCNN.glsl  CNN 2x mode (low-res reconstruction)
        ├── Upscale-FSR.glsl     FSR mode (spatial upsample)
        └── Inspect-*.glsl
```

Requires mpv: `winget install --id shinchiro.mpv -e`

## MediaExplorer

`explorer/` is a companion app for finding media: a thumbnail grid and details
list over any folder on any disk, with an index that makes whole drives
searchable as you type. Double-clicking a video, photo or audio file opens it
in MediaInspector_Pro (packaged build first, then from source); anything else
opens with its default app.

```
cd explorer
npm install          # once
npm start            # run from source (or run MediaExplorer.bat)
npm test             # indexer checks, no Electron needed; add -- --bench 1000000
npm run build        # dist\MediaExplorer-win32-x64\MediaExplorer.exe
```

### How it stays fast

* **The index lives in its own process** (`indexer/`), as typed-array columns
  plus a name array rather than an object per file. The window talks to it
  over a MessagePort of its own, so listings and searches never pass through
  Electron's main process.
* **Scanning** uses `FindFirstFileExW` with `FIND_FIRST_EX_LARGE_FETCH` on
  Windows, through koffi: name, size and date in one call per batch, where
  readdir would need a stat per file. Several threads scan at once, and one is
  kept for the folder you are opening, so a drive-wide crawl never sits in
  front of a click.
* **Browsing is stale-while-revalidate.** A folder seen before is answered
  from memory immediately and re-read in the background; if anything changed
  the view updates in place, keeping its scroll position.
* **Indexed locations** (sidebar, or *Index this folder*) are crawled once,
  watched for changes on Windows and macOS, and revalidated at startup. A
  drive that is unplugged keeps its index, so it stays browsable and
  searchable offline. OS, toolchain and trash folders (`Windows`,
  `node_modules`, `$RECYCLE.BIN`...) are not crawled, but can still be opened.
* **Search** joins every lowercased name into one string and runs `indexOf`
  over it, so it scans the whole index in one pass. Results come back in
  relevance buckets (whole name, prefix, word start, anywhere), which needs
  no sort.
* **Thumbnails** are cached on disk under a key made from path, size and
  date, and served over `thumb://`. They are made by the Windows/macOS shell
  thumbnailer first (instant when Explorer already has them, and it knows
  HEIC/RAW/video codecs), then Chromium's decoders in worker threads of a
  hidden window, then ffmpeg or mpv. On-screen cells are served last-asked
  first, the rest of the open folder is built in the background, and a fast
  flick holds back thumbnails it has not seen until the scroll settles.
* **The grid and list are virtualised**: only on-screen cells exist, moved
  with transforms, so a 200,000-file folder costs what a small one does.

Measured on Linux (4 cores), over a synthetic 1M-entry index:

| | |
|---|---|
| Search over 1M names | 1–40 ms (`gopro 12`: 21 ms, `dsc_4`: 11 ms) |
| Load the 1M-entry index (37 MB) | 0.4 s |
| Open a 20,000-file folder, first visit / from cache | 219 ms / 27 ms |
| Render a scroll frame (20,000 thumbnails) | 0.56 ms average, 2.8 ms worst |
| Thumbnails from small JPEGs (worker decode) | ~440 per second |

The index and the thumbnail cache are in `%LOCALAPPDATA%\MediaExplorer` (not
the roaming profile); `MX_DATA` points them somewhere else.

### Using it

| Key | Action |
|---|---|
| Type anywhere / `Ctrl+F` | Search (`?` beside the box lists the syntax) |
| `Enter` / double-click | Open folder, or open the file in MediaInspector_Pro |
| `Backspace`, `Alt+Up` | Up a folder |
| `Alt+Left` / `Alt+Right`, mouse back/forward | History |
| `Ctrl+L` | Type a path (folder names complete from the index) |
| `Space` / `P` | Preview pane |
| `Ctrl+1` / `Ctrl+2` | Thumbnails / details |
| `Ctrl+Wheel`, `Ctrl+=` / `Ctrl+-` | Thumbnail size |
| `Ctrl+A`, `Ctrl+C` | Select all, copy paths |
| `F5` | Re-read this folder |

Search syntax: `beach 2023` (every word), `"exact phrase"`, `-exclude`,
`*.mp4` or `ext:jpg,png`, `video:` `photo:` `audio:`, `is:folder`,
`size:>100mb` or `size:1gb..4gb`, `date:2023-07`, `after:2024`,
`modified:7d`, `path:holiday` (inside a folder whose name matches). The
**Everywhere / This folder** toggle limits a search to the current folder's
subtree.

Selections can be dragged out to other apps, and a folder dropped on the
window opens it. Right-click an indexed location to rescan it, build all of
its thumbnails now, or remove it.

`--shot=<file>.png` (with `--open=<folder>`, `--index=<folder>` and
`--eval=<script.js>`) renders the window, writes a PNG and exits, for checking
layout without a screen.
