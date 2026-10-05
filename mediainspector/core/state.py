"""The one state model.

Settings persist between runs; Live is what the engine and the app are doing
now. Both are typed, each field has one writer, and listeners are told which
fields changed. The UI only reads from here and sends commands - it holds no
copy of playback state, which is what let the old panel and on-picture bar
disagree.
"""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import asdict, dataclass, field, fields
from typing import Any, Callable

from .filters import Crop

Listener = Callable[[set[str]], None]


@dataclass
class Settings:
    window: dict = field(default_factory=dict)        # x, y, w, h, maximized
    panel_width: int = 440
    auto_panel: bool = True
    fit_window: bool = True
    ui_scale: float = 1.0
    browse_all: bool = False
    last_file: str = ""
    open_cards: dict = field(default_factory=dict)
    volume: float = 100.0
    mute: bool = True
    loop: bool = True
    export_dir: str = ""
    export_format: str = "jpg"
    export_scale: float = 100.0
    export_scaler: str = "lanczos"
    upscale: str = "off"                               # off | cnn | fsr
    upscale_factor: float = 2.0
    shaders: list = field(default_factory=list)        # file names in the shader folder
    inspect: str = "off"                               # an Inspect-* shader name, or off
    scaler: str = "ewa_lanczossharp"
    dscaler: str = "mitchell"
    look: dict = field(default_factory=dict)
    spectrogram: bool = False
    trail_length: float = 50.0
    ts_copies: int = 8
    ts_threshold: int = 28
    ts_fade: bool = True
    ramps: dict = field(default_factory=dict)          # path -> [[t, speed], ...]

    MAX_RAMPS = 100

    @classmethod
    def load(cls, path: str) -> "Settings":
        """A missing or unreadable file gives defaults; a field of the wrong
        type is dropped rather than trusted."""
        s = cls()
        try:
            with open(path, encoding="utf-8") as f:
                raw = json.load(f)
        except (OSError, ValueError):
            return s
        if not isinstance(raw, dict):
            return s
        for fd in fields(cls):
            if fd.name in raw:
                v, default = raw[fd.name], getattr(s, fd.name)
                if isinstance(default, bool):
                    ok = isinstance(v, bool)
                elif isinstance(default, (int, float)):
                    ok = isinstance(v, (int, float)) and not isinstance(v, bool)
                else:
                    ok = isinstance(v, type(default))
                if ok:
                    setattr(s, fd.name, v)
        return s

    def save(self, path: str) -> None:
        """Atomic: a crash mid-write leaves the previous file, not half of one."""
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path) or ".", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(asdict(self), f, indent=2)
            os.replace(tmp, path)
        except OSError:
            try:
                os.unlink(tmp)
            except OSError:
                pass

    def set_ramp(self, path: str, points: list) -> None:
        ramps = dict(self.ramps)
        ramps.pop(path, None)
        if points:
            ramps[path] = [[round(t, 3), round(s, 3)] for t, s in points]
        keys = list(ramps)
        for k in keys[: max(0, len(keys) - self.MAX_RAMPS)]:
            del ramps[k]
        self.ramps = ramps


@dataclass
class Live:
    # The open file
    path: str = ""
    filename: str = ""
    kind: str = ""                 # video | photo | audio, settled at load
    loaded_seq: int = 0
    duration: float = 0.0
    width: int = 0                 # decoded size, unrotated
    height: int = 0
    rotate: int = 0                # container rotation
    fps: float = 0.0
    video_codec: str = ""
    audio_codec: str = ""
    pixfmt: str = ""
    gamma: str = ""
    samplerate: int = 0
    channels: int = 0
    file_size: int = 0
    metadata: dict = field(default_factory=dict)
    # Playback
    time_pos: float = 0.0
    pause: bool = True
    speed: float = 1.0
    backward: bool = False
    frame: int = 0
    cache_time: float = 0.0
    mute: bool = True
    volume: float = 100.0
    loop: bool = True
    ab_a: float | None = None
    ab_b: float | None = None
    hwdec: str = ""
    # View
    zoom: float = 0.0
    pan_x: float = 0.0
    pan_y: float = 0.0
    user_rotate: int = 0
    out_rect: tuple = (0, 0, 0, 0)  # picture's rectangle inside the view, device px
    # App state
    crop: Crop | None = None       # applied: the filter is cutting the picture
    crop_box: Crop | None = None   # the box on the picture while editing
    crop_editing: bool = False
    crop_ratio: str = ""
    trail: str = "off"
    trim_in: float = 0.0
    trim_out: float | None = None
    ramp_on: bool = False
    spec_live: bool = False
    xray_cutoff: float = 0.0
    connected: bool = False


class Store:
    def __init__(self, settings: Settings | None = None):
        self.settings = settings or Settings()
        self.live = Live()
        self._listeners: list[Listener] = []

    def subscribe(self, fn: Listener) -> None:
        self._listeners.append(fn)

    def _notify(self, changed: set[str]) -> None:
        if changed:
            for fn in list(self._listeners):
                fn(changed)

    def update(self, **kw: Any) -> set[str]:
        """Change live fields; listeners hear only the ones that moved."""
        changed = set()
        for k, v in kw.items():
            if not hasattr(self.live, k):
                raise AttributeError(k)
            if getattr(self.live, k) != v:
                setattr(self.live, k, v)
                changed.add(k)
        self._notify(changed)
        return changed

    def configure(self, **kw: Any) -> set[str]:
        """Change settings; listeners hear them as 'settings.<name>'."""
        changed = set()
        for k, v in kw.items():
            if not hasattr(self.settings, k):
                raise AttributeError(k)
            if getattr(self.settings, k) != v:
                setattr(self.settings, k, v)
                changed.add("settings." + k)
        self._notify(changed)
        return changed

    def touch(self, name: str) -> None:
        """Announce a change made in place (a dict or list setting)."""
        self._notify({name})
