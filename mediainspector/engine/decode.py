"""Decoding and encoding off the UI thread, through FFmpeg's libraries (PyAV).

Analysis and exports run here on their own decoder, never on the live player,
and they take the same filter stages as the picture (core/filters.py), so an
export matches what was on screen. FFmpeg ships inside the app; nothing else
needs installing.
"""

from __future__ import annotations

import os
import sys
from fractions import Fraction
from typing import Callable, Iterator

import av
import numpy as np

from ..core.filters import Stage

Cancelled = Callable[[], bool]


class Stop(Exception):
    """The job was cancelled."""


def _check(cancelled: Cancelled | None):
    if cancelled and cancelled():
        raise Stop


def open_input(path: str):
    """Open with GPU decoding where the platform has it, else the CPU. Frames
    come back in system memory either way, ready for filters."""
    if sys.platform == "win32":
        try:
            from av.codec.hwaccel import HWAccel
            return av.open(path, hwaccel=HWAccel(device_type="d3d11va", allow_software_fallback=True))
        except Exception:  # noqa: BLE001 - older PyAV or no device: CPU it is
            pass
    return av.open(path)


def rotation_stages(rotate: int) -> list[Stage]:
    """Clockwise display rotation as filters, applied after the crop (which is
    in unrotated source pixels, as the engine reports them)."""
    r = rotate % 360
    if r == 90:
        return [("transpose", "clock")]
    if r == 180:
        return [("hflip", ""), ("vflip", "")]
    if r == 270:
        return [("transpose", "cclock")]
    return []


class FrameGraph:
    """A decoder-side filter graph built from the same stages as the picture."""

    def __init__(self, stream, stages: list[Stage]):
        self.g = av.filter.Graph()
        prev = self.g.add_buffer(template=stream)
        for name, args in stages:
            f = self.g.add(name, args) if args else self.g.add(name)
            prev.link_to(f)
            prev = f
        sink = self.g.add("buffersink")
        prev.link_to(sink)
        self.g.configure()

    def run(self, frame) -> list:
        self.g.push(frame)
        out = []
        while True:
            try:
                out.append(self.g.pull())
            except (av.error.BlockingIOError, av.error.EOFError):
                return out


def iter_video(path: str, start: float, end: float, stages: list[Stage] | None = None,
               cancelled: Cancelled | None = None) -> Iterator[tuple[float, "av.VideoFrame"]]:
    """(seconds, frame) for every frame from start to end, filtered."""
    with open_input(path) as c:
        vs = c.streams.video[0]
        vs.thread_type = "AUTO"
        graph = FrameGraph(vs, stages) if stages else None
        if start > 0:
            c.seek(int(start / vs.time_base), stream=vs, backward=True, any_frame=False)
        for frame in c.decode(vs):
            _check(cancelled)
            if frame.pts is None:
                continue
            t = float(frame.pts * vs.time_base)
            if t < start - 1e-6:
                continue
            if t > end + 1e-6:
                break
            outs = graph.run(frame) if graph else [frame]
            for f in outs:
                yield t, f


def sample_frames(path: str, start: float, end: float, fps: float, stages: list[Stage],
                  fmt: str, cancelled: Cancelled | None = None) -> tuple[np.ndarray, list[np.ndarray]]:
    """Frames at about `fps` over the range, as numpy arrays in `fmt`
    ('gray' or 'rgb24'). Every frame is decoded; only these are kept."""
    times, frames = [], []
    step = 1.0 / fps
    want = start
    for t, f in iter_video(path, start, end, stages, cancelled):
        if t + 1e-6 >= want:
            times.append(t)
            frames.append(f.to_ndarray(format=fmt))
            want = t + step
    return np.array(times), frames


def decode_audio_mono(path: str, max_seconds: float, cancelled: Cancelled | None = None
                      ) -> tuple[np.ndarray, int, str]:
    """The first audio stream downmixed to mono float32 at its own rate, so
    the spectrum keeps every hertz the file has."""
    with av.open(path) as c:
        if not c.streams.audio:
            raise ValueError("no audio stream")
        a = c.streams.audio[0]
        rate = a.codec_context.sample_rate or a.rate
        codec = a.codec_context.name
        rs = av.AudioResampler(format="flt", layout="mono", rate=rate)
        chunks, n, limit = [], 0, int(max_seconds * rate)
        for frame in c.decode(a):
            _check(cancelled)
            for out in rs.resample(frame):
                arr = out.to_ndarray().reshape(-1)
                chunks.append(arr)
                n += len(arr)
            if n >= limit:
                break
        for out in rs.resample(None):
            chunks.append(out.to_ndarray().reshape(-1))
    x = np.concatenate(chunks) if chunks else np.zeros(0, np.float32)
    return x[:limit].astype(np.float32), int(rate), codec


# ---------------------------------------------------------------- encoding

class VideoWriter:
    """H.264 into an MP4, constant frame rate, optional AAC audio."""

    def __init__(self, path: str, fps: float, width: int, height: int, crf: int = 17,
                 audio_rate: int | None = None, audio_layout: str = "stereo"):
        self.c = av.open(path, "w")
        rate = Fraction(fps).limit_denominator(1001)
        self.v = self.c.add_stream("libx264", rate=rate)
        self.v.width, self.v.height = width - width % 2, height - height % 2
        self.v.pix_fmt = "yuv420p"
        self.v.options = {"crf": str(crf), "preset": "medium"}
        self.v.codec_context.time_base = 1 / rate
        self.a = None
        if audio_rate:
            self.a = self.c.add_stream("aac", rate=audio_rate)
            self.a.layout = audio_layout
            self.a_rs = av.AudioResampler(format="fltp", layout=audio_layout, rate=audio_rate)
        self.n = 0

    def write(self, frame: "av.VideoFrame", pts: int | None = None):
        f = frame.reformat(width=self.v.width, height=self.v.height, format="yuv420p")
        f.pts = self.n if pts is None else pts
        f.time_base = self.v.codec_context.time_base
        self.n = f.pts + 1
        for p in self.v.encode(f):
            self.c.mux(p)

    def write_audio(self, frame: "av.AudioFrame"):
        frame.pts = None
        for out in self.a_rs.resample(frame):
            for p in self.a.encode(out):
                self.c.mux(p)

    def close(self):
        for p in self.v.encode(None):
            self.c.mux(p)
        if self.a:
            for out in self.a_rs.resample(None):
                for p in self.a.encode(out):
                    self.c.mux(p)
            for p in self.a.encode(None):
                self.c.mux(p)
        self.c.close()


def safe_unlink(path: str):
    try:
        os.unlink(path)
    except OSError:
        pass
