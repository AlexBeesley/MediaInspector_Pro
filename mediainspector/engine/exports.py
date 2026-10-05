"""The work behind every export and analysis. Each function runs on a job
thread, checks `cancelled` as it goes, and reports progress 0..1."""

from __future__ import annotations

import os
import time
from dataclasses import dataclass
from typing import Callable

import numpy as np
from PIL import Image

from ..core import motion, ramp, xray
from ..core.filters import Stage, scale_stage
from ..core.media import fmt_timecode
from .decode import (FrameGraph, Stop, VideoWriter, decode_audio_mono, open_input,
                     rotation_stages, safe_unlink, sample_frames)

Progress = Callable[[float], None]


def _noop(_):
    pass


def unique_path(folder: str, stem: str, ext: str) -> str:
    """Never overwrite: name_2, name_3... when the name is taken."""
    os.makedirs(folder, exist_ok=True)
    stem = "".join("_" if ch in '<>:"/\\|?*' else ch for ch in stem)
    p = os.path.join(folder, f"{stem}.{ext}")
    n = 2
    while os.path.exists(p):
        p = os.path.join(folder, f"{stem}_{n}.{ext}")
        n += 1
    return p


def stamp() -> str:
    return time.strftime("%H%M%S")


# ---------------------------------------------------------------- frame

PIL_RESAMPLE = {
    "lanczos": Image.Resampling.LANCZOS,
    "spline": Image.Resampling.BICUBIC,   # Pillow has no spline; bicubic is its nearest kin
    "bicubic": Image.Resampling.BICUBIC,
    "neighbor": Image.Resampling.NEAREST,
}


def save_frame(img: Image.Image, out: str, fmt: str, scale: float, scaler: str) -> tuple[int, int]:
    """The engine's decoded, filtered frame, resampled if asked, saved."""
    if scale and abs(scale - 100) > 0.01 and scale > 0:
        w = max(2, round(img.width * scale / 100))
        h = max(2, round(img.height * scale / 100))
        img = img.resize((w, h), PIL_RESAMPLE.get(scaler, Image.Resampling.LANCZOS))
    if fmt == "jpg":
        img.convert("RGB").save(out, "JPEG", quality=97, subsampling=0)
    elif fmt == "webp":
        img.save(out, "WEBP", lossless=True)
    else:
        img.save(out, "PNG", compress_level=6)
    return img.width, img.height


def frame_name(src: str, kind: str, frame: int, t: float) -> str:
    base = os.path.splitext(os.path.basename(src))[0]
    if kind == "photo":
        return f"{base}_export_{stamp()}"
    return f"{base}_frame{frame:06d}_{fmt_timecode(t)}"


# ---------------------------------------------------------------- clips

@dataclass
class ClipSpec:
    src: str
    out: str
    start: float
    end: float
    stages: list           # crop + look, as the picture has them
    rotate: int = 0
    scale: float = 100
    scaler: str = "lanczos"

    def all_stages(self) -> list[Stage]:
        s = list(self.stages) + rotation_stages(self.rotate)
        sc = scale_stage(self.scale, self.scaler)
        if sc:
            s.append(sc)
        return s


def _fps(stream) -> float:
    r = stream.average_rate or stream.guessed_rate or 30
    return float(r)


def trim(spec: ClipSpec, cancelled, progress: Progress = _noop) -> str:
    """In to Out as H.264 + AAC, with the picture's crop and look applied."""
    span = max(1e-3, spec.end - spec.start)
    writer = None
    try:
        with open_input(spec.src) as c:
            vs = c.streams.video[0]
            vs.thread_type = "AUTO"
            aus = c.streams.audio[0] if c.streams.audio else None
            fps = _fps(vs)
            graph = FrameGraph(vs, spec.all_stages())
            if spec.start > 0:
                c.seek(int(spec.start / vs.time_base), stream=vs, backward=True)
            last_pts = -1
            streams = [vs] + ([aus] if aus else [])
            for packet in c.demux(*streams):
                if cancelled():
                    raise Stop
                for frame in packet.decode():
                    if frame.pts is None:
                        continue
                    t = float(frame.pts * frame.time_base)
                    if packet.stream.type == "audio":
                        if writer and writer.a and spec.start <= t <= spec.end:
                            writer.write_audio(frame)
                        continue
                    if t < spec.start - 1e-6:
                        continue
                    if t > spec.end + 1e-6:
                        raise StopIteration
                    for f in graph.run(frame):
                        if writer is None:
                            writer = VideoWriter(spec.out, fps, f.width, f.height, crf=18,
                                                 audio_rate=aus.codec_context.sample_rate if aus else None)
                        pts = round((t - spec.start) * fps)
                        if pts > last_pts:
                            writer.write(f, pts)
                            last_pts = pts
                    progress(min(1.0, (t - spec.start) / span))
    except StopIteration:
        pass
    except Stop:
        if writer:
            writer.close()
            writer = None
        safe_unlink(spec.out)
        raise
    if writer is None:
        raise ValueError("no frames in that range")
    writer.close()
    return spec.out


