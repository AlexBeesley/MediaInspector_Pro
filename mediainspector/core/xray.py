"""Audio X-ray: a whole-file spectrogram and a verdict on what the file is.

A lossy encoder throws away the top of the spectrum first: LAME at 128 kbps
low-passes at about 16-17 kHz, and the cut is a brick wall, ~60 dB gone in a
few hundred hertz. Decoding that MP3 and saving it as FLAC keeps the wall, so
a cliff inside a lossless container is the fingerprint of an upconvert. Real
recordings roll off gradually, if at all.

Input is mono float samples in -1..1; decoding is the caller's job.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import re

import numpy as np

FFT_N = 4096        # ~11 Hz bins at 44.1 kHz: fine enough to place a cutoff
ROWS = 256          # overview height, linear in frequency like the live view
MAX_COLS = 1200
MAX_SECONDS = 1800  # half an hour


@dataclass
class Verdict:
    level: str      # genuine | suspect | lossy | unknown
    title: str
    detail: str


@dataclass
class Result:
    sample_rate: int
    seconds: float
    cols: int
    rows: int
    image: np.ndarray            # uint8 [cols, rows], row 0 = 0 Hz
    curve: np.ndarray            # float32 average spectrum, dB, 512 points
    ref_db: float = 0.0
    cutoff_hz: float = 0.0
    drop_db: float = 0.0
    extent_hz: float = 0.0
    band_hz: float = 0.0
    silent: bool = False
    truncated: bool = False
    verdict: Verdict = field(default_factory=lambda: Verdict("unknown", "", ""))


def _db(p):
    return 10 * np.log10(p + 1e-20)


def _power(frames: np.ndarray) -> np.ndarray:
    """Power spectra of Hann-windowed frames, bins 0..N/2-1, normalised so a
    full-scale sine reads 0 dB."""
    n = frames.shape[-1]
    win = np.hanning(n)
    spec = np.fft.rfft(frames * win, axis=-1)[..., : n // 2]
    return (np.abs(spec) ** 2) / ((n / 4) ** 2)


def analyse(samples: np.ndarray, sample_rate: int, cancelled=lambda: False) -> Result:
    x = np.asarray(samples, dtype=np.float32)
    total = len(x)
    n, half = FFT_N, FFT_N // 2
    usable = max(0, total - n)
    cols = 0 if total < n else max(1, min(MAX_COLS, usable // (n // 2) + 1))

    image = np.zeros((cols, ROWS), np.uint8)
    avg = np.zeros(half)
    if cols:
        starts = np.round(np.arange(cols) * (usable / max(1, cols - 1))).astype(int) if cols > 1 else np.array([0])
        col_db = np.empty((cols, ROWS), np.float32)
        per = half // ROWS
        for c0 in range(0, cols, 64):
            if cancelled():
                raise InterruptedError
            idx = starts[c0:c0 + 64]
            frames = np.stack([x[s:s + n] for s in idx])
            p = _power(frames)
            avg += p.sum(axis=0)
            col_db[c0:c0 + len(idx)] = _db(p.reshape(len(idx), ROWS, per).mean(axis=2))
        avg /= cols
        # Scaled to the file's own loudest point, so a quiet recording is still
        # a picture rather than a black rectangle.
        floor = col_db.max() - 100
        image = np.clip(np.round((col_db - floor) / 100 * 255), 0, 255).astype(np.uint8)

    spec_db = _db(avg)
    curve = _db(avg.reshape(512, -1).mean(axis=1)).astype(np.float32)
    r = Result(sample_rate, total / sample_rate, cols, ROWS, image, curve)
    _find_cutoff(r, spec_db)
    return r


def _moving_mean(a: np.ndarray, w: int) -> np.ndarray:
    k = np.ones(2 * w + 1)
    num = np.convolve(a, k, mode="same")
    den = np.convolve(np.ones_like(a), k, mode="same")
    return num / den


def _find_cutoff(r: Result, spec: np.ndarray) -> None:
    """Where the content stops, and whether it stops like an encoder or like a
    recording. A cliff is a drop of 20 dB or more across 0.8 kHz that stays down
    all the way to the top of the band; anything gentler is a roll-off."""
    half = len(spec)
    nyq = r.sample_rate / 2
    bin_hz = nyq / half

    def b(hz):
        return int(max(0, min(half - 1, round(hz / bin_hz))))

    sm = _moving_mean(spec, max(1, round(100 / bin_hz)))
    ref = float(np.median(sm[b(1000):b(min(8000, nyq * 0.8))])) if r.cols else -200.0
    r.ref_db = ref
    if not np.isfinite(ref) or ref < -110:
        r.silent = True
        return

    above_ref = np.nonzero(sm > ref - 60)[0]
    r.extent_hz = float(above_ref[-1] * bin_hz) if len(above_ref) else 0.0

    # Where anything rises out of the noise floor at the top of the band. An
    # upsampled file is dither and nothing else above its old Nyquist, however
    # the resampler shaped the slope. Content right up to Nyquist leaves no
    # floor to measure against: the band is full.
    floor_db = float(np.median(sm[b(nyq * 0.9):b(nyq * 0.98)]))
    if floor_db > ref - 40:
        r.band_hz = nyq
    else:
        lit = np.nonzero(sm[: b(nyq * 0.9)] > floor_db + 10)[0]
        r.band_hz = float(lit[-1] * bin_hz) if len(lit) else 0.0

    a = max(2, round(400 / bin_hz))
    lo, hi = b(min(10000, nyq * 0.45)), half - a - b(150)
    if hi <= lo:
        return
    cs = np.concatenate([[0.0], np.cumsum(sm)])
    ks = np.arange(lo, hi)
    before = (cs[ks] - cs[ks - a]) / a
    after = (cs[ks + 1 + a] - cs[ks + 1]) / a
    drops = before - after
    best = int(ks[np.argmax(drops)])
    best_drop = float(drops.max())
    if best_drop <= 0:
        return
    below = float(sm[best - 2 * a:best - a].mean())
    above = float(sm[best + a:half - b(150)].mean())
    if best_drop >= 20 and below - above >= 25:
        k = best - a
        while k < half - 1 and sm[k] > below - 10:
            k += 1
        r.cutoff_hz = k * bin_hz
        r.drop_db = below - above


LOSSLESS = re.compile(r"^(flac|alac|pcm_|wavpack|ape|tta|truehd|mlp|shorten|tak|dsd_|s302m)")


def bitrate_guess(hz: float) -> str:
    """What LAME's default low-pass leaves at each bitrate; AAC and Vorbis make
    similar choices for the same reasons."""
    for limit, label in ((11500, "64 kbps or less"), (15000, "about 96 kbps"), (17200, "about 128 kbps"),
                         (18000, "about 160 kbps"), (19300, "about 192 kbps"), (19900, "about 256 kbps")):
        if hz < limit:
            return label
    return "about 320 kbps"


def khz(hz: float) -> str:
    return f"{hz / 1000:.1f} kHz"


def verdict(r: Result, codec: str | None) -> Verdict:
    codec = (codec or "").lower()
    lossless = bool(LOSSLESS.match(codec))
    nyq = r.sample_rate / 2
    name = codec or "audio"

    if r.silent or not r.cols:
        return Verdict("unknown", "Too quiet to judge", "There is not enough signal to read a spectrum from.")
    cliff = 0 < r.cutoff_hz < nyq * 0.93
    # A 44.1 or 48 kHz master resampled up still ends a little past its old
    # Nyquist, where the resampler's slope runs out: 30 kHz clears that and
    # sits below what a real hi-res recording carries.
    if lossless and r.sample_rate >= 88000 and 0 < r.band_hz < 30000:
        return Verdict("suspect", "Hi-res container, CD-band content",
                       f"Sampled at {khz(r.sample_rate)}, but nothing rises out of the noise above "
                       f"{khz(r.band_hz)}: most likely upsampled from 44.1 or 48 kHz.")
    if lossless and cliff and r.cutoff_hz < 20500:
        return Verdict("suspect", "Probably upconverted from lossy",
                       f"{name.upper()} with a brick-wall cutoff at {khz(r.cutoff_hz)} ({round(r.drop_db)} dB down): "
                       f"the mark a lossy encoder at {bitrate_guess(r.cutoff_hz)} leaves. "
                       "Real recordings roll off gradually.")
    if lossless:
        return Verdict("genuine", "Looks genuinely lossless",
                       f"Content reaches {khz(r.extent_hz or nyq)} with no encoder cutoff.")
    if cliff:
        return Verdict("lossy", f"Lossy {name}, cut at {khz(r.cutoff_hz)}",
                       f"Bandwidth typical of {bitrate_guess(r.cutoff_hz)}.")
    return Verdict("lossy", f"Lossy {name}, full bandwidth",
                   f"No low-pass below {khz(nyq)}: a high-bitrate or modern encoder.")
