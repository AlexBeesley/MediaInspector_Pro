# MediaInspector

One window for **video, photos and audio**, built for inspecting footage
rather than watching it: scrub precisely, step frames, zoom to real pixels,
slow high-frame-rate clips down, upscale on the GPU, analyse, and export at
full source quality.

This is the from-scratch rebuild on **Python + Qt + libmpv**. The picture
and the controls share one surface, a single typed state store sits between
the UI and everything that does work, and every export goes through the same
filter graph as the picture.

## Getting started (Windows)

```
setup.bat            once: virtual environment, Python packages, libmpv into vendor\
MediaInspector.bat   run it (drag a file onto it to open that file)
build.bat            optional: tests, then a standalone dist\MediaInspector\MediaInspector.exe
```

`setup.bat` needs Python 3.10+ (`winget install Python.Python.3.12`). It
downloads libmpv, the media engine, from the
[shinchiro mpv builds](https://github.com/shinchiro/mpv-winbuild-cmake/releases).
If that download is blocked, fetch the `mpv-dev-x86_64-<date>-git-<hash>.7z`
archive by hand and run
`.venv\Scripts\python build\fetch_libmpv.py --archive <file>`.
FFmpeg comes inside PyAV, so nothing else needs installing.

To get **Open with MediaInspector** in Explorer's right-click menu, run
`.venv\Scripts\python -m mediainspector.tools.register` (add `--remove` to
take it out). It registers for the current user only and needs no admin
rights. Run it again if you move the app.

From source on any OS: `pip install -r requirements.txt`, make libmpv
available (`apt install libmpv2`, `brew install mpv`), then
`python -m mediainspector [file]`.

## What it does

| Area | Highlights |
|---|---|
| Media kinds | Video, photo or audio is decided by what decoded, not the extension. The accent colour follows the kind and, for video, the frame rate: yellow up to 30 fps, blue around 60, green above 60. |
| Transport | Exact, paced scrubbing. Frame stepping both ways. Shuttle from −3× to +3× with reverse playback. Speed presets. Slow-mo conform to 24 fps (`s`). Loop and A-B loop. |
| Folder browsing | Left and Right walk the folder, either videos only or all media (`b`). |
| Photos and view | Fit and true 1:1 actual pixels. Zoom from ¼× to 16×, pan, and rotate. |
| Crop | An editor on the picture with handles, a thirds grid and ratio locks, plus numeric W/H/X/Y. Rotation-aware, so a phone's portrait clip crops correctly. |
| Colour | Twelve adjustments, applied to playback and to every export. |
| GPU | Hardware decode, copy-back by default. CNN 2× (ArtCNN) and FSR upscaling. Enhance shaders (deband, denoise, CAS). Inspect overlays: false colour, focus peaking, clipping, luma, chroma. |
| Audio X-ray | Whole-file spectrogram plus a verdict: genuine lossless, probable lossy upconvert (with cutoff and bitrate guess), upsampled hi-res, or lossy. Optional live scrolling spectrogram with the cutoff marked. |
| Speed ramp | Draw a speed curve. Playback follows it live. "Dip here" and "Snap to action" place slow motion for you. Exports at 60 fps. |
| Motion trail | Live bright, dark and X-ray trails (`t`). A time-slice still shows the subject at evenly spaced moments over a clean background. |
| Exports | Frame (JPG, PNG or WebP, optional upscale), trim clip, speed ramp and time-slice, all into one folder. Files are never overwritten. |
| Window | Fits itself to the media. The panel follows the media's shape. Single instance; position and every setting are remembered. |

All shortcuts are in the panel's **Keyboard shortcuts** card, and `h` shows
them over the picture.

### Changes from the old Electron/mpv build

- **Slow-mo works.** The old build compared the source frame rate with
  itself, so it never engaged.
- **Exports match the picture.** Trim exports now carry the colour
  adjustments, which the old build dropped.
- **GPU decode by default.** Copy-back decoding means an NVIDIA card no
  longer silently falls back to the CPU.
- **Dropped with the OpenGL render path:**
  - RTX Video Super Resolution and RTX HDR (both need D3D11).
  - Windows HDR passthrough (HDR sources are tone-mapped to SDR).
  - The D3D11/Vulkan renderer switch.

  CNN 2× and FSR still upscale on the GPU.
- **Settings move to `%APPDATA%\MediaInspector`.** Moving or reinstalling
  the app no longer loses them.

## How it fits together

```
mediainspector/
  app.py            start-up, libmpv lookup, single instance, --shot
  controller.py     the command bus: every UI action is a method here
  paths.py          where settings, assets and exports live
  core/             pure logic, no Qt, fully unit-tested
    state.py          Settings (persisted) + Live state, one Store
    media.py          kinds, formats, rotation, tiers, folder stepping
    filters.py        the one filter graph (crop, colour, trail)
    ramp.py           the speed curve and its timeline
    xray.py           spectrum analysis and the verdicts
    motion.py         motion profile and time-slice compositing
    layout.py         fit-to-media, panel width, 1:1, crop mapping
  engine/
    player.py         libmpv: pushes state, paced exact seeks, spectrogram
    decode.py         FFmpeg (PyAV) decode/encode for jobs
    exports.py        trim, ramp, time-slice, frame, X-ray, motion profile
    jobs.py           cancellable background jobs
  ui/               Qt: window, picture surface, transport, panel cards
  tools/            register.py (Explorer verb), colour_code.py (fps dots)
assets/             bundled GLSL shaders and the icon
tests/              47 tests; test_app.py drives the real window
```

User shaders go in `%APPDATA%\MediaInspector\shaders` (the **Shader
folder** button), then press **Rescan**.

`tools/colour_code.py FOLDER [--dry-run]` prefixes video file names with
🟡/🔵/🟢 for their frame-rate tier, so Explorer shows which clips are worth
slowing down.

## Tests

```
python -m pytest -q tests
```

They cover the core maths and the X-ray verdict fixture set (nine generated
files: genuine, upconverted, lossy, upsampled, gently filtered and silent),
plus real FFmpeg exports. `tests/test_app.py` drives the real window and
engine end to end. It needs a display with OpenGL; on a headless Linux box,
wrap it in `xvfb-run`.
