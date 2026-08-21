# SlowmoPlayer

A GPU-accelerated .mp4 / .mov player for reviewing high-frame-rate footage:
scrub fast, step frame-by-frame, conform 120fps footage to a 24fps slow-motion
preview, and export any frame at full source quality.

Built on [mpv](https://mpv.io) (FFmpeg + libplacebo) with a custom config,
keybindings and Lua UI - so it gets real GPU decode, frame-exact stepping,
native ProRes/HEVC support and lossless full-resolution export without
reinventing a video pipeline.

## Launching

Double-click **SlowmoPlayer.bat**, or drag a video onto it.

With no file given it **reopens the last video you were watching**, in the
**same window position** as last time, at the **UI scale you last set**.

## Controls

The bottom bar is drawn by [config/scripts/slowmo.lua](config/scripts/slowmo.lua)
and replaces mpv's default OSC entirely (so only one thing handles clicks).
It never covers the video - `video-margin-ratio` reserves real space for it,
so the image is letterboxed slightly instead of being overlaid.

| Key | Action |
|---|---|
| `Left` / `Right` | Seek 1 second |
| `Shift+Left` / `Shift+Right` | Step one frame |
| `s` | Slow-mo: conform source fps to 24fps (120fps = 5x slower) |
| `e` / right-click | Export current frame to `Exports/` |
| `<` / `>` or `PgUp` / `PgDn` | Previous / next video in the same folder |
| `Ctrl+A` | Sound settings |
| `9` / `0`, `m`, `a` | Volume, mute, audio track |
| `[` / `]`, `Backspace` | Speed nudge, reset speed |
| `Space`, `f` | Play/pause, fullscreen |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | UI scale up / down / reset |
| `Ctrl+P` | Show / hide the control panel window |
| `h` / `F1` | Shortcuts overlay |
| Wheel / side-scroll | Zoom / scrub |

## Portrait footage

UI scale is driven by window **height**, not width. A portrait clip fills a
tall narrow window - width-based scaling shrank the UI to nothing exactly
when the window was physically large, which was wrong for vertical video.
Height-based scaling gives portrait clips a large, readable bar, and 4K
landscape the same.

`Ctrl+=` / `Ctrl+-` adjust on top of that and are remembered between runs.
Every +/- key variant is bound (shifted, numpad, layout differences) because
any unbound variant falls through to mpv's own `Ctrl++` default, which
changes **audio delay** rather than the UI.

## fps colour code

The bar, seek fill and status text are coloured by the clip's real frame
rate: **yellow** at 30fps or below, **blue** around 60fps, **green** above
60fps - so a glance tells you whether a clip is worth slow-mo-ing. The
control panel mirrors the same colour.

## Control panel window

**ControlPanel.ps1** is a separate window for a second monitor, with a button
for every action, a live status readout, and an **Activity** log. It's off by
default - open it with `Ctrl+P`, the **Panel** button, or `ControlPanel.bat`.

It talks to the player over mpv's JSON IPC socket (real player commands, not
simulated keypresses), mirrors the fps accent colour, remembers its own window
position, and auto-reconnects if the player isn't up yet. While it's open,
messages that would pop up over the video go to its Activity log instead.
Closing either window closes both.

Note: the IPC socket name is fixed, so the panel drives one player instance at
a time - fine for normal use, not for two clips open side by side.

## Frame export

`e` grabs the raw decoded frame at native resolution before any overlay - not
a screen capture - and writes a lossless PNG to **`Exports/`** inside the
player's folder (not next to the source video, which may be read-only or
scattered). The source name is in the filename so exports never collide.

## GPU

`vo=gpu-next` + `gpu-api=d3d11` (libplacebo), `hwdec=auto-safe`,
`video-sync=display-resample`, and a 1GB demuxer cache so scrubbing large
4K120 files doesn't stall on disk.

Caveat: no Windows GPU exposes a ProRes decoder, so ProRes `.mov` decodes on
CPU via FFmpeg's SIMD path - still fast. Everything after decode (scaling,
colour, output) is GPU regardless. H.264/HEVC decode fully on GPU.

## Files

```
slowmo_player/
├── SlowmoPlayer.bat      launcher (drag videos onto it)
├── Launch.ps1            restores last video + window position
├── ControlPanel.bat      opens just the control panel
├── ControlPanel.ps1      the second-monitor control window
├── Exports/              exported frames land here
├── state_*.json          saved session state (auto-generated)
└── config/
    ├── mpv.conf          GPU, cache, export, IPC settings
    ├── input.conf        keybindings
    └── scripts/slowmo.lua  UI, slow-mo, export, state
```

Requires mpv: `winget install --id shinchiro.mpv -e`
