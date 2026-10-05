"""Motion: where a clip moves most, and the time-slice still.

profile_energy() - mean frame-to-frame difference of small grey frames; its
peak is "the moment", where Snap to action puts a ramp's slow part.

timeslice() - a chronophotograph: a clean background plate (the per-pixel
median over the range, which a moving subject never wins) with the subject
cut out of N evenly spaced frames and laid over it in order. It needs a still
camera; a moving one has no single background to find.

Frames are numpy arrays; decoding them is the caller's job.
"""

from __future__ import annotations

import numpy as np


def profile_energy(frames: list[np.ndarray]) -> np.ndarray:
    """Per-frame mean absolute difference from the previous frame (0..255)."""
    e = np.zeros(len(frames), np.float32)
    for i in range(1, len(frames)):
        e[i] = np.abs(frames[i].astype(np.int16) - frames[i - 1].astype(np.int16)).mean()
    if len(frames) > 1:
        e[0] = e[1]
    return e


def peak_time(t: np.ndarray, e: np.ndarray) -> float | None:
    """Peak of a lightly smoothed curve: one jittery frame is not the moment."""
    n = len(e)
    if not n:
        return None
    r = max(1, round(n / 60))
    k = np.ones(2 * r + 1)
    sm = np.convolve(e, k, "same") / np.convolve(np.ones(n), k, "same")
    return float(t[int(np.argmax(sm))])


def pick(count: int, k: int) -> list[int]:
    """k indices evenly spread over 0..count-1, ends included."""
    if k <= 1:
        return [(count - 1) // 2]
    return sorted({round(i * (count - 1) / (k - 1)) for i in range(k)})


def median_plate(frames: list[np.ndarray]) -> np.ndarray:
    return np.median(np.stack(frames), axis=0).astype(np.uint8)


def _box_blur(m: np.ndarray, r: int) -> np.ndarray:
    if r < 1:
        return m
    d = 2 * r + 1
    pad = np.pad(m, r, mode="edge")
    c = np.cumsum(pad, axis=1)
    c = np.concatenate([np.zeros((c.shape[0], 1), c.dtype), c], axis=1)
    rows = (c[:, d:] - c[:, :-d]) / d
    c = np.cumsum(rows, axis=0)
    c = np.concatenate([np.zeros((1, c.shape[1]), c.dtype), c], axis=0)
    return (c[d:, :] - c[:-d, :]) / d


def composite(plate: np.ndarray, copies: list[np.ndarray], threshold: float = 28,
              fade: bool = True) -> np.ndarray:
    """plate and copies: uint8 HxWx3. A pixel counts as subject where it
    differs from the plate by about `threshold`; the mask ramps in around it
    and is softened so cut-outs do not have hard, noisy edges. Earlier copies
    are ghosts; the last, where the subject ends up, is solid."""
    lo, hi = threshold * 0.6, threshold * 1.4
    out = plate.astype(np.float32)
    base = plate.astype(np.int16)
    h, w = plate.shape[:2]
    r = max(1, round(max(w, h) / 900))
    n = len(copies)
    for i, f in enumerate(copies):
        d = np.abs(f.astype(np.int16) - base).max(axis=2).astype(np.float32)
        u = np.clip((d - lo) / (hi - lo), 0, 1)
        mask = _box_blur(u * u * (3 - 2 * u), r)
        o = 0.35 + 0.65 * (i / (n - 1)) if fade and n > 1 else 1.0
        a = (mask * o)[..., None]
        out += (f.astype(np.float32) - out) * a
    return np.clip(np.round(out), 0, 255).astype(np.uint8)


def timeslice(frames: list[np.ndarray], copies: int = 8, threshold: float = 28,
              fade: bool = True) -> tuple[np.ndarray, int]:
    """frames: evenly spaced RGB frames of the range. Returns the image and how
    many copies it holds."""
    count = len(frames)
    if not count:
        raise ValueError("no frames")
    plate = median_plate([frames[i] for i in pick(count, min(11, count))])
    idx = pick(count, min(max(2, copies), count))
    return composite(plate, [frames[i] for i in idx], threshold, fade), len(idx)
