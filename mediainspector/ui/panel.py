"""The card panel beside the picture.

Every control sends a command to the controller and is lit from the store,
never from its own memory of what it last sent. Cards fold and remember it,
and flow into as many columns as the panel is wide.
"""

from __future__ import annotations


from PySide6.QtCore import QTimer, Qt
from PySide6.QtGui import QColor
from PySide6.QtWidgets import (QComboBox, QFileDialog, QGridLayout, QLabel, QLineEdit, QScrollArea, QVBoxLayout,
                               QWidget, QHBoxLayout)

from ..controller import RATIOS, UPSCALE_NAMES, Controller
from ..core import media, ramp
from ..core.xray import khz
from . import theme
from .ramp_editor import RampEditor
from .widgets import Card, Segmented, SliderRow, Toggle, btn, hint, label, row, section, set_on
from .xray_view import XrayOverview

SHORTCUTS = [
    ("Left / Right, PgUp / PgDn", "Previous / next file"),
    ("Shift+Left / Right", "Step one frame"),
    ("Space", "Play / pause"),
    ("[ / ]   Backspace", "Speed nudge / reset"),
    ("s", "Slow-mo conform to 24 fps"),
    ("b", "Browse videos only / all media"),
    ("e", "Export frame"),
    ("i", "Media info"),
    ("u", "Cycle GPU upscaler"),
    ("t", "Motion trail: bright / dark / X-ray / off"),
    ("c", "Adjust the crop on the picture"),
    ("Enter / Esc", "Apply / cancel the crop"),
    ("Alt+Arrows", "Nudge the crop"),
    ("z / x", "Zoom to fit / 1:1"),
    ("r / Shift+R", "Rotate right / left"),
    ("w", "Refit the window to the media"),
    ("9 / 0, m, a", "Volume, mute, audio track"),
    ("l", "Loop on / off"),
    ("f, F11", "Fullscreen"),
    ("Ctrl+O", "Open a file"),
    ("Ctrl+= / - / 0", "UI scale"),
    ("h, F1", "This list over the picture"),
    ("Wheel", "Shuttle (video) / zoom (photo)"),
    ("Ctrl+Wheel, drag", "Zoom / pan"),
]

LOOK_GROUPS = [
    ("White balance", [("temp", "Temperature", -100, 100), ("tint", "Tint", -100, 100)]),
    ("Light", [("brightness", "Brightness", -100, 100), ("contrast", "Contrast", -100, 100),
               ("highlights", "Highlights", -100, 100), ("shadows", "Shadows", -100, 100),
               ("gamma", "Gamma", -100, 100)]),
    ("Colour", [("vibrance", "Vibrance", -100, 100), ("saturation", "Saturation", -100, 100),
                ("hue", "Hue", -100, 100)]),
    ("Texture", [("sharpness", "Sharpness", -100, 100), ("vignette", "Vignette", 0, 100)]),
]

SCALERS = ["ewa_lanczossharp", "ewa_lanczos", "ewa_lanczos4sharpest", "lanczos", "spline36", "spline64",
           "mitchell", "catmull_rom", "bicubic", "bilinear", "nearest"]
DSCALERS = ["mitchell", "catmull_rom", "lanczos", "spline36", "box", "bilinear"]


