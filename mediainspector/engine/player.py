"""The media engine: libmpv, driven as a library.

The engine pushes every change it observes into the Store, coalesced on the
UI thread; nothing polls it. Commands are plain methods. Rendering is not done
here - ui/video_view.py attaches an OpenGL render context to `self.mpv` - so
the engine also runs headless (vo=null) for tests.
"""

from __future__ import annotations

import locale
import os
import threading

import mpv
from PySide6.QtCore import QObject, QTimer, Signal, Slot

from ..core import media
from ..core.state import Store

# GPU decode, copy-back: frames are decoded on the GPU and copied to RAM. The
# old build asked direct D3D11 decoding for a 256-surface pool, D3D11 refused,
# and decoding fell silently to the CPU. Copy-back has no such ceiling, works
# with any renderer, and is what CPU filters (colour, crop, trail) need anyway.
# Order: D3D11's decoder, NVIDIA's NVDEC, any other copy-back path; the CPU
# only for formats no GPU decodes (ProRes, 4:4:4 H.264).
HWDEC = "d3d11va-copy,nvdec-copy,auto-copy"

OBSERVED = {
    "time-pos": "time_pos", "duration": "duration", "pause": "pause", "speed": "speed",
    "play-direction": "backward", "mute": "mute", "volume": "volume", "path": "path",
    "filename": "filename", "width": "width", "height": "height", "video-params": None,
    "container-fps": "fps", "estimated-frame-number": "frame", "hwdec-current": "hwdec",
    "video-codec": "video_codec", "audio-codec-name": "audio_codec", "audio-params": None,
    "file-size": "file_size", "metadata": "metadata", "demuxer-cache-time": "cache_time",
    "video-zoom": "zoom", "video-pan-x": "pan_x", "video-pan-y": "pan_y",
    "video-rotate": "user_rotate", "loop-file": "loop", "ab-loop-a": "ab_a", "ab-loop-b": "ab_b",
    "osd-dimensions": None,
}

DEFAULTS = {"time_pos": 0.0, "duration": 0.0, "pause": True, "speed": 1.0, "mute": False, "volume": 100.0,
            "path": "", "filename": "", "width": 0, "height": 0, "fps": 0.0, "frame": 0, "hwdec": "",
            "video_codec": "", "audio_codec": "", "file_size": 0, "metadata": {}, "cache_time": 0.0,
            "zoom": 0.0, "pan_x": 0.0, "pan_y": 0.0, "user_rotate": 0, "ab_a": None, "ab_b": None}


def _convert(name: str, value):
    if name == "play-direction":
        return value == "backward"
    if name == "loop-file":
        return value not in (False, "no", None, 0)
    if name in ("ab-loop-a", "ab-loop-b"):
        return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None
    return value


