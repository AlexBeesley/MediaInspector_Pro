"""The X-ray card's picture: the whole file as one spectrogram (time across,
frequency up, magma like the live view), the cutoff the analysis found, and
the playhead. Click to jump there."""

from __future__ import annotations

import numpy as np
from PySide6.QtCore import QPointF, QRectF, Qt
from PySide6.QtGui import QColor, QFont, QImage, QPainter, QPen
from PySide6.QtWidgets import QWidget

from . import theme


def _magma() -> np.ndarray:
    stops = [(0, 0, 0, 4), (0.13, 28, 16, 68), (0.25, 79, 18, 123), (0.38, 129, 37, 129),
             (0.5, 181, 54, 122), (0.63, 229, 80, 100), (0.75, 251, 135, 97),
             (0.88, 254, 194, 135), (1, 252, 253, 191)]
    xs = np.array([s[0] for s in stops])
    t = np.linspace(0, 1, 256)
    lut = np.stack([np.interp(t, xs, [s[i] for s in stops]) for i in (1, 2, 3)], axis=1)
    return np.round(lut).astype(np.uint8)


MAGMA = _magma()


def spectrogram_image(image: np.ndarray) -> QImage:
    """[cols, rows] levels, row 0 = 0 Hz -> an RGB image with 0 Hz at the bottom."""
    rgb = MAGMA[image.T[::-1]]                       # rows top-down, highest frequency first
    rgb = np.ascontiguousarray(rgb)
    h, w = rgb.shape[:2]
    return QImage(rgb.data, w, h, 3 * w, QImage.Format_RGB888).copy()


class XrayOverview(QWidget):
    def __init__(self, c, parent=None):
        super().__init__(parent)
        self.c = c
        self.setFixedHeight(92)
        self.setCursor(Qt.PointingHandCursor)
        self.setToolTip("Click to jump there")
        self.accent = QColor("#ffd000")
        self.img: QImage | None = None
        self._for = None
        c.xray_changed.connect(self._rebuild)
        c.store.subscribe(lambda ch: "time_pos" in ch and self.img is not None and self.update())

    def _rebuild(self):
        x = self.c.xray
        r = x.get("result")
        self.img = spectrogram_image(r.image) if r is not None and r.cols else None
        self._for = x.get("path")
        self.update()

    def paintEvent(self, _):
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        w, h = self.width(), self.height()
        p.fillRect(self.rect(), QColor("#07070a"))
        x = self.c.xray
        r = x.get("result")
        if self.img is None or r is None:
            p.setPen(theme.qc(theme.FAINT))
            p.drawText(self.rect(), Qt.AlignCenter,
                       "Decoding…" if x.get("state") == "running" else "Spectrum appears here")
            p.setPen(QPen(theme.qc(theme.BORDER), 1))
            p.drawRect(QRectF(0.5, 0.5, w - 1, h - 1))
            return
        p.setRenderHint(QPainter.SmoothPixmapTransform)
        p.drawImage(QRectF(0, 0, w, h), self.img)
        nyq = r.sample_rate / 2
        step = 2000 if nyq <= 12000 else 5000 if nyq <= 30000 else 10000
        p.setFont(QFont(self.font().family(), 7))
        f = step
        while f < nyq - step * 0.3:
            y = h - f / nyq * h
            p.setPen(QPen(QColor(255, 255, 255, 36), 1))
            p.drawLine(QPointF(0, y), QPointF(w, y))
            p.setPen(QColor(255, 255, 255, 160))
            p.drawText(QPointF(3, y - 2), f"{f / 1000:g}k")
            f += step
        if r.cutoff_hz:
            y = h - r.cutoff_hz / nyq * h
            p.setPen(QPen(theme.qc(theme.HDR), 1.5))
            p.drawLine(QPointF(0, y), QPointF(w, y))
            p.drawText(QRectF(0, y - 13, w - 4, 12), Qt.AlignRight, f"cutoff {r.cutoff_hz / 1000:.1f} kHz")
        if self._for == self.c.lv.path and r.seconds > 0:
            px = self.c.lv.time_pos / r.seconds * w
            if 0 <= px <= w:
                p.setPen(QPen(self.accent, 1.5))
                p.drawLine(QPointF(px, 0), QPointF(px, h))
        p.setPen(QPen(theme.qc(theme.BORDER), 1))
        p.setBrush(Qt.NoBrush)
        p.drawRect(QRectF(0.5, 0.5, w - 1, h - 1))

    def mousePressEvent(self, e):
        r = self.c.xray.get("result")
        if r is None or self._for != self.c.lv.path:
            return
        self.c.seek(e.position().x() / max(1, self.width()) * r.seconds)
