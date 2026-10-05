"""The strip under the picture: timeline (or zoom for a photo), transport
buttons, the running time, the shuttle and the live speed.

It sits under the picture rather than over it, so it never hides a pixel.
"""

from __future__ import annotations

import math

from PySide6.QtCore import QPointF, QRectF, Qt
from PySide6.QtGui import QColor, QPainter, QPen
from PySide6.QtWidgets import QHBoxLayout, QLabel, QVBoxLayout, QWidget

from ..controller import SHUTTLE_MAX
from ..core import layout, media
from . import theme
from .widgets import btn, gate


class _Track(QWidget):
    """Base for the painted sliders: a track, a fill and a white thumb."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setFixedHeight(22)
        self.setCursor(Qt.PointingHandCursor)
        self.accent = QColor("#ffd000")

    def x_range(self) -> tuple[float, float]:
        return 8.0, self.width() - 8.0

    def frac_at(self, x: float) -> float:
        a, b = self.x_range()
        return max(0.0, min(1.0, (x - a) / max(1.0, b - a)))

    def x_at(self, f: float) -> float:
        a, b = self.x_range()
        return a + (b - a) * max(0.0, min(1.0, f))

    def _track(self, p: QPainter, cy: float):
        a, b = self.x_range()
        p.setPen(Qt.NoPen)
        p.setBrush(QColor("#2a2a32"))
        p.drawRoundedRect(QRectF(a, cy - 2.5, b - a, 5), 2.5, 2.5)

    def _fill(self, p: QPainter, cy: float, x0: float, x1: float, colour: QColor):
        if x1 < x0:
            x0, x1 = x1, x0
        p.setBrush(colour)
        p.drawRoundedRect(QRectF(x0, cy - 2.5, x1 - x0, 5), 2.5, 2.5)

    def _thumb(self, p: QPainter, x: float, cy: float):
        p.setPen(QPen(self.accent, 2))
        p.setBrush(QColor("#ffffff"))
        p.drawEllipse(QPointF(x, cy), 6, 6)


class Timeline(_Track):
    """Position for video and audio; zoom (1/4x..16x of fit) for a photo.

    Scrubbing is position tracking: the playhead follows the pointer, seeks
    are exact and paced by the engine. Grabbing pauses; letting go resumes if
    it was playing."""

    def __init__(self, c, parent=None):
        super().__init__(parent)
        self.c = c
        self._drag = False
        self._resume = False

    def paintEvent(self, _):
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        cy = self.height() / 2
        lv = self.c.lv
        self._track(p, cy)
        p.setPen(Qt.NoPen)
        if lv.kind == "photo":
            span = layout.ZOOM_MAX - layout.ZOOM_MIN
            fit_x = self.x_at((0 - layout.ZOOM_MIN) / span)
            x = self.x_at((lv.zoom - layout.ZOOM_MIN) / span)
            p.setBrush(theme.qc(theme.DIM))
            p.drawRect(QRectF(fit_x - 1, cy - 6, 2, 12))
            self._fill(p, cy, fit_x, x, self.accent)
            self._thumb(p, x, cy)
            return
        dur = lv.duration or 0
        if dur > 0:
            a, b = self.x_range()
            if lv.trim_out is not None and lv.trim_out > lv.trim_in:
                p.setBrush(theme.qc("#ffffff", 0.08))
                p.drawRect(QRectF(self.x_at(lv.trim_in / dur), 1, self.x_at(lv.trim_out / dur) -
                                  self.x_at(lv.trim_in / dur), self.height() - 2))
            if lv.cache_time and lv.cache_time > lv.time_pos:
                self._fill(p, cy, a, self.x_at(lv.cache_time / dur), theme.qc(theme.DIM, 0.45))
            x = self.x_at(lv.time_pos / dur)
            self._fill(p, cy, a, x, self.accent)
            # Where the speed ramp's points sit, lit while it drives playback.
            col = self.accent if lv.ramp_on else theme.qc(theme.DIM)
            p.setBrush(col)
            for t, _ in self.c.ramp_points:
                rx = self.x_at(t / dur)
                p.drawRect(QRectF(rx - 1, cy - 10, 2, 5))
            self._thumb(p, x, cy)

    def mousePressEvent(self, e):
        if e.button() != Qt.LeftButton:
            return
        lv = self.c.lv
        self._drag = True
        if lv.kind == "photo":
            self._zoom_to(e.position().x())
            return
        self._resume = not lv.pause
        self.c.engine.set("pause", True)
        self._seek_to(e.position().x())

    def mouseMoveEvent(self, e):
        if not self._drag:
            return
        if self.c.lv.kind == "photo":
            self._zoom_to(e.position().x())
        else:
            self._seek_to(e.position().x())

    def mouseReleaseEvent(self, e):
        if self._drag and self._resume:
            self.c.engine.set("pause", False)
        self._drag = self._resume = False

    def _seek_to(self, x: float):
        dur = self.c.lv.duration
        if dur:
            self.c.seek(self.frac_at(x) * dur)

    def _zoom_to(self, x: float):
        self.c.set_zoom(layout.ZOOM_MIN + self.frac_at(x) * (layout.ZOOM_MAX - layout.ZOOM_MIN))


class Shuttle(_Track):
    """Speed and direction on one control: left of centre plays backward,
    right forward, distance is speed, the centre is a stop. A second tick
    marks the slow-mo conform speed - the clip's 'correct' rate to aim at."""

    def __init__(self, c, parent=None):
        super().__init__(parent)
        self.c = c
        self.setMinimumWidth(120)
        self.setToolTip("Shuttle: drag either way of centre; wheel nudges")

    def frac_of(self, v: float) -> float:
        return 0.5 + 0.5 * max(-1.0, min(1.0, v / SHUTTLE_MAX))

    def paintEvent(self, _):
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        cy = self.height() / 2
        self._track(p, cy)
        mid = self.x_at(0.5)
        p.setPen(Qt.NoPen)
        p.setBrush(theme.qc(theme.DIM))
        p.drawRect(QRectF(mid - 1, cy - 5, 2, 10))
        conform = media.conform_speed(self.c.lv.fps) if self.c.lv.kind == "video" else None
        if conform:
            p.setBrush(theme.qc(self.accent.name(), 0.6))
            cx = self.x_at(self.frac_of(conform))
            p.drawRect(QRectF(cx - 1.5, cy - 5, 3, 10))
        x = self.x_at(self.frac_of(self.c.engine.signed_speed()))
        self._fill(p, cy, mid, x, self.accent)
        self._thumb(p, x, cy)

    def _set(self, x: float):
        self.c.set_signed_speed((self.frac_at(x) - 0.5) * 2 * SHUTTLE_MAX)

    def mousePressEvent(self, e):
        if e.button() == Qt.LeftButton:
            self.c.dragging_shuttle = True
            self._set(e.position().x())

    def mouseMoveEvent(self, e):
        if self.c.dragging_shuttle:
            self._set(e.position().x())

    def mouseReleaseEvent(self, e):
        self.c.dragging_shuttle = False

    def wheelEvent(self, e):
        self.c.nudge_speed(0.1 if e.angleDelta().y() > 0 else -0.1)


