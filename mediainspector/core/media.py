"""What a file is, and where it sits among its neighbours.

Pure functions: nothing here touches the engine or the UI, so the rules that
decide what the window does with a file can be tested on their own.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

VIDEO = frozenset("""
mp4 mov m4v mkv avi webm wmv flv mpg mpeg m2ts mts ts m2v vob 3gp 3g2 ogv ogm
mxf asf rm rmvb divx f4v y4m gif apng dv amv nut roq h264 h265 hevc av1 ivf
""".split())

PHOTO = frozenset("""
jpg jpeg jpe jfif png bmp webp tif tiff heic heif avif jxl jp2 j2k jpf jxr tga
targa exr hdr pic dds ppm pgm pbm pnm pam pcx sgi xbm xpm ico cur qoi
""".split())

# Camera raw: FFmpeg opens some bodies and refuses others. Listed so folder
# browsing still walks past them.
RAW = frozenset("""
dng cr2 cr3 nef nrw arw srf sr2 raf orf rw2 pef raw 3fr erf kdc mos mrw x3f
""".split())

AUDIO = frozenset("""
mp3 wav flac aac m4a m4b ogg oga opus wma aiff aif aifc alac ape wv mka dsf dff
ac3 eac3 dts dtshd thd mp2 mpa spx tta caf au amr awb gsm shn mpc ra voc w64
8svx aa3 oma mid midi
""".split())

ALL = VIDEO | PHOTO | RAW | AUDIO

KINDS = ("video", "photo", "audio")


def ext_of(path: str) -> str:
    return os.path.splitext(path)[1][1:].lower()


def detect_kind(track_list: list[dict] | None, frame_count: int | None = None) -> str:
    """The kind from what was decoded, not from the extension.

    An MP3 with cover art is audio, a one-frame MKV is a photo, and an animated
    GIF or WebP - reported as an image track with many frames - is video.
    """
    tracks = track_list or []
    video = next((t for t in tracks if t.get("type") == "video" and t.get("selected")), None)
    if video is None:
        video = next((t for t in tracks if t.get("type") == "video"), None)
    audio = next((t for t in tracks if t.get("type") == "audio"), None)
    if video and video.get("albumart"):
        return "audio"
    if video and video.get("image"):
        return "video" if (frame_count or 0) > 1 else "photo"
    if video:
        return "video"
    if audio:
        return "audio"
    return "video"


def display_shape(w: int, h: int, container_rotate: int = 0, user_rotate: int = 0) -> tuple[int, int]:
    """Width and height as they appear on screen.

    Every size the engine reports is unrotated: a phone's portrait clip comes
    back as 3840x2160 with a rotate-90 flag. A quarter turn either way swaps
    the sides.
    """
    turn = ((container_rotate or 0) + (user_rotate or 0)) % 180
    return (h, w) if turn == 90 else (w, h)


# Accent per kind and, for video, per frame-rate tier: a glance says whether a
# clip is worth slowing down.
TIER_COLOURS = {
    "yellow": "#ffd000",
    "blue": "#3898ff",
    "green": "#40d078",
    "photo": "#f0a858",
    "audio": "#58c8f0",
}


def tier(kind: str, fps: float | None) -> str:
    if kind in ("photo", "audio"):
        return kind
    if fps and fps > 60.5:
        return "green"
    if fps and fps > 30.5:
        return "blue"
    return "yellow"


SLOWMO_TARGET_FPS = 24.0


def conform_speed(fps: float | None) -> float | None:
    """Speed that plays the source's frames at 24 per second, or None when the
    source is already at or below it."""
    if not fps or fps <= SLOWMO_TARGET_FPS + 0.5:
        return None
    return SLOWMO_TARGET_FPS / fps


def fmt_time(t: float | None) -> str:
    if t is None or t != t:
        return "0:00"
    t = max(0.0, t)
    hh, rem = divmod(int(t), 3600)
    mm, ss = divmod(rem, 60)
    return f"{hh}:{mm:02d}:{ss:02d}" if hh else f"{mm}:{ss:02d}"


def fmt_timecode(t: float) -> str:
    """HH.MM.SS.mmm - file-name safe."""
    t = max(0.0, t)
    ms = int(round((t - int(t)) * 1000)) % 1000
    hh, rem = divmod(int(t), 3600)
    mm, ss = divmod(rem, 60)
    return f"{hh:02d}.{mm:02d}.{ss:02d}.{ms:03d}"


def human_bytes(n: int | None) -> str:
    if not n:
        return "?"
    size = float(n)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return f"{size:.0f} {unit}" if unit == "B" else f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} GB"


# ---------------------------------------------------------------- browsing

@dataclass(frozen=True)
class Step:
    path: str
    index: int      # 1-based, for "(3/12)"
    count: int


def siblings(folder: str, browse_all: bool) -> list[str]:
    allowed = ALL if browse_all else VIDEO
    try:
        names = [n for n in os.listdir(folder)
                 if ext_of(n) in allowed and os.path.isfile(os.path.join(folder, n))]
    except OSError:
        return []
    return sorted(names, key=str.lower)


def step(path: str, offset: int, browse_all: bool) -> Step | None:
    """The file `offset` places along from `path` in its folder.

    The open file need not be in the list at all - a photo while the scope is
    video only - so it steps from where that file would sort, rather than
    jumping to the top of the folder. Wraps at both ends.
    """
    folder, name = os.path.split(path)
    files = siblings(folder, browse_all)
    if not files:
        return None
    key = name.lower()
    if name in files:
        i = (files.index(name) + offset) % len(files)
    else:
        before = sum(1 for f in files if f.lower() < key)
        if offset >= 0:
            i = before % len(files)
        else:
            i = (before - 1) % len(files)
    return Step(os.path.join(folder, files[i]), i + 1, len(files))
