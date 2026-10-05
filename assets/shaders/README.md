# GPU shaders

Every `.glsl` file in this folder **except** those named `Upscale-*` shows
up as a checkbox in the control panel's **Upscale / Enhance** section.
Tick one and it is handed to `glsl-shaders`, so libplacebo runs it on the
GPU as part of the render pass — on video, photos and album art alike,
hardware decode or not.

`Upscale-ArtCNN.glsl` and `Upscale-FSR.glsl` are the reconstruction modes
on the panel's Mode dropdown (`CNN 2x` / `FSR`). They are applied by the
player when that mode is selected, not ticked here — ticking them as well
would run the network twice.

Order matters: shaders run in the order the panel lists them, which is
alphabetical by filename. That is why the cleanup stages are numbered —
`01-Deband` and `02-Denoise-Bilateral` sort ahead of `CAS`, so noise and
banding are gone before anything sharpens them. Anything you add yourself
follows the same rule: prefix it with a digit to pull it earlier in the
chain.

## Bundled

### Enhance — improve the picture

| File | What it does |
|---|---|
| `01-Deband.glsl` | Removes the contour rings that 8-bit quantisation leaves in skies, fades and slow gradients. Samples four neighbours far out on a randomly rotated cross; if all four sit within one code value of the centre — which is what a band *is* — the pixel becomes their average and the step dissolves into a slope. Real detail fails that test and is left untouched. |
| `02-Denoise-Bilateral.glsl` | Edge-preserving noise reduction over a 5×5 window. Each tap is weighted twice: by distance, and by how different its brightness is. Taps across an edge score near zero and never bleed, so grain and mosquito noise go while edges stay put. Judges similarity on luma, which lets it average chroma noise — the ugliest part of a high-ISO frame — hardest. |
| `CAS.glsl` | AMD FidelityFX Contrast Adaptive Sharpening, moderate (0.6). Sharpens in inverse proportion to local contrast, so edges gain definition, flat areas stay clean and blown highlights get nothing. Best paired with an upscaler. |
| `CAS-Strong.glsl` | The same filter at 0.92. Useful on soft or heavily-compressed sources; obvious on clean ones. |
| `Upscale-ArtCNN.glsl` | ArtCNN C4F16 DS. Trained 2× luma CNN that denoises and sharpens in the same pass. **CNN 2x** mode on the panel — the reconstruction path for doorbell cams, social re-encodes and anything else that looks softer than its pixel count. |
| `Upscale-FSR.glsl` | AMD FidelityFX Super Resolution 1.0.2 (EASU + RCAS). Edge-adaptive spatial upsample, capped at 2×. **FSR** mode on the panel. Cheaper than the CNN, weaker on mushy sources. |

Don't tick both CAS variants — they stack. Don't tick the `Upscale-*` files; pick the mode.

### Inspect — analyse the picture

These are measurement tools, not improvements. They deliberately destroy
the image to make one property of it legible, which is the point: they
answer a question about the frame that looking at the frame won't.

| File | What it does |
|---|---|
| `Inspect-Clipping.glsl` | Broadcast-monitor zebras. Red diagonal stripes wherever a channel has hit the top of the scale — detail no grade will recover — and blue stripes wherever every channel has hit the bottom. Everything in range passes through untouched, so it can be left on while scrubbing. Stripes rather than a flat tint so the picture still reads through the marked area. |
| `Inspect-FalseColor.glsl` | The exposure map from a cinema monitor. Luma is bucketed into bands and each is painted flat, so a glance places the frame on the scale instead of guessing from a picture your eyes have already adapted to. See the legend below. |
| `Inspect-FocusPeak.glsl` | Answers "is this frame actually sharp?" without pixel-peeping at 400%. A Sobel operator measures the luma gradient everywhere; anything above threshold is painted acid green over a desaturated backdrop. In-focus subjects grow a dense green rim, soft ones stay bare — easy to compare across a burst. |
| `Inspect-Luma.glsl` | Rec.709 luminance only, chroma discarded. Colour dominates perception; noise, softness, blocking and banding are all far easier to see once hue stops competing for attention. |
| `Inspect-ChromaBoost.glsl` | Saturation ×4 with brightness untouched. Exposes what hides in the colour channels at normal saturation: chroma noise in shadows, 4:2:0 subsampling smearing colour across sharp edges (red-on-black text is the classic tell), chroma blocking from a low bitrate, and any tint in what should be neutral grey. Not meant to be watchable. |

`Inspect-Luma` and `Inspect-ChromaBoost` are the two halves of the signal —
run them back to back on the same frame.

#### False-colour legend

| Band | Colour | Means |
|---|---|---|
| 0.000 – 0.025 | purple | clipped / crushed black, nothing recoverable |
| 0.025 – 0.100 | blue | deep shadow, close to the floor |
| 0.100 – 0.380 | grey (image luma) | ordinary shadow and lower midtone |
| 0.380 – 0.450 | green | 18% middle grey — park a grey card or a lit face's key side here |
| 0.450 – 0.560 | grey (image luma) | upper midtone |
| 0.560 – 0.700 | pink | caucasian skin-tone zone, roughly 55–70 IRE |
| 0.700 – 0.900 | grey (image luma) | highlight |
| 0.900 – 0.975 | yellow | one stop from clipping — the warning band |
| 0.975 – 1.000 | red | clipped white |

The grey bands show the image's own luma rather than a flat colour, so
shape and detail stay readable between the marked zones.

All the inspect shaders read the **encoded signal**, not scene light. On
ordinary SDR material the false-colour bands line up with IRE; on an HDR
source, or with a LUT ahead of them, only the red and purple ends stay
meaningful.

## Tuning

Every shader's thresholds are `#define`s at the top of the file with a
comment saying which way to push them. Edit, save, press **Rescan** — no
restart needed. Common ones:

- `01-Deband` — raise `THRESHOLD` if banding survives, lower it if fine
  texture starts smearing.
- `02-Denoise-Bilateral` — `SIGMA_R` is the aggression knob; `RADIUS 2`
  is 25 taps, `RADIUS 3` is 49 and roughly twice the cost.
- `Inspect-FocusPeak` — drop `THRESHOLD` on soft or low-contrast footage,
  raise it if noise is peaking.
- `Inspect-Clipping` — `HI`/`LO` are the trip points; loosen to 0.95/0.05
  to catch what is *nearly* gone.

## Adding more

Drop the `.glsl` file in this folder and press **Rescan** in the control
panel. Nothing else is needed; the panel finds it by extension.

Shader packs worth having on top of what ships here:

- **Anime4K** (`bloc97/Anime4K`) — line-art restore and upscale. Aimed at
  animation; overshoots on live footage.
- **ravu / nnedi3** (`bjin/mpv-prescalers`) — edge-directed prescalers,
  generated at several quality levels. ravu-zoom is the arbitrary-ratio
  cousin of ArtCNN's fixed 2×.

ArtCNN (MIT) and FSR (MIT) ship in this folder as the **CNN 2x** and
**FSR** modes. FSRCNNX is the older CNN this ArtCNN replaced.

For the driver-level AI upscaler on this machine (NVIDIA RTX Video Super
Resolution) use the panel's **RTX VSR** mode instead — that one is not a
shader and needs no files.