class TransportBar(QWidget):
    def __init__(self, c, parent=None):
        super().__init__(parent)
        self.setObjectName("transport")
        self.setAttribute(Qt.WA_StyledBackground, True)
        self.c = c
        lay = QVBoxLayout(self)
        lay.setContentsMargins(8, 4, 8, 6)
        lay.setSpacing(2)
        self.timeline = Timeline(c)
        lay.addWidget(self.timeline)

        row = QHBoxLayout()
        row.setSpacing(4)
        mk = lambda text, slot, tip, kinds=None: btn(text, slot, tip, kinds, grow=False)  # noqa: E731
        self.prev = mk("⏮", lambda: c.step(-1), "Previous file  (Left)")
        self.back = mk("◀|", lambda: c.frame_step(False), "Step back one frame  (Shift+Left)", ["video"])
        self.play = mk("▶", c.toggle_pause, "Play / pause  (Space)", ["video", "audio"])
        self.play.setMinimumWidth(42)
        self.fwd = mk("|▶", lambda: c.frame_step(True), "Step forward one frame  (Shift+Right)", ["video"])
        self.next = mk("⏭", lambda: c.step(1), "Next file  (Right)")
        for b in (self.prev, self.back, self.play, self.fwd, self.next):
            row.addWidget(b)
        self.time = QLabel("0:00")
        self.time.setObjectName("timecode")
        self.dur = QLabel("/ 0:00")
        self.dur.setObjectName("duration")
        row.addSpacing(8)
        row.addWidget(self.time)
        row.addWidget(self.dur)
        row.addSpacing(8)
        self.shuttle = gate(Shuttle(c), ["video", "audio"])
        row.addWidget(self.shuttle, 1)
        self.photo_read = QLabel()
        self.photo_read.setAlignment(Qt.AlignCenter)
        row.addWidget(self.photo_read, 1)
        self.speed = QLabel("Paused")
        self.speed.setObjectName("speedRead")
        self.speed.setMinimumWidth(64)
        self.speed.setAlignment(Qt.AlignRight | Qt.AlignVCenter)
        row.addWidget(self.speed)
        lay.addLayout(row)
        c.store.subscribe(self._on_change)
        self._refresh(set())

    def set_accent(self, colour: str):
        for w in (self.timeline, self.shuttle):
            w.accent = QColor(colour)
            w.update()

    def _on_change(self, changed: set[str]):
        if changed & {"time_pos", "duration", "pause", "speed", "backward", "kind", "zoom", "cache_time",
                      "ramp_on", "ramp", "fps", "width", "height", "trim_in", "trim_out", "path"}:
            self._refresh(changed)

    def _refresh(self, changed):
        lv = self.c.lv
        photo = lv.kind == "photo"
        self.shuttle.setVisible(not photo)
        self.photo_read.setVisible(photo)
        self.time.setVisible(not photo)
        self.dur.setVisible(not photo)
        self.play.setText("❚❚" if not lv.pause else "▶")
        self.time.setText(media.fmt_time(lv.time_pos))
        self.dur.setText("/ " + media.fmt_time(lv.duration))
        if photo:
            self.photo_read.setText(f"{lv.width}x{lv.height}   {2 ** lv.zoom * 100:.0f}% of fit   "
                                    f"{media.ext_of(lv.path).upper()}")
            self.speed.setText(f"{2 ** lv.zoom:.2f}x")
        else:
            s = self.c.engine.signed_speed()
            self.speed.setText("Paused" if s == 0 else f"{s:.2f}x")
        self.timeline.update()
        self.shuttle.update()


def fmt_speed(v: float) -> str:
    return "Paused" if math.isclose(v, 0) else f"{v:.2f}x"
