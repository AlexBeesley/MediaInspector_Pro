"""Speed ramp: one curve, evaluated in one place.

The curve is a list of (seconds, speed) points. Between two points the speed
eases with smoothstep in log-speed - 1x to 0.25x passes 0.5x halfway, which is
what halfway looks like - and it is flat before the first point and after the
last. Live playback and the export both call evaluate(), so the export is the
ramp that was previewed.

The export owns its timeline: for each output frame it asks which source
moment belongs there (source_time_at), instead of retiming through filter
timestamps, which the old build found the engine clips at its own --start
and --end.
"""

from __future__ import annotations

import bisect
import math
from dataclasses import dataclass

MIN_SPEED = 0.1
MAX_SPEED = 4.0


def normalise(points) -> list[tuple[float, float]]:
    out = []
    for p in points or []:
        try:
            t, s = float(p[0]), float(p[1])
        except (TypeError, ValueError, IndexError):
            continue
        if math.isfinite(t) and math.isfinite(s) and s > 0:
            out.append((t, min(MAX_SPEED, max(MIN_SPEED, s))))
    out.sort(key=lambda p: p[0])
    return out


def evaluate(points: list[tuple[float, float]], t: float) -> float:
    n = len(points)
    if n == 0:
        return 1.0
    if t <= points[0][0]:
        return points[0][1]
    if t >= points[-1][0]:
        return points[-1][1]
    i = bisect.bisect_right([p[0] for p in points], t) - 1
    (t0, s0), (t1, s1) = points[i], points[i + 1]
    u = (t - t0) / max(1e-9, t1 - t0)
    u = u * u * (3 - 2 * u)
    return math.exp(math.log(s0) + (math.log(s1) - math.log(s0)) * u)


@dataclass
class Timeline:
    """Source time <-> output time over [start, end], sampled finely enough
    that interpolation is well under a frame."""
    start: float
    end: float
    src: list[float]
    out: list[float]

    @property
    def out_seconds(self) -> float:
        return self.out[-1] if self.out else 0.0

    def source_time_at(self, out_t: float) -> float:
        if out_t <= 0:
            return self.start
        if out_t >= self.out[-1]:
            return self.end
        i = bisect.bisect_right(self.out, out_t) - 1
        o0, o1 = self.out[i], self.out[i + 1]
        u = (out_t - o0) / max(1e-12, o1 - o0)
        return self.src[i] + (self.src[i + 1] - self.src[i]) * u


def timeline(points, start: float, end: float, step: float = 1 / 480) -> Timeline:
    """Output clock = integral of 1/speed from start, by the trapezoid rule on
    a 1/480 s grid: exact on flat stretches, well inside a frame on eases."""
    pts = normalise(points)
    n = max(1, int(math.ceil((end - start) / step)))
    src = [start + (end - start) * k / n for k in range(n + 1)]
    out = [0.0]
    inv = [1 / evaluate(pts, t) for t in src]
    for k in range(1, n + 1):
        out.append(out[-1] + (src[k] - src[k - 1]) * (inv[k] + inv[k - 1]) / 2)
    return Timeline(start, end, src, out)


def default_range(points, duration: float) -> tuple[float, float] | None:
    """The curve plus a second either side."""
    pts = normalise(points)
    if not pts:
        return None
    a = max(0.0, pts[0][0] - 1)
    b = pts[-1][0] + 1
    if duration > 0:
        b = min(duration, b)
    return (a, b) if b > a else None


def output_fps(source_fps: float | None) -> float:
    """60 fps out of anything that has the frames for it; a slower source keeps
    its own rate rather than having every frame doubled."""
    fps = source_fps or 30.0
    return 60.0 if fps >= 59 else round(fps, 3)


def smooth_floor(source_fps: float | None) -> float | None:
    """Slowest speed that still shows 24 real frames a second."""
    return 24.0 / source_fps if source_fps else None


def dip(center: float, duration: float, source_fps: float | None) -> list[tuple[float, float]]:
    """Real time, easing down to slow motion through `center` and back up.
    As slow as stays smooth on high-fps footage; a quarter otherwise."""
    floor = smooth_floor(source_fps)
    slow = max(MIN_SPEED, floor) if floor and floor < 0.5 else 0.25
    pts = [(center - 0.9, 1.0), (center - 0.25, slow), (center + 0.25, slow), (center + 0.9, 1.0)]
    return [(t, s) for t, s in pts if 0 <= t <= duration]
