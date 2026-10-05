"""Window and view geometry: pure arithmetic, so it is tested rather than
eyeballed."""

from __future__ import annotations

import math

MIN_PANEL = 340
MIN_VIDEO = 320


def fit_window(media_w: int, media_h: int, chrome_w: int, chrome_h: int,
               area_w: int, area_h: int, min_w: int = 900, min_h: int = 560) -> tuple[int, int] | None:
    """Content size that puts the picture at the media's own size, plus the
    chrome around it, scaled down to fit 96% x 94% of the work area."""
    if media_w < 1 or media_h < 1:
        return None
    max_w = area_w * 0.96 - chrome_w
    max_h = area_h * 0.94 - chrome_h
    if max_w < 200 or max_h < 200:
        return None
    s = min(1.0, max_w / media_w, max_h / media_h)
    return (max(min_w, round(media_w * s + chrome_w)), max(min_h, round(media_h * s + chrome_h)))


def auto_panel_width(total_w: int, video_h: int, aspect: float,
                     min_panel: int = MIN_PANEL, min_video: int = MIN_VIDEO) -> int:
    """Give the picture the width its shape wants at this height; the panel
    takes the rest, never below one column of cards."""
    want_video = video_h * aspect
    return clamp_panel(total_w - want_video, total_w, min_panel, min_video)


def clamp_panel(px: float, total_w: int, min_panel: int = MIN_PANEL, min_video: int = MIN_VIDEO) -> int:
    hi = max(min_panel, total_w - min_video)
    return int(round(max(min_panel, min(px, hi))))


def actual_size_zoom(src_w: int, shown_w: float, current_zoom: float) -> float | None:
    """The engine's log2 zoom that puts one source pixel on one screen pixel,
    from the width the picture actually occupies now (so letterboxing and the
    current zoom are already accounted for)."""
    if src_w < 1 or shown_w <= 0:
        return None
    fit_w = shown_w / (2 ** current_zoom)
    return math.log2(src_w / fit_w)


ZOOM_MIN, ZOOM_MAX = -2.0, 4.0   # 1/4x .. 16x of fit


def clamp_zoom(z: float) -> float:
    return max(ZOOM_MIN, min(ZOOM_MAX, z))


def even(n: float) -> int:
    n = int(round(n))
    if n < 2:
        return 2
    return n - (n % 2)


def ratio_rect(src_w: int, src_h: int, rw: int, rh: int) -> tuple[int, int]:
    """Largest even rectangle of ratio rw:rh inside the source."""
    if src_w < 2 or src_h < 2 or rw <= 0 or rh <= 0:
        return src_w, src_h
    if src_w / src_h > rw / rh:
        h = even(src_h)
        w = even(h * rw / rh)
    else:
        w = even(src_w)
        h = even(w * rh / rw)
    return min(w, even(src_w)), min(h, even(src_h))


# ---------------------------------------------------------------- crop mapping
#
# The crop is kept in decoded (unrotated) source pixels, which is what the
# filter cuts. The editor works on the picture as shown, which a phone clip's
# rotate-90 flag turns on its side. These two map between them for clockwise
# rotations of 0, 90, 180 and 270 degrees.

def _norm_rot(rot: int) -> int:
    return (rot or 0) % 360


def view_from_src(x0: float, y0: float, x1: float, y1: float, src_w: int, src_h: int,
                  rot: int) -> tuple[float, float, float, float]:
    """Source pixel rectangle -> rectangle on the shown picture, in 0..1."""
    a, b, c, d = x0 / src_w, y0 / src_h, x1 / src_w, y1 / src_h
    r = _norm_rot(rot)
    if r == 90:
        return 1 - d, a, 1 - b, c
    if r == 180:
        return 1 - c, 1 - d, 1 - a, 1 - b
    if r == 270:
        return b, 1 - c, d, 1 - a
    return a, b, c, d


def src_from_view(u0: float, v0: float, u1: float, v1: float, src_w: int, src_h: int,
                  rot: int) -> tuple[float, float, float, float]:
    """Rectangle on the shown picture (0..1) -> source pixels."""
    r = _norm_rot(rot)
    if r == 90:
        a, b, c, d = v0, 1 - u1, v1, 1 - u0
    elif r == 180:
        a, b, c, d = 1 - u1, 1 - v1, 1 - u0, 1 - v0
    elif r == 270:
        a, b, c, d = 1 - v1, u0, 1 - v0, u1
    else:
        a, b, c, d = u0, v0, u1, v1
    return a * src_w, b * src_h, c * src_w, d * src_h


def clamp_crop(x: float, y: float, w: float, h: float, src_w: int, src_h: int,
               min_side: int = 16) -> tuple[int, int, int, int]:
    """Inside the frame, at least min_side, even everywhere the filter cares."""
    w = even(max(min_side, min(w, src_w)))
    h = even(max(min_side, min(h, src_h)))
    x = max(0, min(int(round(x)), src_w - w))
    y = max(0, min(int(round(y)), src_h - h))
    return w, h, x - x % 2, y - y % 2
