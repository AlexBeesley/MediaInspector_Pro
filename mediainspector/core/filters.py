"""One filter graph for the picture and every export.

The old build applied brightness, contrast, saturation, gamma and hue as
renderer properties and everything else as filters, so a trimmed clip quietly
lost half the look. Here every adjustment is a filter, built once as a list of
(name, args) stages; the engine turns that list into its vf string and the
exporters into a decoder-side graph, so they cannot disagree.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

Stage = tuple[str, str]

LOOK_KEYS = ("temp", "tint", "brightness", "contrast", "highlights", "shadows", "gamma",
             "vibrance", "saturation", "hue", "sharpness", "vignette")


def _f(v: float) -> str:
    return f"{round(v, 4):g}"


def look_stages(look: dict) -> list[Stage]:
    a = lambda k: float(look.get(k) or 0)  # noqa: E731
    out: list[Stage] = []
    if a("temp"):
        out.append(("colortemperature", f"temperature={_f(6500 - a('temp') * 30)}"))
    if a("tint"):
        out.append(("colorbalance", f"gm={_f(a('tint') / 200)}"))
    # Not eq: it is a GPL-only filter and the export side's FFmpeg is the
    # LGPL build. lutyuv and hue exist in both, so both sides get one graph.
    if any(a(k) for k in ("brightness", "contrast", "gamma")):
        b, c, g = a("brightness") / 200, 1 + a("contrast") / 100, 2 ** (-a("gamma") / 50)
        out.append(("lutyuv", f"y='clip((pow(val/maxval,{_f(g)})-0.5)*{_f(c)}*maxval"
                              f"+maxval*{_f(0.5 + b)},minval,maxval)'"))
    if a("saturation") or a("hue"):
        out.append(("hue", f"h={_f(a('hue') * 1.8)}:s={_f(1 + a('saturation') / 100)}"))
    if a("vibrance"):
        out.append(("vibrance", f"intensity={_f(a('vibrance') / 100)}"))
    if a("shadows") or a("highlights"):
        sh = max(0.02, min(0.25 + a("shadows") / 500, 0.48))
        hi = max(0.52, min(0.75 + a("highlights") / 500, 0.98))
        out.append(("curves", f"all='0/0 0.25/{_f(sh)} 0.75/{_f(hi)} 1/1'"))
    if a("sharpness") > 0:
        out.append(("unsharp", f"5:5:{_f(a('sharpness') / 50)}:5:5:0"))
    elif a("sharpness") < 0:
        out.append(("gblur", f"sigma={_f(abs(a('sharpness')) / 50)}"))
    if a("vignette") > 0:
        out.append(("vignette", f"angle={_f(math.pi / 5 * a('vignette') / 100)}"))
    return out


TRAIL_MODES = ("off", "bright", "dark", "xray")


def trail_stages(mode: str, length: float) -> list[Stage]:
    """bright: each pixel keeps its brightest recent value and lets it fade.
    dark: the same through a negative. xray: the difference between
    consecutive frames, amplified - still parts go black, motion is lit.
    length 0..100 = trail decay 0.9..0.999, or X-ray gain."""
    if mode not in ("bright", "dark", "xray"):
        return []
    L = max(0.0, min(100.0, float(length)))
    if mode == "xray":
        g = _f(0.5 - 0.46 * L / 100)
        return [("tblend", "all_mode=difference"), ("colorlevels", f"rimax={g}:gimax={g}:bimax={g}")]
    lag = ("lagfun", f"decay={_f(1 - 10 ** -(1 + L / 50))}")
    if mode == "dark":
        return [("negate", ""), lag, ("negate", "")]
    return [lag]


@dataclass
class Crop:
    w: int
    h: int
    x: int
    y: int

    def stage(self) -> Stage:
        return ("crop", f"{self.w}:{self.h}:{self.x}:{self.y}")

    def as_text(self) -> str:
        return f"{self.w}:{self.h}:{self.x}:{self.y}"


@dataclass
class Graph:
    crop: Crop | None = None
    look: dict = field(default_factory=dict)
    trail: str = "off"
    trail_length: float = 50

    def stages(self, live: bool = True) -> list[Stage]:
        """live=False leaves out the trail: it is a viewing effect, and an
        export of a trail would depend on where playback happened to start."""
        s: list[Stage] = []
        if self.crop:
            s.append(self.crop.stage())
        s += look_stages(self.look)
        if live:
            s += trail_stages(self.trail, self.trail_length)
        return s


def mpv_vf(stages: list[Stage]) -> str:
    """The engine's vf value. Wrapped whole in lavfi=[...]: bare, mpv's own
    option parser eats the ':' separators and one rejected stage kills them all."""
    if not stages:
        return ""
    return "lavfi=[" + ",".join(f"{n}={a}" if a else n for n, a in stages) + "]"


SCALERS = {
    "lanczos": "lanczos",
    "spline": "spline",
    "bicubic": "bicubic",
    "neighbor": "neighbor",
}


def scale_stage(percent: float, scaler: str) -> Stage | None:
    """Export scale through a chosen resampler. A bare scale= is bilinear,
    which throws away exactly the detail an export exists to keep."""
    if not percent or abs(percent - 100) < 0.01 or percent <= 0:
        return None
    f = _f(percent / 100)
    flags = SCALERS.get(scaler, "lanczos") + "+accurate_rnd+full_chroma_int"
    return ("scale", f"w=trunc(iw*{f}/2)*2:h=trunc(ih*{f}/2)*2:flags={flags}")
