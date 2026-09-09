# MediaInspector_Pro

One window for **video, photos and audio**, built for inspecting footage
rather than watching it: scrub fast, step frame-by-frame, zoom a still to
its actual pixels, conform 120fps footage to a slow-motion preview, upscale
on the GPU, and export any frame at full source quality.

Built on [mpv](https://mpv.io) (FFmpeg + libplacebo) with a custom config,
keybindings and Lua UI — so it gets real GPU decode, frame-exact stepping,
native ProRes/HEVC support and lossless full-resolution export without
reinventing a media pipeline.

## Launching

Run **MediaInspector_Pro.exe**, or drag any media file onto it. If the exe
isn't built yet, **MediaInspector_Pro.bat** builds it and then starts it.

With no file given it **reopens the last file you had open**, in the **same
window position** as last time, at the **UI scale you last set**. Opening a
file while a window is already up reuses that window rather than starting a
second player — both would otherwise fight over the same IPC pipe.

Run **Register-FileTypes.bat** once to get "Open with MediaInspector_Pro" in
Explorer's right-click menu for every supported extension.

## Building

```
.\Build.ps1          # -Run to launch it afterwards
```

Compiles `src\*.cs` with the C# compiler that ships with the .NET Framework,
so there is no SDK, no NuGet and no toolchain to install. Output is a single
~65KB WinExe. Drop an `app.ico` beside `Build.ps1` and it is used as the
icon automatically.

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
| Centre | timeline + time | dimensions, zoom %, format | timeline + time |
| Sub-bar | shuttle (speed + direction) | zoom slider | shuttle |
| Click the picture | play/pause | drag to pan | play/pause |
| Wheel | shuttle speed | zoom | shuttle speed |

Prev/next walks **every** supported media file in the folder, so a mixed
folder of clips, stills and audio browses as one sequence.

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
| `Shift+Left` / `Shift+Right` | Step one frame |
| `s` | Slow-mo: conform source fps to the 24fps target |
| `e` | Export frame / image to `Exports/` |
| `i` | Media info (dimensions, codec, colour, decode path) |
| `u` | Cycle GPU upscaler (CNN 2x → FSR → RTX) |
| `z` / `x` | Zoom to fit / zoom to 1:1 actual pixels |
| `r` / `Shift+R` | Rotate right / left |
| `w` | Refit the window to the media |
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

Dragging the seek bar is straight position tracking — the playhead follows
the pointer. Seeks are exact and paced to the player's own completion
signal: only one is ever in flight, so it lands on the frame you point at
instead of snapping to the nearest keyframe, and never queues up more seeks
than the source can service.

The bar above the timeline is a **shuttle**: which side of centre the thumb
is on is the direction, how far out it is is the speed, and the centre notch
is a hard stop. A second tick marks where the slow-mo conform would sit, so
the clip's "correct" playback speed is something to aim for. Wheel up/down
nudges the same control.

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

Drag anywhere on the image to pan; the wheel zooms; the sub-bar is a zoom
slider from ¼× to 16× of fit, with a tick at fit. Every file resets zoom,
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

* `hwdec=auto-safe` settles on **d3d11va-copy** here — the frames are read
  back to system RAM and the filter has nothing to work with. So the mode
  takes over `hwdec` while it is on and hands it back when it is turned off.
* Direct decode allocates one fixed texture array, and the 256-frame pool
  `config/mpv.conf` asks for (which exists so reverse playback can hold a
  whole keyframe range) blows past what D3D11 will allocate — the decoder
  fails with *"Static surface pool size exceeded"* and silently drops to
  software. The pool comes down to 16 while RTX is engaged.

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

## Controls

Every control is a card in the grid beside the picture: transport, media
navigation, zoom and rotation, display/audio/tools, the colour sliders, GPU
upscaling, crop, trim, export settings and the shortcut list.

They drive the player over mpv's JSON IPC socket — real player commands, not
simulated keypresses. The grid mirrors the media-kind accent colour, dims
buttons that don't apply to the open file rather than hiding them, and
remembers every setting between runs in `state_panel.ini`. Messages that
would pop up over the picture go to the **Activity log** along the bottom.

`--dump-layout` builds the window, writes the real geometry of every card to
`state_layout.txt` and exits — layout faults are invisible in code review and
obvious in numbers.

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
HDR signalling (`target-colorspace-hint`), `hwdec=auto-safe`,
`video-sync=display-resample`, and a 3GB demuxer cache so scrubbing large
4K120 files doesn't stall on disk.

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
├── MediaInspector_Pro.exe   the app (built by Build.ps1)
├── MediaInspector_Pro.bat   builds it if missing, then runs it
├── Build.ps1                compiles src\*.cs -> the exe
├── Register-FileTypes.bat   adds the Explorer right-click verb
├── src/                     C# sources
│   ├── Program.cs           entry point, single instance, --dump-layout
│   ├── MainForm.cs          window, embedding, status, fit-to-frame
│   ├── Cards.cs             the control grid
│   ├── Ipc.cs               mpv JSON IPC over a named pipe
│   ├── Player.cs            mpv process + --wid embedding
│   └── Controls.cs          custom dark-theme controls
├── Exports/                 exported frames and clips land here
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