class Engine(QObject):
    """Owns one mpv instance. Signals arrive on the UI thread."""

    file_loaded = Signal()
    end_file = Signal()
    _pushed = Signal()
    _event = Signal(str)

    def __init__(self, store: Store, headless: bool = False, parent=None):
        super().__init__(parent)
        # libmpv refuses to start under a locale that writes 0,5 for 0.5.
        locale.setlocale(locale.LC_NUMERIC, "C")
        self.store = store
        self.headless = headless
        s = store.settings
        opts = dict(
            vo="null" if headless else "libmpv",
            hwdec=HWDEC, hwdec_codecs="all", hwdec_extra_frames=32,
            keep_open="yes", idle="yes", image_display_duration="inf",
            hr_seek="yes", hr_seek_framedrop="no",
            cache="yes", demuxer_max_bytes="3072MiB", demuxer_max_back_bytes="1536MiB",
            demuxer_readahead_secs=60,
            # Reverse playback decodes a run forward and hands it back; the
            # buffer holds decoded frames in RAM (copy-back), ~12 MB each at 4K.
            video_reversal_buffer="3072MiB", audio_reversal_buffer="128MiB",
            input_default_bindings=False, input_vo_keyboard=False, osc=False,
            load_scripts=False, ytdl=False, terminal=False,
            # No sound device (or it vanished): keep playing, silently, rather
            # than abandoning the file - which also lost its track list.
            audio_fallback_to_null="yes",
            mute="yes" if s.mute else "no", volume=s.volume,
            loop_file="inf" if s.loop else "no",
            scale=s.scaler, cscale=s.scaler, dscale=s.dscaler,
            correct_downscaling="yes", linear_downscaling="yes", sigmoid_upscaling="yes",
            deband="yes", dither_depth="auto",
        )
        if headless:
            opts["ao"] = "null"
        self.mpv = mpv.MPV(log_handler=self._log, loglevel="error", **opts)
        self.last_error = ""
        self._lock = threading.Lock()
        self._pending: dict = {}
        self._flush = QTimer(self, interval=30, singleShot=True, timeout=self._apply)
        self._pushed.connect(self._schedule)
        self._event.connect(self._on_event)
        # Exact seeks, one in flight: the newest target replaces any queued one.
        self._seeking = False
        self._seek_next: float | None = None
        # Tracks the spectrogram graph took, handed back by number when it
        # clears: an emptied lavfi-complex leaves no audio track selected.
        self._spec_tracks: tuple | None = None

        for prop in OBSERVED:
            self.mpv.observe_property(prop, self._observer)
        for ev in ("file-loaded", "playback-restart", "end-file"):
            self.mpv.event_callback(ev)(lambda e, name=ev: self._event.emit(name))

    # ------------------------------------------------------------ plumbing

    def _log(self, level, component, message):
        if level in ("error", "fatal"):
            self.last_error = f"{component}: {message.strip()}"

    def _observer(self, name, value):  # mpv's event thread
        with self._lock:
            if name == "video-params":
                v = value or {}
                self._pending.update(rotate=int(v.get("rotate") or 0), gamma=v.get("gamma") or "",
                                     pixfmt=v.get("pixelformat") or "")
            elif name == "audio-params":
                v = value or {}
                self._pending.update(samplerate=int(v.get("samplerate") or 0),
                                     channels=int(v.get("channel-count") or 0))
            elif name == "osd-dimensions":
                v = value or {}
                w, h = v.get("w") or 0, v.get("h") or 0
                self._pending["out_rect"] = (v.get("ml") or 0, v.get("mt") or 0,
                                             w - (v.get("mr") or 0), h - (v.get("mb") or 0))
            else:
                field = OBSERVED[name]
                value = _convert(name, value)
                if value is None and field in DEFAULTS:
                    value = DEFAULTS[field]
                self._pending[field] = value
        self._pushed.emit()

    @Slot()
    def _schedule(self):
        if not self._flush.isActive():
            self._flush.start()

    def _apply(self):
        with self._lock:
            pending, self._pending = self._pending, {}
        if pending:
            self.store.update(**pending)

    def flush(self):
        """Apply whatever the engine has pushed, now (tests, and before reads
        that must see the latest)."""
        self._apply()

    @Slot(str)
    def _on_event(self, name: str):
        if name == "playback-restart":
            self._seeking = False
            if self._seek_next is not None:
                t, self._seek_next = self._seek_next, None
                self.seek(t)
        elif name == "file-loaded":
            self._seeking, self._seek_next = False, None
            self.flush()
            self._settle_kind()
            self.file_loaded.emit()
        elif name == "end-file":
            self.end_file.emit()

    def _settle_kind(self):
        tracks = self.get("track-list") or []
        frames = self.get("estimated-frame-count") or 0
        kind = media.detect_kind(tracks, frames)
        if not tracks:
            # Nothing decoded to judge by: the extension is the best guess left.
            ext = media.ext_of(self.store.live.path or "")
            kind = "audio" if ext in media.AUDIO else "photo" if ext in media.PHOTO else "video"
        self.store.update(kind=kind, loaded_seq=self.store.live.loaded_seq + 1)

    def get(self, prop, default=None):
        try:
            v = self.mpv._get_property(prop)
            return default if v is None else v
        except (mpv.ShutdownError, AttributeError, RuntimeError):
            return default

    def set(self, prop, value) -> bool:
        try:
            self.mpv._set_property(prop, value)
            return True
        except (mpv.ShutdownError, AttributeError, RuntimeError, TypeError) as e:
            self.last_error = f"{prop}: {e}"
            return False

    def command(self, *args) -> bool:
        try:
            self.mpv.command(*args)
            return True
        except (mpv.ShutdownError, SystemError, RuntimeError) as e:
            self.last_error = f"{args[0]}: {e}"
            return False

    def shutdown(self):
        try:
            self.mpv.terminate()
        except Exception:  # noqa: BLE001 - going away regardless
            pass

    # ------------------------------------------------------------ commands

    def load(self, path: str):
        self.command("loadfile", path, "replace")

    def toggle_pause(self):
        self.set("pause", not self.store.live.pause)

    def seek(self, t: float):
        """Exact, paced: lands on the frame asked for, never queues a run."""
        if self._seeking:
            self._seek_next = t
            return
        self._seeking = True
        if not self.command("seek", max(0.0, t), "absolute+exact"):
            self._seeking = False

    def seek_by(self, dt: float):
        self.command("seek", dt, "relative+exact")

    def frame_step(self, forward: bool = True):
        self.command("frame-step" if forward else "frame-back-step")

    def set_signed_speed(self, v: float, shuttle_max: float = 3.0):
        """One signed number for speed and direction: negative is reverse,
        near zero is a stop."""
        v = max(-shuttle_max, min(shuttle_max, v))
        if abs(v) < 0.05:
            self.set("pause", True)
            self.set("speed", 1.0)
            return
        want_back = v < 0
        if want_back != self.store.live.backward:
            self.set("play-direction", "backward" if want_back else "forward")
        self.set("speed", abs(v))
        self.set("pause", False)

    def signed_speed(self) -> float:
        lv = self.store.live
        if lv.pause:
            return 0.0
        return -lv.speed if lv.backward else lv.speed

    def set_vf(self, vf: str) -> bool:
        return self.set("vf", vf)

    def set_shaders(self, paths: list[str]) -> bool:
        return self.set("glsl-shaders", paths)

    def screenshot(self):
        """The decoded, filtered frame at native size, no overlay: a PIL image."""
        try:
            return self.mpv.screenshot_raw("video")
        except Exception as e:  # noqa: BLE001
            self.last_error = f"screenshot: {e}"
            return None

    # ------------------------------------------------------------ spectrogram

    SPECTRO = ("[aid{aid}]asplit[ao][s];[s]showspectrum=s=1280x720:mode=combined:slide=scroll"
               ":scale=log:fscale=lin:color=magma:overlap=0.75:fps=60:legend=0[vo]")

    def spectrogram(self, on: bool) -> bool:
        """Audio drawn as a scrolling spectrogram, inside the engine: one copy
        of the sound to the speakers, one through showspectrum as the picture."""
        if on and self._spec_tracks is None:
            tracks = self.get("track-list") or []
            aud = next((t for t in tracks if t.get("type") == "audio" and t.get("selected")), None)
            if not aud:
                return False
            vid = next((t for t in tracks if t.get("type") == "video" and t.get("selected")), None)
            self._spec_tracks = (aud["id"], vid["id"] if vid else None)
            ok = self.set("lavfi-complex", self.SPECTRO.format(aid=aud["id"]))
            self.store.update(spec_live=ok)
            return ok
        if not on and self._spec_tracks is not None:
            aid, vid = self._spec_tracks
            self._spec_tracks = None
            self.set("lavfi-complex", "")
            # "auto" does not reselect mid-file; the tracks go back by number.
            self.set("aid", str(aid))
            if vid is not None:
                self.set("vid", str(vid))
            self.store.update(spec_live=False)
        return True

    def before_load(self):
        """The graph and its track pins belong to one file."""
        if self._spec_tracks is not None:
            self._spec_tracks = None
            self.set("lavfi-complex", "")
        self.set("aid", "auto")
        self.set("vid", "auto")
        self.store.update(spec_live=False)


def shader_dir_files(folder: str) -> list[str]:
    try:
        return sorted(f for f in os.listdir(folder) if f.lower().endswith(".glsl"))
    except OSError:
        return []
