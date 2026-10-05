"""The speed ramp's graph: time across, speed up on a log scale.

Click adds a point, drag moves it, double-click or right-click removes it;
1x is easy to land on. A dashed line marks the slowest speed that still shows
24 real frames a second, and the clip's motion profile (once Snap to action
has looked) is drawn faintly behind the curve as something to aim at.
"""

from __future__ import annotations

import math

from PySide6.QtCore import QPointF, QRectF, Qt
from PySide6.QtGui import QColor, QFont, QPainter, QPainterPath, QPen
from PySide6.QtWidgets import QWidget

from ..core import media, ramp
from . import theme

PAD_L, PAD_R, PAD_T, PAD_B = 34, 8, 8, 8
LMIN, LMAX = math.log(ramp.MIN_SPEED), math.log(ramp.MAX_SPEED)


class RampEditor(QWidget):
    def __init__(self, c, parent=None):
        super().__init__(parent)
        self.c = c
        self.setFixedHeight(150)
        self.setMouseTracking(True)
        self.setCursor(Qt.CrossCursor)
        self.accent = QColor("#ffd000")
        self.pts: list[list[float]] = []
        self.drag: list[float] | None = None
        self.hover: list[float] | None = None
        c.store.subscribe(self._on_change)
        c.profile_changed.connect(self.update)

    def _on_change(self, changed):
        if "ramp" in changed or "path" in changed:
            if self.drag is None:
                self.pts = [[t, s] for t, s in self.c.ramp_points]
            self.update()
        elif changed & {"time_pos", "ramp_on", "fps", "duration", "kind"}:
            self.update()

    # ------------------------------------------------------------ mapping

    def dur(self) -> float:
        return self.c.lv.duration or 0.0

    def x(self, t: float) -> float:
        return PAD_L + t / (self.dur() or 1) * (self.width() - PAD_L - PAD_R)

    def y(self, s: float) -> float:
        return PAD_T + (1 - (math.log(s) - LMIN) / (LMAX - LMIN)) * (self.height() - PAD_T - PAD_B)

    def t_at(self, x: float) -> float:
        return max(0.0, min(self.dur(), (x - PAD_L) / (self.width() - PAD_L - PAD_R) * self.dur()))

    def s_at(self, y: float) -> float:
        v = math.exp(LMIN + (1 - (y - PAD_T) / (self.height() - PAD_T - PAD_B)) * (LMAX - LMIN))
        return max(ramp.MIN_SPEED, min(ramp.MAX_SPEED, v))

    def point_at(self, pos: QPointF):
        best, bd = None, 8.0
        for p in self.pts:
            d = math.hypot(self.x(p[0]) - pos.x(), self.y(p[1]) - pos.y())
            if d < bd:
                best, bd = p, d
        return best

    # ------------------------------------------------------------ paint

    def paintEvent(self, _):
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        w, h = self.width(), self.height()
        p.setPen(QPen(theme.qc(theme.BORDER), 1))
        p.setBrush(theme.qc("#0b0b0e"))
        p.drawRoundedRect(QRectF(0.5, 0.5, w - 1, h - 1), 4, 4)
        p.setFont(QFont(self.font().family(), 8))
        lv = self.c.lv

        prof = self.c.profile
        if prof and prof.get("path") == lv.path and len(prof["e"]) > 1 and self.dur():
            m = max(prof["e"]) or 1
            path = QPainterPath(QPointF(self.x(prof["t"][0]), h - PAD_B))
            for t, e in zip(prof["t"], prof["e"]):
                path.lineTo(self.x(t), h - PAD_B - e / m * h * 0.4)
            path.lineTo(self.x(prof["t"][-1]), h - PAD_B)
            p.fillPath(path, QColor(255, 255, 255, 18))

        for s in (0.25, 0.5, 1, 2, 4):
            y = round(self.y(s)) + 0.5
            p.setPen(QPen(QColor(255, 255, 255, 56 if s == 1 else 20), 1))
            p.drawLine(QPointF(PAD_L, y), QPointF(w - PAD_R, y))
            p.setPen(theme.qc("#a0a0aa" if s == 1 else "#5a5a64"))
            p.drawText(QRectF(0, y - 7, PAD_L - 5, 14), Qt.AlignRight | Qt.AlignVCenter, f"{s:g}x")

        floor = ramp.smooth_floor(lv.fps) if lv.kind == "video" else None
        if floor and ramp.MIN_SPEED < floor < 1:
            y = round(self.y(floor)) + 0.5
            pen = QPen(self.accent, 1, Qt.DashLine)
            p.setPen(pen)
            p.setOpacity(0.6)
            p.drawLine(QPointF(PAD_L, y), QPointF(w - PAD_R, y))
            p.setOpacity(1)
            p.drawText(QRectF(PAD_L, y - 15, w - PAD_L - PAD_R - 2, 12), Qt.AlignRight, "24 fps")

        pts = sorted((t, s) for t, s in self.pts)
        p.setPen(QPen(self.accent if pts else theme.qc("#3a3a44"), 2))
        path = QPainterPath()
        steps = max(2, int(w - PAD_L - PAD_R))
        for i in range(steps + 1):
            t = i / steps * (self.dur() or 1)
            pt = QPointF(self.x(t), self.y(ramp.evaluate(pts, t)))
            if i:
                path.lineTo(pt)
            else:
                path.moveTo(pt)
        p.drawPath(path)

        for q in self.pts:
            r = 5.5 if q is self.drag or q is self.hover else 4
            p.setPen(QPen(self.accent, 2))
            p.setBrush(QColor("#ffffff"))
            p.drawEllipse(QPointF(self.x(q[0]), self.y(q[1])), r, r)

        if not self.pts:
            p.setPen(theme.qc("#5a5a64"))
            msg = "Click to add a point" if self.dur() and lv.kind == "video" else "Open a video to draw a ramp"
            p.drawText(QRectF(PAD_L, self.y(1) - 22, w - PAD_L, 14), Qt.AlignCenter, msg)

        if self.dur():
            x = round(self.x(lv.time_pos)) + 0.5
            p.setPen(QPen(QColor(255, 255, 255, 140), 1))
            p.drawLine(QPointF(x, PAD_T), QPointF(x, h - PAD_B))

        if self.drag:
            t, s = self.drag
            text = f"{media.fmt_time(t)}.{int((t % 1) * 10)}   {s:.2f}x"
            px, py = self.x(t), max(16, self.y(s) - 10)
            p.setPen(QColor("#ffffff"))
            rect = QRectF(px - 160, py - 10, 150, 14) if px > w / 2 else QRectF(px + 10, py - 10, 150, 14)
            p.drawText(rect, (Qt.AlignRight if px > w / 2 else Qt.AlignLeft) | Qt.AlignVCenter, text)

    # ------------------------------------------------------------ mouse

    def _editable(self) -> bool:
        return bool(self.dur()) and self.c.lv.kind == "video"

    def _commit(self, persist: bool):
        self.c.set_ramp_points([(t, s) for t, s in self.pts], persist=persist)

    def mousePressEvent(self, e):
        if not self._editable():
            return
        pos = e.position()
        hit = self.point_at(pos)
        if e.button() == Qt.RightButton:
            if hit:
                self.pts.remove(hit)
                self._commit(True)
            return
        if e.button() != Qt.LeftButton:
            return
        if not hit:
            hit = [self.t_at(pos.x()), self.s_at(pos.y())]
            self.pts.append(hit)
        self.drag = hit
        self._commit(False)
        self.update()

    def mouseMoveEvent(self, e):
        pos = e.position()
        if self.drag:
            s = self.s_at(pos.y())
            if abs(math.log(s)) < 0.05:
                s = 1.0
            self.drag[0], self.drag[1] = self.t_at(pos.x()), s
            self._commit(False)
            self.update()
            return
        over = self.point_at(pos)
        if over is not self.hover:
            self.hover = over
            self.update()
        self.setCursor(Qt.OpenHandCursor if over else Qt.CrossCursor)

    def mouseReleaseEvent(self, e):
        if self.drag is not None:
            self.drag = None
            self._commit(True)
            self.update()

    def mouseDoubleClickEvent(self, e):
        hit = self.point_at(e.position())
        if hit and self._editable():
            self.pts.remove(hit)
            self.hover = None
            self._commit(True)
