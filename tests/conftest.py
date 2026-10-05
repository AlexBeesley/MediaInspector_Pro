"""Fixtures are generated, not checked in: pink noise, lossy round trips, and
a 120 fps clip of a ball crossing a still background."""

import os
import sys
from fractions import Fraction

import av
import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")


def pink(seconds, rate, seed=1):
    n = int(seconds * rate)
    rng = np.random.default_rng(seed)
    spec = np.fft.rfft(rng.standard_normal(n))
    f = np.fft.rfftfreq(n, 1 / rate)
    spec[1:] /= np.sqrt(f[1:])
    spec[0] = 0
    x = np.fft.irfft(spec, n)
    return (x / np.abs(x).max() * 0.5).astype(np.float32)


def lowpass(x, rate, fc):
    spec = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1 / rate)
    spec /= np.sqrt(1 + (f / fc) ** 4)
    return np.fft.irfft(spec, len(x)).astype(np.float32)


def write_audio(path, x, rate, codec, bitrate=None, fmt="s16"):
    with av.open(path, "w") as c:
        s = c.add_stream(codec, rate=rate)
        s.layout = "stereo"
        if bitrate:
            s.bit_rate = bitrate
        frame_fmt = "fltp"
        rs = av.AudioResampler(format=s.codec_context.format.name if s.codec_context.format else fmt,
                               layout="stereo", rate=rate)
        stereo = np.stack([x, x]).astype(np.float32)
        hop = 1152
        for i in range(0, stereo.shape[1], hop):
            fr = av.AudioFrame.from_ndarray(np.ascontiguousarray(stereo[:, i:i + hop]), format=frame_fmt,
                                            layout="stereo")
            fr.sample_rate = rate
            for o in rs.resample(fr):
                for p in s.encode(o):
                    c.mux(p)
        for o in rs.resample(None):
            for p in s.encode(o):
                c.mux(p)
        for p in s.encode(None):
            c.mux(p)


def decode(path):
    from mediainspector.engine.decode import decode_audio_mono
    return decode_audio_mono(path, 60)


def write_ball_clip(path, seconds=3.0, fps=120, w=640, h=360):
    """A still textured background; a white ball moving left to right."""
    yy, xx = np.mgrid[0:h, 0:w]
    bg = np.stack([(xx * 255 // w), (yy * 255 // h), np.full_like(xx, 90)], axis=2).astype(np.uint8)
    with av.open(path, "w") as c:
        s = c.add_stream("libx264", rate=Fraction(fps))
        s.width, s.height, s.pix_fmt = w, h, "yuv420p"
        s.options = {"crf": "12"}
        n = int(seconds * fps)
        for i in range(n):
            img = bg.copy()
            cx, cy = int(40 + (w - 80) * i / n), int(h * 0.6)
            m = (xx - cx) ** 2 + (yy - cy) ** 2 < 30 ** 2
            img[m] = 255
            # A burst of extra motion near the 2 s mark: the "moment".
            if abs(i / fps - 2.0) < 0.15:
                img[:40, :] = (i * 37) % 255
            f = av.VideoFrame.from_ndarray(img, format="rgb24")
            for p in s.encode(f):
                c.mux(p)
        for p in s.encode(None):
            c.mux(p)


@pytest.fixture(scope="session")
def media(tmp_path_factory):
    d = tmp_path_factory.mktemp("media")
    p = lambda name: str(d / name)  # noqa: E731
    x44 = pink(12, 44100)
    write_audio(p("genuine.flac"), x44, 44100, "flac")
    write_audio(p("lossy128.mp3"), x44, 44100, "libmp3lame", 128000)
    write_audio(p("lossy192.mp3"), x44, 44100, "libmp3lame", 192000)
    write_audio(p("lossy320.mp3"), x44, 44100, "libmp3lame", 320000)
    for src, dst in (("lossy128.mp3", "fake128.flac"), ("lossy192.mp3", "fake192.flac")):
        y, rate, _ = decode(p(src))
        write_audio(p(dst), y, rate, "flac")
    write_audio(p("hires_real.flac"), pink(12, 96000, seed=2), 96000, "flac")
    # 44.1 kHz content resampled up to 96 kHz.
    write_audio(p("hires_up.flac"), _resampled(x44), 96000, "flac")
    write_audio(p("rolloff.flac"), lowpass(x44, 44100, 6000), 44100, "flac")
    write_audio(p("silent.flac"), np.zeros(44100 * 5, np.float32), 44100, "flac")
    write_ball_clip(p("ball120.mp4"))
    return p


def _resampled(x44):
    """A proper band-limited 44.1 -> 96 kHz resample, as a mastering tool would."""
    rs = av.AudioResampler(format="flt", layout="mono", rate=96000)
    fr = av.AudioFrame.from_ndarray(x44.reshape(1, -1), format="flt", layout="mono")
    fr.sample_rate = 44100
    out = [o.to_ndarray().reshape(-1) for o in rs.resample(fr)] + \
          [o.to_ndarray().reshape(-1) for o in rs.resample(None)]
    return np.concatenate(out).astype(np.float32)