def ramp_export(spec: ClipSpec, points, source_fps: float, cancelled, progress: Progress = _noop) -> tuple[str, float]:
    """The ramp as a clip. This owns its clock: each output frame asks the
    timeline which source moment belongs there and shows the latest source
    frame at or before it. No audio."""
    tl = ramp.timeline(points, spec.start, spec.end)
    out_fps = ramp.output_fps(source_fps)
    total = max(1, int(round(tl.out_seconds * out_fps)))
    writer = None
    try:
        with open_input(spec.src) as c:
            vs = c.streams.video[0]
            vs.thread_type = "AUTO"
            graph = FrameGraph(vs, spec.all_stages())
            if spec.start > 0:
                c.seek(int(spec.start / vs.time_base), stream=vs, backward=True)
            frames = c.decode(vs)
            current = None          # latest filtered frame at or before the wanted time
            pending = None          # decoded but past the wanted time
            k = 0
            while k < total:
                if cancelled():
                    raise Stop
                want = tl.source_time_at(k / out_fps)
                while True:
                    if pending is None:
                        try:
                            nxt = next(frames)
                        except StopIteration:
                            break
                        if nxt.pts is None:
                            continue
                        pending = (float(nxt.pts * vs.time_base), nxt)
                    t, fr = pending
                    if t < spec.start - 1e-6:
                        pending = None
                        continue
                    if t <= want + 1e-6 or current is None:
                        outs = graph.run(fr)
                        if outs:
                            current = outs[-1]
                        pending = None
                        continue
                    break
                if current is None:
                    break
                if writer is None:
                    writer = VideoWriter(spec.out, out_fps, current.width, current.height)
                writer.write(current, k)
                k += 1
                if k % 15 == 0:
                    progress(k / total)
    except Stop:
        if writer:
            writer.close()
            writer = None
        safe_unlink(spec.out)
        raise
    if writer is None:
        raise ValueError("no frames in that range")
    writer.close()
    return spec.out, tl.out_seconds


# ---------------------------------------------------------------- motion

def _fit_stage(max_side: int) -> Stage:
    return ("scale", f"w='min(iw,{max_side})':h='min(ih,{max_side})':force_original_aspect_ratio=decrease"
                     ":force_divisible_by=2:flags=area")


def motion_profile(src: str, start: float, end: float, crop_stages, rotate: int, source_fps: float,
                   cancelled, progress: Progress = _noop) -> dict:
    stages = list(crop_stages) + rotation_stages(rotate) + [("scale", "w=160:h=-2:flags=area")]
    t, frames = sample_frames(src, start, end, min(30.0, source_fps or 30.0), stages, "gray", cancelled)
    e = motion.profile_energy(frames)
    progress(1.0)
    return {"path": src, "t": t.tolist(), "e": e.tolist(), "peak": motion.peak_time(t, e)}


def timeslice(src: str, out_folder: str, start: float, end: float, crop_stages, rotate: int,
              source_fps: float, copies: int, threshold: float, fade: bool, cancelled,
              progress: Progress = _noop, max_side: int = 2560) -> dict:
    span = max(0.05, end - start)
    want = max(copies, 11) * 2
    fps = min(source_fps or 60.0, max(1.0, want / span))
    stages = list(crop_stages) + rotation_stages(rotate) + [_fit_stage(max_side)]
    _, frames = sample_frames(src, start, end, fps, stages, "rgb24", cancelled)
    if not frames:
        raise ValueError("no frames in that range")
    progress(0.6)
    img, n = motion.timeslice(frames, copies, threshold, fade)
    base = os.path.splitext(os.path.basename(src))[0]
    out = unique_path(out_folder, f"{base}_timeslice_{stamp()}", "png")
    Image.fromarray(img).save(out, "PNG", compress_level=6)
    progress(1.0)
    return {"path": out, "copies": n, "w": img.shape[1], "h": img.shape[0]}


# ---------------------------------------------------------------- X-ray

def xray_job(src: str, cancelled, progress: Progress = _noop) -> dict:
    samples, rate, codec = decode_audio_mono(src, xray.MAX_SECONDS, cancelled)
    progress(0.5)
    try:
        r = xray.analyse(samples, rate, cancelled)
    except InterruptedError:
        raise Stop
    r.truncated = r.seconds >= xray.MAX_SECONDS - 1
    r.verdict = xray.verdict(r, codec)
    progress(1.0)
    return {"path": src, "result": r, "codec": codec}


__all__ = ["ClipSpec", "trim", "ramp_export", "timeslice", "motion_profile", "xray_job",
           "save_frame", "frame_name", "unique_path", "np"]