class FlowColumns(QWidget):
    """Cards packed into as many columns as fit, each into the shortest column
    so far - the way CSS columns pack, without a hole under every short card."""
    COL_W = 290

    def __init__(self, parent=None):
        super().__init__(parent)
        self.cards: list[Card] = []
        self.grid = QHBoxLayout(self)
        self.grid.setContentsMargins(8, 8, 8, 8)
        self.grid.setSpacing(8)
        self.cols: list[QVBoxLayout] = []
        self._n = 0
        self._again = QTimer(self, interval=0, singleShot=True, timeout=self.reflow)

    def add(self, card: Card):
        self.cards.append(card)
        card.toggled.connect(lambda *_: self._again.start())

    def resizeEvent(self, e):
        super().resizeEvent(e)
        n = max(1, (self.width() - 8) // self.COL_W)
        if n != self._n:
            self._again.start()

    def reflow(self):
        n = max(1, (self.width() - 8) // self.COL_W)
        self._n = n
        for col in self.cols:
            while col.count():
                col.takeAt(0)
        while self.grid.count():
            item = self.grid.takeAt(0)
            if item.layout():
                item.layout().deleteLater()
        self.cols = []
        heights = [0] * n
        for _ in range(n):
            col = QVBoxLayout()
            col.setSpacing(8)
            col.setAlignment(Qt.AlignTop)
            self.cols.append(col)
            self.grid.addLayout(col, 1)
        for card in self.cards:
            i = heights.index(min(heights))
            self.cols[i].addWidget(card)
            heights[i] += card.sizeHint().height() + 8
        for col in self.cols:
            col.addStretch(1)


class Panel(QScrollArea):
    def __init__(self, c: Controller, win, parent=None):
        super().__init__(parent)
        self.c, self.win = c, win
        self.setObjectName("panel")
        self.setWidgetResizable(True)
        self.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        self.flow = FlowColumns()
        self.flow.setObjectName("panel")
        self.setWidget(self.flow)
        self._refreshers = []
        self._build()
        self.flow.reflow()
        c.store.subscribe(self._on_change)
        c.xray_changed.connect(lambda: self._on_change({"xray"}))
        c.jobs.busy_changed.connect(lambda *_: self._on_change({"jobs"}))
        self._on_change({"all"})

    # ------------------------------------------------------------ plumbing

    def card(self, title: str, key: str, open_: bool = False) -> Card:
        opened = self.c.st.open_cards.get(key, open_)
        cd = Card(title, key, opened)
        cd.toggled.connect(self._remember_fold)
        self.flow.add(cd)
        return cd

    def _remember_fold(self, key: str, on: bool):
        cards = dict(self.c.st.open_cards)
        cards[key] = on
        self.c.store.configure(open_cards=cards)

    def on(self, fn):
        self._refreshers.append(fn)

    def _on_change(self, changed: set[str]):
        # The playhead alone moves sixty times a second and nothing here shows it.
        if changed <= {"time_pos", "cache_time", "frame", "out_rect"}:
            return
        for fn in self._refreshers:
            fn()

    def set_accent(self, colour: str):
        self.ramp.accent = self.xray_view.accent = QColor(colour)
        self.ramp.update()
        self.xray_view.update()

    # ------------------------------------------------------------ cards

    def _build(self):
        c, lv, st = self.c, self.c.lv, self.c.st
        V, VP, VA = ["video"], ["video", "photo"], ["video", "audio"]

        # ---- playback
        cd = self.card("Playback", "playback", True)
        speed = Segmented([(f"{v:g}x", v) for v in (0.25, 0.5, 1, 2)], c.set_speed, kinds=VA)
        slowmo = btn("Slow-mo", c.slowmo_toggle, "Conform the source fps to 24 fps  (s)", V, grow=False)
        cd.add(row(speed, slowmo))
        cd.add(row(*[btn(t, (lambda d=d: c.seek_by(d)), kinds=VA) for t, d in
                     (("-10s", -10), ("-1s", -1), ("+1s", 1), ("+10s", 10))]))
        loop = btn("Loop file", c.toggle_loop, "(l)", VA)
        ab = btn("A-B loop", c.ab_loop, "Set A, then B, then clear", VA)
        cd.add(row(loop, ab))

        def r_play():
            s = lv.speed
            preset = next((v for v in (0.25, 0.5, 1, 2) if abs(s - v) < 0.005), None)
            speed.set(preset)
            set_on(slowmo, preset is None and not lv.ramp_on and lv.kind == "video")
            set_on(loop, lv.loop)
            set_on(ab, lv.ab_a is not None)
            flags = [f"{s:.2f}x"] if abs(s - 1) > 0.005 else []
            flags += ["reverse"] if lv.backward else []
            flags += ["loop"] if lv.loop else []
            cd.set_badge(" · ".join(flags))
        self.on(r_play)

        # ---- media
        cd = self.card("Media", "media", True)
        cd.add(row(btn("Open…", self.win.open_dialog, "Ctrl+O", key=True),
                   btn("Info", self.win.toggle_info, "(i)", grow=False),
                   btn("Exports", lambda: self.win.open_folder(c.export_dir()), "Open the exports folder", grow=False)))
        browse = Segmented([("Videos only", False), ("All media", True)], c.set_browse_all)
        cd.add(row(label("Browse", width=52), browse), hint("What Left and Right step through in this folder. (b)"))
        self.on(lambda: browse.set(st.browse_all))

        # ---- view
        cd = self.card("View", "view", True)
        cd.add(row(btn("Fit", c.zoom_fit, "(z)", VP), btn("1:1", c.zoom_actual, "Actual pixels  (x)", VP),
                   btn("−", lambda: c.zoom_by(-0.15), "Zoom out", VP, grow=False),
                   btn("+", lambda: c.zoom_by(0.15), "Zoom in", VP, grow=False)))
        cd.add(row(btn("⟲", lambda: c.rotate_by(-90), "Rotate left  (Shift+R)", VP, grow=False),
                   btn("⟳", lambda: c.rotate_by(90), "Rotate right  (r)", VP, grow=False),
                   btn("Reset zoom", lambda: c.set_zoom(0), kinds=VP), btn("Reset pan", c.reset_pan, kinds=VP)))
        cd.add(btn("Export frame", c.export_frame, "Write the decoded frame to the exports folder  (e)",
                   ["video", "photo", "audio"], key=True))
        zoom_line = hint("")
        cd.add(zoom_line)

        def r_view():
            z = 2 ** lv.zoom
            rot = lv.user_rotate % 360
            zoom_line.setText(f"Zoom {z:.2f}x" + (f"   ·   rotated {rot}°" if rot else ""))
            cd.set_badge(f"{z:.2f}x" if abs(z - 1) > 0.005 else "")
        self.on(r_view)

        # ---- crop
        cd = self.card("Crop", "crop")
        edit = btn("Adjust on the picture", c.crop_toggle, "(c)", VP, key=True)
        cd.add(edit)
        editing_row = row(btn("Apply", c.crop_apply, "Enter"), btn("Cancel", c.crop_cancel, "Esc"),
                          btn("Full", c.crop_full))
        cd.add(editing_row)
        cd.add(hint("Drag the box or its handles over the picture. Enter applies, Esc cancels."), section("Ratio"))
        grid = QWidget()
        gl = QGridLayout(grid)
        gl.setContentsMargins(0, 0, 0, 0)
        gl.setSpacing(4)
        ratio_btns = {}
        for i, (lab, _, _) in enumerate(RATIOS):
            b = btn(lab, (lambda l=lab: c.crop_ratio(l)), kinds=VP)
            ratio_btns[lab] = b
            gl.addWidget(b, i // 5, i % 5)
        cd.add(grid, section("Rectangle"))
        fields = {k: QLineEdit() for k in ("W", "H", "X", "Y")}
        fl = QWidget()
        fg = QGridLayout(fl)
        fg.setContentsMargins(0, 0, 0, 0)
        fg.setSpacing(4)
        for i, (k, f) in enumerate(fields.items()):
            fg.addWidget(label(k, width=14), i // 2, (i % 2) * 2)
            fg.addWidget(f, i // 2, (i % 2) * 2 + 1)
        cd.add(fl)

        def apply_fields():
            try:
                w, h, x, y = (int(float(fields[k].text() or 0)) for k in ("W", "H", "X", "Y"))
            except ValueError:
                return
            if w and h:
                c.crop_rect(w, h, x, y)
        for f in fields.values():
            f.editingFinished.connect(apply_fields)
        cd.add(row(btn("Apply", apply_fields, kinds=VP), btn("Centre", c.crop_centre, kinds=VP),
                   btn("Clear", c.crop_clear, kinds=VP)))

        def r_crop():
            set_on(edit, lv.crop_editing)
            editing_row.setVisible(lv.crop_editing)
            for lab, b in ratio_btns.items():
                set_on(b, lab == lv.crop_ratio and (lv.crop is not None or lv.crop_editing))
            box = lv.crop_box if lv.crop_editing else lv.crop
            if not any(f.hasFocus() for f in fields.values()):
                vals = (box.w, box.h, box.x, box.y) if box else ("", "", 0, 0)
                for f, v in zip(fields.values(), vals):
                    f.setText(str(v))
            cd.set_badge(f"{lv.crop.w}×{lv.crop.h}" if lv.crop else ("editing" if lv.crop_editing else ""))
        self.on(r_crop)

        # ---- audio
        cd = self.card("Audio", "audio")
        mute = btn("Mute", c.toggle_mute, "(m)", VA, grow=False)
        vol = label("", width=48)
        vol.setAlignment(Qt.AlignCenter)
        cd.add(row(mute, btn("−", lambda: c.volume_by(-5), "(9)", VA), vol, btn("+", lambda: c.volume_by(5), "(0)", VA)))
        cd.add(btn("Cycle track", c.cycle_audio, "(a)", VA))

        def r_audio():
            set_on(mute, lv.mute)
            vol.setText("muted" if lv.mute else f"{lv.volume:.0f}%")
            cd.set_badge("muted" if lv.mute else "")
        self.on(r_audio)

        # ---- audio x-ray
        cd = self.card("Audio X-ray", "xray")
        spec = Toggle("Live spectrogram", st.spectrogram, c.set_spectrogram)
        spec.setToolTip("Show audio files as a scrolling spectrogram instead of cover art")
        cd.add(row(spec, None, btn("Analyse", c.run_xray, "Decode the soundtrack and read its spectrum", VA,
                                   grow=False)))
        self.xray_view = XrayOverview(c)
        cd.add(self.xray_view)
        verdict = QWidget()
        verdict.setObjectName("verdict")
        verdict.setAttribute(Qt.WA_StyledBackground, True)
        vl = QVBoxLayout(verdict)
        vl.setContentsMargins(8, 5, 8, 6)
        vl.setSpacing(2)
        v_title = QLabel()
        v_title.setStyleSheet("font-weight: 600;")
        v_detail = hint("")
        v_detail.setStyleSheet(f"color: {theme.DIM};")
        vl.addWidget(v_title)
        vl.addWidget(v_detail)
        cd.add(verdict)
        v_stats = hint("")
        v_stats.setProperty("role", "hint")
        cd.add(v_stats)
        LEVEL = {"genuine": theme.GOOD, "suspect": theme.WARN, "lossy": theme.INFO, "unknown": theme.FAINT}

        def r_xray():
            spec.set_quiet(st.spectrogram)
            x = c.xray
            r = x.get("result")
            state = x.get("state")
            colour = LEVEL[r.verdict.level] if r else theme.FAINT
            verdict.setStyleSheet(f"#verdict {{ border-left: 3px solid {colour}; }}")
            v_title.setStyleSheet(f"font-weight: 600; color: {colour if r and r.verdict.level != 'lossy' else theme.TEXT};")
            if state == "running":
                v_title.setText("Analysing the spectrum…")
                v_detail.setText("")
            elif state == "error":
                v_title.setText("Analysis failed")
                v_detail.setText(x.get("error", ""))
            elif r:
                v_title.setText(r.verdict.title)
                v_detail.setText(r.verdict.detail)
            else:
                v_title.setText("No analysis yet")
                v_detail.setText("Audio files are analysed as they open. For a video's soundtrack, press Analyse.")
            v_stats.setText("  ·  ".join(filter(None, [
                f"{khz(r.sample_rate)} sample rate", f"content to {khz(r.extent_hz or r.sample_rate / 2)}",
                f"cutoff {khz(r.cutoff_hz)}" if r.cutoff_hz else "no cutoff",
                "first 30 min" if r.truncated else ""])) if r else "")
            cd.set_badge("analysing…" if state == "running" else
                         {"genuine": "lossless", "suspect": "suspect", "lossy": "lossy"}.get(
                             r.verdict.level, "") if r else "")
        self.on(r_xray)

        # ---- colour
        cd = self.card("Colour", "look")
        sliders: dict[str, SliderRow] = {}
        for group, items in LOOK_GROUPS:
            cd.add(section(group))
            for key, name, lo, hi in items:
                s = SliderRow(name, lo, hi, st.look.get(key, 0))
                s.changed.connect(lambda v, k=key: c.set_look(k, v))
                sliders[key] = s
                cd.add(s)

        def reset_look():
            c.reset_look()
            for s in sliders.values():
                s.set_value(0)
        cd.add(btn("Reset all", reset_look),
               hint("Applies to playback, exported frames and every clip export. Double-click a slider to zero it."))
        self.on(lambda: cd.set_badge(f"{sum(1 for v in st.look.values() if v)} active" if any(st.look.values()) else ""))

        # ---- upscale
        cd = self.card("Upscale & enhance", "upscale")
        mode = Segmented([(name, key) for key, name in UPSCALE_NAMES.items()], c.set_upscale)
        cd.add(mode)
        factor = QComboBox()
        factor.addItems(["1.5", "2", "3", "4"])
        factor.setCurrentText(f"{st.upscale_factor:g}")
        factor.currentTextChanged.connect(lambda t: c.set_upscale_factor(float(t)))
        cd.add(row(label("Factor", width=52), factor, None))
        cd.add(hint("CNN 2x reconstructs soft, compressed, low-res sources; FSR is a cheaper spatial upsample. "
                    "Both run on the GPU and work on photos. The window grows by the factor."))
        cd.add(section("Enhance shaders"))
        shader_box = QWidget()
        sbl = QVBoxLayout(shader_box)
        sbl.setContentsMargins(0, 0, 0, 0)
        sbl.setSpacing(1)
        cd.add(shader_box)
        cd.add(section("Inspect overlay"))
        inspect = QComboBox()
        cd.add(inspect)

        def fill_shaders():
            while sbl.count():
                w = sbl.takeAt(0).widget()
                if w:
                    w.deleteLater()
            for sh in c.shaders:
                if sh.kind == "enhance":
                    t = Toggle(sh.label, sh.name in st.shaders, lambda on, n=sh.name: c.toggle_shader(n, on))
                    t.setProperty("list", "true")
                    sbl.addWidget(t)
            inspect.blockSignals(True)
            inspect.clear()
            inspect.addItem("Off", "off")
            for sh in c.shaders:
                if sh.kind == "inspect":
                    inspect.addItem(sh.label, sh.name)
            i = inspect.findData(st.inspect)
            inspect.setCurrentIndex(max(0, i))
            inspect.blockSignals(False)
        fill_shaders()
        inspect.currentIndexChanged.connect(lambda i: c.set_inspect(inspect.itemData(i)))

        def rescan():
            c.rescan_shaders()
            fill_shaders()
            self.win.toast("Rescanned the shader folders")
        cd.add(row(btn("Rescan", rescan), btn("Shader folder", self.win.open_shader_folder)))
        cd.add(section("Renderer"))
        up = QComboBox()
        up.addItems(SCALERS)
        up.setCurrentText(st.scaler)
        up.currentTextChanged.connect(lambda v: c.set_scaler(up=v))
        down = QComboBox()
        down.addItems(DSCALERS)
        down.setCurrentText(st.dscaler)
        down.currentTextChanged.connect(lambda v: c.set_scaler(down=v))
        cd.add(row(label("Scaler", width=64), up), row(label("Downscale", width=64), down))
        decode = hint("")
        cd.add(decode)

        def r_up():
            mode.set(st.upscale)
            hw = lv.hwdec
            decode.setText("Decoding on the GPU: " + hw if hw and hw != "no" else
                           ("Decoding on the CPU (no GPU decoder for this format)" if lv.path else ""))
            on = [UPSCALE_NAMES[st.upscale].split(" ")[0]] if st.upscale != "off" else []
            on += [f"{len(st.shaders)} shader{'s' if len(st.shaders) > 1 else ''}"] if st.shaders else []
            on += ["inspect"] if st.inspect != "off" else []
            cd.set_badge(" · ".join(on))
        self.on(r_up)

        # ---- trim
        cd = self.card("Trim & export clip", "trim")
        t_in, t_out = QLineEdit(), QLineEdit()
        t_out.setPlaceholderText("end")

        def commit_trim():
            def num(s):
                try:
                    return float(s)
                except ValueError:
                    return None
            a = num(t_in.text()) or 0.0
            b = num(t_out.text())
            c.set_trim(a, b)
        t_in.editingFinished.connect(commit_trim)
        t_out.editingFinished.connect(commit_trim)
        cd.add(row(label("In", width=28), t_in, btn("Set", lambda: c.set_trim(lv.time_pos), kinds=VA, grow=False)))
        cd.add(row(label("Out", width=28), t_out,
                   btn("Set", lambda: c.set_trim(None, lv.time_pos), kinds=VA, grow=False)))
        cd.add(btn("Export trimmed clip", c.export_trim, kinds=V, key=True),
               hint("Seconds. Blank Out = end of file. The crop, the colour and the export scale go with it. "
                    "Speed ramp and time-slice use this range too when Out is set."))

        def r_trim():
            if not t_in.hasFocus():
                t_in.setText(f"{lv.trim_in:.3f}")
            if not t_out.hasFocus():
                t_out.setText("" if lv.trim_out is None else f"{lv.trim_out:.3f}")
            cd.set_badge("range set" if lv.trim_out is not None else "")
        self.on(r_trim)

        # ---- speed ramp
        cd = self.card("Speed ramp", "ramp")
        self.ramp = RampEditor(c)
        cd.add(self.ramp)
        play = Toggle("Play the ramp", False, lambda on: c.set_ramp_on(on), kinds=V)
        cd.add(row(play, None, btn("Clear", lambda: c.set_ramp_points([]), kinds=V, grow=False)))
        snap = btn("Snap to action", c.ramp_snap, "Find the peak of motion and put the slow part there", V)
        cd.add(row(btn("Dip here", c.ramp_dip, "Ease into slow motion around the playhead", V), snap))
        cd.add(btn("Export ramp", c.ramp_export, kinds=V, key=True))
        readout = hint("")
        cd.add(readout)

        def r_ramp():
            play.set_quiet(lv.ramp_on)
            play.setEnabled(bool(c.ramp_points) and lv.kind == "video")
            snap.setEnabled(lv.kind == "video" and not c.jobs.running("profile"))
            rng = c.ramp_range()
            if c.ramp_points and rng:
                secs = ramp.timeline(c.ramp_points, *rng).out_seconds
                readout.setText(f"Exports {media.fmt_time(rng[0])}–{media.fmt_time(rng[1])}"
                                f"{' (Trim In/Out)' if c.trim_range() else ''} as {secs:.1f} s at "
                                f"{ramp.output_fps(lv.fps):g} fps, no audio.")
            else:
                readout.setText("Click the graph to add a point, drag to shape it, double-click one to remove it.")
            cd.set_badge("playing" if lv.ramp_on else (f"{len(c.ramp_points)} pts" if c.ramp_points else ""))
        self.on(r_ramp)

        # ---- motion trail
        cd = self.card("Motion trail", "motion")
        trail = Segmented([("Off", "off"), ("Bright", "bright"), ("Dark", "dark"), ("X-ray", "xray")], c.set_trail,
                          kinds=V, tips={"bright": "Light subjects leave a trail", "dark": "Dark subjects leave a trail",
                                         "xray": "Only what moves is lit"})
        cd.add(trail)
        length = SliderRow("Length", 0, 100, int(st.trail_length), kinds=V)
        length.changed.connect(c.set_trail_length)
        cd.add(length, hint("Live on the picture; (t) cycles it. X-ray shows the difference between frames, so "
                            "anything still goes black."), section("Time-slice still"))
        copies = SliderRow("Copies", 3, 16, st.ts_copies, kinds=V)
        copies.changed.connect(lambda v: c.store.configure(ts_copies=v))
        thr = SliderRow("Threshold", 8, 80, st.ts_threshold, kinds=V)
        thr.changed.connect(lambda v: c.store.configure(ts_threshold=v))
        fade = Toggle("Fade the early copies", st.ts_fade, lambda on: c.store.configure(ts_fade=on), kinds=V)
        render = btn("Render still", c.timeslice, "Write a chronophotograph to the exports folder", V, key=True)
        cd.add(copies, thr, fade, render,
               hint("The subject at evenly spaced moments over one clean background, from Trim's In/Out or the "
                    "3 s from the playhead. Needs a still camera."))

        def r_trail():
            trail.set(lv.trail)
            render.setEnabled(lv.kind == "video" and not c.jobs.running("timeslice"))
            cd.set_badge({"bright": "trail", "dark": "dark trail", "xray": "x-ray"}.get(lv.trail, ""))
        self.on(r_trail)

        # ---- window & export
        cd = self.card("Window & export", "window")
        cd.add(Toggle("Fit the window to each file", st.fit_window, lambda on: c.store.configure(fit_window=on)))
        cd.add(Toggle("Panel follows the media's shape", st.auto_panel, self.win.set_auto_panel))
        cd.add(row(btn("Fullscreen", self.win.toggle_fullscreen, "(f)"), btn("On top", self.win.toggle_on_top)))
        cd.add(row(label("UI scale", width=64), btn("−", lambda: self.win.ui_scale_by(-1), "Ctrl+−"),
                   btn("+", lambda: self.win.ui_scale_by(1), "Ctrl+="), btn("Reset", lambda: self.win.ui_scale_by(0),
                                                                           "Ctrl+0")))
        cd.add(section("Exports"))
        folder = QLineEdit(st.export_dir or c.export_dir())
        folder.editingFinished.connect(lambda: c.store.configure(export_dir=folder.text().strip()))

        def choose():
            d = QFileDialog.getExistingDirectory(self, "Exports folder", c.export_dir())
            if d:
                folder.setText(d)
                c.store.configure(export_dir=d)
        cd.add(row(folder, btn("…", choose, "Choose a folder", grow=False)))
        fmt = QComboBox()
        fmt.addItems(["jpg", "png", "webp"])
        fmt.setCurrentText(st.export_format)
        fmt.currentTextChanged.connect(lambda v: c.store.configure(export_format=v))
        scale = QComboBox()
        scale.addItems(["50", "100", "150", "200", "300", "400"])
        scale.setEditable(True)
        scale.setCurrentText(f"{st.export_scale:g}")

        def set_scale(t):
            try:
                c.store.configure(export_scale=max(1.0, float(t)))
            except ValueError:
                pass
        scale.currentTextChanged.connect(set_scale)
        resampler = QComboBox()
        resampler.addItems(["lanczos", "spline", "bicubic", "neighbor"])
        resampler.setCurrentText(st.export_scaler)
        resampler.currentTextChanged.connect(lambda v: c.store.configure(export_scaler=v))
        cd.add(row(label("Format", width=52), fmt, label("Scale %", width=52), scale))
        cd.add(row(label("Resampler", width=64), resampler),
               hint("Frames, clips, ramps and time-slices land here. Above 100% upscales through the resampler."))

        # ---- shortcuts
        cd = self.card("Keyboard shortcuts", "keys")
        grid = QWidget()
        g = QGridLayout(grid)
        g.setContentsMargins(0, 0, 0, 0)
        g.setHorizontalSpacing(10)
        g.setVerticalSpacing(3)
        for i, (k, v) in enumerate(SHORTCUTS):
            kl = label(k, "mono")
            kl.setStyleSheet(f"color: {theme.TEXT}; font-family: {theme.MONO}; font-size: 10.5px;")
            g.addWidget(kl, i, 0)
            g.addWidget(label(v), i, 1)
        cd.add(grid)
