"""The command bus: every action the UI can take is a method here.

The controller turns intent into engine commands and store changes, reacts to
what the engine reports (a file finished loading, the playhead moved), and
runs the background jobs. The UI calls in and listens to the store; it never
talks to the engine itself.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

from PySide6.QtCore import QObject, QTimer, Signal

from . import paths
from .core import filters, layout, media, ramp
from .core.filters import Crop
from .core.state import Store
from .engine import exports
from .engine.jobs import Jobs
from .engine.player import Engine

SHUTTLE_MAX = 3.0
RATIOS = [("1:1", 1, 1), ("4:3", 4, 3), ("3:4", 3, 4), ("16:9", 16, 9), ("9:16", 9, 16),
          ("3:2", 3, 2), ("2:3", 2, 3), ("5:4", 5, 4), ("4:5", 4, 5), ("21:9", 21, 9)]
UPSCALE_SHADERS = {"cnn": "Upscale-ArtCNN.glsl", "fsr": "Upscale-FSR.glsl"}
UPSCALE_NAMES = {"off": "Off", "cnn": "CNN 2x (ArtCNN)", "fsr": "FSR (spatial)"}


@dataclass
class Shader:
    name: str
    path: str
    kind: str      # upscale | inspect | enhance

    @property
    def label(self) -> str:
        n = os.path.splitext(self.name)[0]
        return n.split("-", 1)[1] if self.kind == "inspect" else n


class Controller(QObject):
    message = Signal(str)          # a toast
    fit_requested = Signal()       # the window should refit to the media
    xray_changed = Signal()
    profile_changed = Signal()

    def __init__(self, store: Store, engine: Engine, settings_path: str | None = None, parent=None):
        super().__init__(parent)
        self.store, self.engine = store, engine
        self.settings_path = settings_path
        self.jobs = Jobs(self)
        self.xray: dict = {"state": "idle", "path": None, "result": None, "error": ""}
        self.profile: dict | None = None
        self.ramp_points: list[tuple[float, float]] = []
        self._ramp_recent: list[float] = []
        self.dragging_shuttle = False
        self.shaders: list[Shader] = []
        self.rescan_shaders()

        self._save = QTimer(self, interval=400, singleShot=True, timeout=self.save_settings)
        self._graph = QTimer(self, interval=60, singleShot=True, timeout=self.apply_graph)
        engine.file_loaded.connect(self._on_loaded)
        store.subscribe(self._on_change)

    # ------------------------------------------------------------ helpers

    @property
    def lv(self):
        return self.store.live

    @property
    def st(self):
        return self.store.settings

    def say(self, text: str):
        self.message.emit(text)

    def save_settings(self):
        if self.settings_path:
            self.st.save(self.settings_path)

    def _on_change(self, changed: set[str]):
        if any(c.startswith("settings.") for c in changed):
            self._save.start()
        if "time_pos" in changed:
            self._ramp_tick()
        if "speed" in changed and self.lv.ramp_on and not self._ramp_mine(self.lv.speed):
            self.set_ramp_on(False, quiet=True)
            self.say("Speed ramp off - the speed was changed by hand")

    def export_dir(self) -> str:
        return self.st.export_dir or paths.default_export_dir()

    def source_size(self) -> tuple[int, int]:
        return self.lv.width, self.lv.height

    def rotation(self) -> int:
        return (self.lv.rotate + self.lv.user_rotate) % 360

    def display_size(self) -> tuple[int, int]:
        """The picture's shape on screen: the crop if one is applied, turned
        by the container's and the viewer's rotation."""
        c = self.lv.crop
        w, h = (c.w, c.h) if c else self.source_size()
        return media.display_shape(w, h, self.lv.rotate, self.lv.user_rotate)

    def view_size(self) -> tuple[int, int]:
        """What the window should make room for: shader upscalers reconstruct
        into a bigger plane, so the window grows by their factor."""
        w, h = self.display_size()
        if self.st.upscale in UPSCALE_SHADERS and self.lv.kind != "audio":
            f = self.st.upscale_factor
            return round(w * f), round(h * f)
        return w, h

    # ------------------------------------------------------------ files

    def open(self, path: str):
        if not path or not os.path.isfile(path):
            self.say("File not found")
            return
        self.jobs.cancel_group("file")
        self.engine.before_load()
        self.engine.load(os.path.abspath(path))

    def step(self, offset: int):
        if not self.lv.path:
            self.say("No file loaded")
            return
        s = media.step(self.lv.path, offset, self.st.browse_all)
        if not s:
            self.say("No other media in this folder" if self.st.browse_all
                     else "No video in this folder - press b to browse everything")
            return
        self.open(s.path)
        self.say(f"({s.index}/{s.count}) {os.path.basename(s.path)}")

    def set_browse_all(self, on: bool):
        self.store.configure(browse_all=bool(on))
        self.say("Browsing every media file in the folder" if on else "Browsing video files only")

    def _on_loaded(self):
        lv = self.lv
        self.jobs.cancel_group("file")
        e = self.engine
        # Every file starts from a clean view: a zoom left from the last image
        # would otherwise crop the next one without saying so.
        for prop, v in (("video-zoom", 0.0), ("video-pan-x", 0.0), ("video-pan-y", 0.0),
                        ("video-rotate", 0), ("speed", 1.0), ("play-direction", "forward")):
            e.set(prop, v)
        self.store.update(crop=None, crop_box=None, crop_editing=False, crop_ratio="", ramp_on=False,
                          xray_cutoff=0.0, trim_in=0.0, trim_out=None)
        self._ramp_recent = []
        self.profile = None
        self.profile_changed.emit()
        self.apply_graph()
        self.apply_shaders(quiet=True)
        self.ramp_points = ramp.normalise(self.st.ramps.get(lv.path, []))
        self.store.touch("ramp")
        self.xray = {"state": "idle", "path": None, "result": None, "error": ""}
        if lv.kind == "audio":
            if self.st.spectrogram:
                e.spectrogram(True)
            self.run_xray()
        self.xray_changed.emit()
        self.store.configure(last_file=lv.path)
        e.flush()
        if lv.kind == "photo":
            self.say(f"{lv.filename}  -  {lv.width}x{lv.height} {media.ext_of(lv.path).upper()}")
        elif lv.kind == "audio":
            self.say(f"{lv.filename}  -  {lv.audio_codec or 'audio'}")
        elif lv.fps:
            self.say(f"{lv.filename}  -  {lv.fps:.2f} fps")
        self.fit_requested.emit()

    # ------------------------------------------------------------ transport

    def toggle_pause(self):
        if self.lv.kind == "photo":
            return
        self.engine.toggle_pause()

    def seek(self, t: float):
        self.engine.seek(t)

    def seek_by(self, dt: float):
        self.engine.seek_by(dt)

    def frame_step(self, forward: bool = True):
        if self.lv.kind == "video":
            self.engine.frame_step(forward)

    def set_signed_speed(self, v: float):
        self.engine.set_signed_speed(v, SHUTTLE_MAX)

    def nudge_speed(self, d: float):
        self.set_signed_speed(self.engine.signed_speed() + d)

    def set_speed(self, v: float):
        self.engine.set("speed", float(v))

    def reset_speed(self):
        self.engine.set("speed", 1.0)
        self.engine.set("play-direction", "forward")

    def slowmo_toggle(self):
        if self.lv.kind != "video":
            self.say("Slow-mo applies to video only")
            return
        s = media.conform_speed(self.lv.fps)
        if s is None:
            self.say(f"Source is {self.lv.fps:.2f} fps - already at or below the 24 fps target")
            return
        if abs(self.lv.speed - s) < 0.005:
            self.engine.set("speed", 1.0)
            self.say("Slow-mo off - normal speed")
        else:
            self.engine.set("speed", s)
            self.engine.set("pause", False)
            self.say(f"Slow-mo on - {self.lv.fps:.2f} fps shown at 24 fps ({1 / s:.1f}x slower)")

    def toggle_loop(self):
        on = not self.lv.loop
        self.engine.set("loop-file", "inf" if on else "no")
        self.store.configure(loop=on)

    def ab_loop(self):
        self.engine.command("ab-loop")

    def toggle_mute(self):
        m = not self.lv.mute
        self.engine.set("mute", m)
        self.store.configure(mute=m)

    def volume_by(self, d: float):
        v = max(0.0, min(130.0, self.lv.volume + d))
        self.engine.set("volume", v)
        self.store.configure(volume=v)
        if self.lv.mute and d > 0:
            self.toggle_mute()

    def cycle_audio(self):
        self.engine.command("cycle", "audio")

    # ------------------------------------------------------------ view

    def zoom_fit(self):
        for p in ("video-zoom", "video-pan-x", "video-pan-y"):
            self.engine.set(p, 0.0)

    def zoom_actual(self):
        # Read now, not from the store: right after a file change the stored
        # rectangle can still be the last file's.
        d = self.engine.get("osd-dimensions") or {}
        shown = (d.get("w") or 0) - (d.get("ml") or 0) - (d.get("mr") or 0)
        zoom = self.engine.get("video-zoom", self.lv.zoom)
        z = layout.actual_size_zoom(self.display_size()[0], shown, zoom)
        if z is None:
            return
        self.engine.set("video-zoom", layout.clamp_zoom(z))
        self.say("1:1 actual pixels")

    def set_zoom(self, z: float):
        self.engine.set("video-zoom", layout.clamp_zoom(z))

    def zoom_by(self, d: float):
        self.set_zoom(self.lv.zoom + d)

    def pan_by(self, dx: float, dy: float):
        self.engine.set("video-pan-x", self.lv.pan_x + dx)
        self.engine.set("video-pan-y", self.lv.pan_y + dy)

    def reset_pan(self):
        self.engine.set("video-pan-x", 0.0)
        self.engine.set("video-pan-y", 0.0)

    def rotate_by(self, deg: int):
        if self.lv.kind == "audio":
            return
        if self.lv.crop_editing:
            self.crop_cancel()
        self.engine.set("video-rotate", (self.lv.user_rotate + deg) % 360)
        self.fit_requested.emit()

    # ------------------------------------------------------------ crop

    def _full_crop(self) -> Crop:
        w, h = self.source_size()
        return Crop(layout.even(w), layout.even(h), 0, 0)

    def crop_start(self):
        if self.lv.kind not in ("video", "photo") or not self.lv.width:
            self.say("Nothing to crop")
            return
        self.store.update(crop_box=self.lv.crop or self._full_crop(), crop_editing=True)
        self.apply_graph()

    def crop_toggle(self):
        if self.lv.crop_editing:
            self.crop_apply()
        else:
            self.crop_start()

    def crop_set_box(self, box: Crop):
        w, h, x, y = layout.clamp_crop(box.x, box.y, box.w, box.h, *self.source_size())
        self.store.update(crop_box=Crop(w, h, x, y))

    def crop_apply(self):
        box = self.lv.crop_box
        if box is None:
            return
        full = self._full_crop()
        applied = None if (box.w, box.h) == (full.w, full.h) else box
        self.store.update(crop=applied, crop_box=None, crop_editing=False,
                          crop_ratio=self.lv.crop_ratio if applied else "")
        self.apply_graph()
        self.fit_requested.emit()
        self.say(f"Crop {applied.w}x{applied.h}" if applied else "Crop cleared")

    def crop_cancel(self):
        if not self.lv.crop_editing:
            return
        self.store.update(crop_box=None, crop_editing=False)
        self.apply_graph()

    def crop_full(self):
        self.store.update(crop_box=self._full_crop(), crop_ratio="")

    def crop_ratio(self, label: str):
        r = next((x for x in RATIOS if x[0] == label), None)
        sw, sh = self.source_size()
        if not r or sw < 2:
            return
        turned = self.rotation() in (90, 270)
        rw, rh = (r[2], r[1]) if turned else (r[1], r[2])
        w, h = layout.ratio_rect(sw, sh, rw, rh)
        box = Crop(w, h, layout.even((sw - w) / 2), layout.even((sh - h) / 2))
        self.store.update(crop_ratio=label)
        if self.lv.crop_editing:
            self.store.update(crop_box=box)
        else:
            self.store.update(crop=box)
            self.apply_graph()
            self.fit_requested.emit()

    def crop_rect(self, w: int, h: int, x: int, y: int):
        cw, ch, cx, cy = layout.clamp_crop(x, y, w, h, *self.source_size())
        box = Crop(cw, ch, cx, cy)
        if self.lv.crop_editing:
            self.store.update(crop_box=box)
        else:
            self.store.update(crop=box)
            self.apply_graph()
            self.fit_requested.emit()

    def crop_centre(self):
        c = self.lv.crop_box if self.lv.crop_editing else self.lv.crop
        if c:
            sw, sh = self.source_size()
            self.crop_rect(c.w, c.h, (sw - c.w) // 2, (sh - c.h) // 2)

    def crop_slide(self, dx: float, dy: float):
        """Move the crop by source pixels: dragging the picture slides the
        whole frame under an applied crop, and Alt+arrows nudge it."""
        c = self.lv.crop_box if self.lv.crop_editing else self.lv.crop
        if not c:
            return
        self.crop_rect(c.w, c.h, c.x + dx, c.y + dy)

    def crop_clear(self):
        self.store.update(crop=None, crop_box=None, crop_editing=False, crop_ratio="")
        self.apply_graph()
        self.fit_requested.emit()

    # ------------------------------------------------------------ look + trail

    def graph(self) -> filters.Graph:
        lv = self.lv
        return filters.Graph(
            crop=None if lv.crop_editing else lv.crop,
            look=dict(self.st.look),
            trail=lv.trail if lv.kind == "video" else "off",
            trail_length=self.st.trail_length,
        )

    def apply_graph(self):
        self._graph.stop()
        if not self.engine.set_vf(filters.mpv_vf(self.graph().stages())):
            self.say("The player rejected the filter graph - " + self.engine.last_error)

    def set_look(self, key: str, value: float):
        look = dict(self.st.look)
        if value:
            look[key] = value
        else:
            look.pop(key, None)
        self.store.configure(look=look)
        self._graph.start()

    def reset_look(self):
        self.store.configure(look={})
        self.apply_graph()

    TRAIL_SAY = {"off": "Motion trail off", "bright": "Motion trail on - light subjects leave a trail",
                 "dark": "Motion trail on - dark subjects leave a trail",
                 "xray": "Motion X-ray on - only what moves is lit"}

    def set_trail(self, mode: str):
        if mode != "off" and self.lv.kind != "video":
            self.say("Motion trail applies to video only")
            return
        self.store.update(trail=mode)
        self.apply_graph()
        self.say(self.TRAIL_SAY.get(mode, mode))

    def cycle_trail(self):
        order = filters.TRAIL_MODES
        self.set_trail(order[(order.index(self.lv.trail) + 1) % len(order)])

    def set_trail_length(self, v: float):
        self.store.configure(trail_length=float(v))
        if self.lv.trail != "off":
            self._graph.start()

    # ------------------------------------------------------------ shaders

    def rescan_shaders(self):
        found: dict[str, Shader] = {}
        for folder in (paths.assets("shaders"), paths.user_shader_dir()):
            try:
                names = sorted(os.listdir(folder))
            except OSError:
                continue
            for n in names:
                if not n.lower().endswith(".glsl"):
                    continue
                kind = "upscale" if n.startswith("Upscale-") else "inspect" if n.startswith("Inspect-") else "enhance"
                found[n] = Shader(n, os.path.join(folder, n), kind)
        self.shaders = list(found.values())

    def shader_path(self, name: str) -> str | None:
        return next((s.path for s in self.shaders if s.name == name), None)

    def apply_shaders(self, quiet: bool = False):
        st = self.st
        chain = []
        if st.upscale in UPSCALE_SHADERS and self.lv.kind != "audio":
            p = self.shader_path(UPSCALE_SHADERS[st.upscale])
            if p:
                chain.append(p)
        chain += [p for p in (self.shader_path(n) for n in st.shaders) if p]
        if st.inspect != "off":
            p = self.shader_path(st.inspect)
            if p:
                chain.append(p)
        if not self.engine.set_shaders(chain) and not quiet:
            self.say("A shader failed to load - " + self.engine.last_error)

    def set_upscale(self, mode: str):
        if mode not in UPSCALE_NAMES:
            return
        self.store.configure(upscale=mode)
        self.apply_shaders()
        self.fit_requested.emit()
        if mode == "off":
            self.say("GPU upscaling off")
        elif self.lv.kind == "audio":
            self.say("No picture to upscale")
        else:
            self.say(f"{UPSCALE_NAMES[mode]} on - {self.st.upscale_factor:g}x window")

    def cycle_upscale(self):
        order = list(UPSCALE_NAMES)
        self.set_upscale(order[(order.index(self.st.upscale) + 1) % len(order)])

    def set_upscale_factor(self, f: float):
        self.store.configure(upscale_factor=float(f))
        self.fit_requested.emit()

    def toggle_shader(self, name: str, on: bool):
        names = [n for n in self.st.shaders if n != name] + ([name] if on else [])
        self.store.configure(shaders=names)
        self.apply_shaders()

    def set_inspect(self, name: str):
        self.store.configure(inspect=name or "off")
        self.apply_shaders()

    def set_scaler(self, up: str | None = None, down: str | None = None):
        if up:
            self.store.configure(scaler=up)
            self.engine.set("scale", up)
            self.engine.set("cscale", up)
        if down:
            self.store.configure(dscaler=down)
            self.engine.set("dscale", down)

    # ------------------------------------------------------------ X-ray

    def set_spectrogram(self, on: bool):
        self.store.configure(spectrogram=bool(on))
        if self.lv.kind == "audio":
            self.engine.spectrogram(bool(on))
            self.say("Live spectrogram on" if on else "Live spectrogram off")

    def run_xray(self):
        path = self.lv.path
        if not path:
            return
        if self.lv.kind == "photo":
            self.say("A photo has no sound to analyse")
            return
        self.xray = {"state": "running", "path": path, "result": None, "error": ""}
        self.xray_changed.emit()

        def done(r):
            if r["path"] != self.lv.path:
                return
            res = r["result"]
            self.xray = {"state": "done", "path": r["path"], "result": res, "error": ""}
            self.store.update(xray_cutoff=float(res.cutoff_hz))
            self.xray_changed.emit()

        def failed(msg):
            self.xray = {"state": "error", "path": path, "result": None, "error": msg}
            self.xray_changed.emit()

        self.jobs.run("xray", exports.xray_job, path, group="file", on_done=done, on_fail=failed)

    # ------------------------------------------------------------ ramp

    def set_ramp_points(self, points, persist: bool = True):
        self.ramp_points = ramp.normalise(points)
        if persist and self.lv.path:
            self.st.set_ramp(self.lv.path, self.ramp_points)
            self.store.touch("settings.ramps")
        self.store.touch("ramp")
        if not self.ramp_points and self.lv.ramp_on:
            self.set_ramp_on(False)
        elif self.lv.ramp_on:
            self._ramp_tick()

    def set_ramp_on(self, on: bool, quiet: bool = False):
        on = bool(on) and bool(self.ramp_points) and self.lv.kind == "video"
        if on == self.lv.ramp_on:
            self.store.touch("ramp_on")
            return
        self._ramp_recent = []
        self.store.update(ramp_on=on)
        if on:
            self._ramp_tick()
            if not quiet:
                self.say("Speed ramp on - playback follows the curve")
        elif not quiet:
            # Off from the panel: back to real time. Taken over by a hand on
            # the speed (quiet), the speed they chose stands.
            self.engine.set("speed", 1.0)
            self.say("Speed ramp off")

    def _ramp_mine(self, sp: float) -> bool:
        return any(abs(v - sp) < 0.01 for v in self._ramp_recent)

    def _ramp_tick(self):
        lv = self.lv
        if not lv.ramp_on or not self.ramp_points or lv.pause or lv.backward or self.dragging_shuttle:
            return
        sp = ramp.evaluate(self.ramp_points, lv.time_pos)
        if abs(sp - lv.speed) < 0.004:
            return
        self._ramp_recent = (self._ramp_recent + [sp])[-6:]
        self.engine.set("speed", sp)

    def ramp_dip(self, center: float | None = None):
        if self.lv.kind != "video" or not self.lv.duration:
            return
        c = self.lv.time_pos if center is None else center
        self.set_ramp_points(ramp.dip(c, self.lv.duration, self.lv.fps))

    def ramp_snap(self):
        """Find the moment with the most movement and put the dip there: the
        whole of a short clip, around the playhead in a long one, because
        every frame searched has to be decoded."""
        lv = self.lv
        if lv.kind != "video" or not lv.duration:
            return
        a, b = (0.0, lv.duration) if lv.duration <= 40 else (max(0.0, lv.time_pos - 15),
                                                              min(lv.duration, lv.time_pos + 15))
        self.say("Looking for the moment with the most movement…")
        path = lv.path

        def done(r):
            if path != self.lv.path or r["peak"] is None:
                return
            self.profile = r
            self.profile_changed.emit()
            self.ramp_dip(r["peak"])
            self.seek(max(0.0, r["peak"] - 1))
            self.say(f"Most movement at {media.fmt_time(r['peak'])} - dip placed there")

        self.jobs.run("profile", exports.motion_profile, path, a, b, self._crop_stages(), self.rotation(),
                      lv.fps, group="file", on_done=done,
                      on_fail=lambda m: self.say("Motion analysis failed: " + m))

    def trim_range(self) -> tuple[float, float] | None:
        """In and Out from the Trim card, when Out has been set."""
        a, b = self.lv.trim_in or 0.0, self.lv.trim_out
        if b is None or b <= a:
            return None
        return a, min(b, self.lv.duration) if self.lv.duration else b

    def ramp_range(self) -> tuple[float, float] | None:
        return self.trim_range() or ramp.default_range(self.ramp_points, self.lv.duration)

    def ramp_export(self):
        rng = self.ramp_range()
        if not rng or not self.ramp_points:
            self.say("Draw a speed curve first")
            return
        spec = self._clip_spec("ramp", *rng)
        tl_seconds = ramp.timeline(self.ramp_points, *rng).out_seconds
        fps = ramp.output_fps(self.lv.fps)
        self.say(f"Encoding ramp ({tl_seconds:.1f} s at {fps:g} fps)…")
        self.jobs.run("ramp-export", exports.ramp_export, spec, list(self.ramp_points), self.lv.fps,
                      on_done=lambda r: self.say(f"Ramp saved: {os.path.basename(r[0])}"),
                      on_fail=lambda m: self.say("Ramp export failed: " + m))

    # ------------------------------------------------------------ exports

    def _crop_stages(self):
        return [self.lv.crop.stage()] if self.lv.crop else []

    def _clip_spec(self, tag: str, a: float, b: float) -> exports.ClipSpec:
        base = os.path.splitext(os.path.basename(self.lv.path))[0]
        out = exports.unique_path(self.export_dir(), f"{base}_{tag}_{exports.stamp()}", "mp4")
        return exports.ClipSpec(self.lv.path, out, a, b, self.graph().stages(live=False),
                                rotate=self.rotation(), scale=self.st.export_scale, scaler=self.st.export_scaler)

    def export_frame(self):
        lv = self.lv
        if not lv.path:
            self.say("No file loaded")
            return
        if lv.kind == "audio" and not lv.spec_live:
            self.say("Nothing to export from an audio-only file")
            return
        img = self.engine.screenshot()
        if img is None:
            self.say("Could not grab the frame - " + self.engine.last_error)
            return
        # The grab is already turned the way the picture is shown. A quarter
        # turn can come back a few pixels wider than the frame (the decoder's
        # row padding); trim it to the size actually on screen.
        if lv.kind == "video" or lv.kind == "photo":
            w, h = self.display_size()
            if w and h and (img.width > w or img.height > h):
                img = img.crop((0, 0, min(w, img.width), min(h, img.height)))
        fmt = self.st.export_format
        out = exports.unique_path(self.export_dir(), exports.frame_name(lv.path, lv.kind, lv.frame, lv.time_pos), fmt)

        def save(cancelled, progress):
            return out, exports.save_frame(img, out, fmt, self.st.export_scale, self.st.export_scaler)

        self.jobs.run(f"frame-{out}", save,
                      on_done=lambda r: self.say(f"Exported {os.path.basename(r[0])}  ({fmt.upper()}, {r[1][0]}x{r[1][1]})"),
                      on_fail=lambda m: self.say("Export failed: " + m))

    def set_trim(self, a: float | None = None, b: float | None = -1):
        kw = {}
        if a is not None:
            kw["trim_in"] = max(0.0, float(a))
        if b != -1:
            kw["trim_out"] = None if b is None else max(0.0, float(b))
        self.store.update(**kw)
        self.store.touch("ramp")

    def export_trim(self):
        lv = self.lv
        if lv.kind != "video":
            self.say("Trim exports video clips")
            return
        a = lv.trim_in or 0.0
        b = lv.trim_out if lv.trim_out is not None else lv.duration
        if not b or b <= a:
            self.say("Out has to be after In")
            return
        spec = self._clip_spec("trim", a, b)
        self.say(f"Encoding clip -> {os.path.basename(spec.out)}")
        self.jobs.run(f"trim-{spec.out}", exports.trim, spec,
                      on_done=lambda r: self.say(f"Clip saved: {os.path.basename(r)}"),
                      on_fail=lambda m: self.say("Trim failed: " + m))

    def timeslice(self):
        lv = self.lv
        if lv.kind != "video":
            self.say("Time-slice works on video")
            return
        rng = self.trim_range() or (lv.time_pos, min(lv.duration, lv.time_pos + 3))
        if rng[1] <= rng[0]:
            self.say("Nothing to render: move back from the end")
            return
        st = self.st
        self.say("Rendering time-slice still…")
        self.jobs.run("timeslice", exports.timeslice, lv.path, self.export_dir(), rng[0], rng[1],
                      self._crop_stages(), self.rotation(), lv.fps, st.ts_copies, st.ts_threshold, st.ts_fade,
                      on_done=lambda r: self.say(f"Time-slice saved: {os.path.basename(r['path'])}  "
                                                 f"({r['copies']} copies, {r['w']}x{r['h']})"),
                      on_fail=lambda m: self.say("Time-slice failed: " + m))

    # ------------------------------------------------------------ info

    def info_lines(self) -> list[str]:
        lv = self.lv
        if not lv.path:
            return ["No file loaded"]
        out = [lv.filename, f"{lv.kind.upper()}  |  {media.ext_of(lv.path).upper()}  |  {media.human_bytes(lv.file_size)}"]
        if lv.width:
            out.append(f"{lv.width}x{lv.height}  ({lv.width * lv.height / 1e6:.1f} MP)  {lv.pixfmt}  {lv.gamma}")
        if lv.video_codec:
            out.append(f"Video: {lv.video_codec}" + (f"  |  {lv.fps:.3f} fps" if lv.kind == "video" else ""))
        if lv.audio_codec:
            out.append(f"Audio: {lv.audio_codec}  |  {lv.samplerate} Hz  |  {lv.channels} ch")
        md = {str(k).lower(): v for k, v in (lv.metadata or {}).items()}
        if md.get("title") or md.get("artist"):
            out.append(f"{md.get('title', '')}{'  -  ' + md['artist'] if md.get('artist') else ''}")
        if md.get("creation_time") or md.get("date"):
            out.append("Created: " + str(md.get("creation_time") or md.get("date")))
        hw = lv.hwdec
        out.append("Decode: " + (f"GPU ({hw})" if hw and hw != "no" else "CPU (no GPU decoder for this format)"))
        return out
