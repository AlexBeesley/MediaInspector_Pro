"""The picture: libmpv renders into this OpenGL widget, and the overlays (crop
box, spectrogram scale, info, help) are painted over it in the same pass.

One surface, so nothing has to be positioned over a foreign native window -
which is what made the old build's layout and DPI handling fragile.
"""

from __future__ import annotations

import mpv
from PySide6.QtCore import QPointF, QRectF, Qt, Signal
from PySide6.QtGui import QColor, QFont, QOpenGLContext, QPainter, QPen
from PySide6.QtOpenGLWidgets import QOpenGLWidget

from ..core import layout
from ..core.filters import Crop
from . import theme

HANDLES = ("nw", "n", "ne", "e", "se", "s", "sw", "w")


class VideoView(QOpenGLWidget):
    _frame_ready = Signal()

    def __init__(self, controller, parent=None):
        super().__init__(parent)
        self.c = controller
        self.ctx = None
        self.accent = QColor(theme.qc("#ffd000"))
        self.show_info = False
        self.show_help = False
        self.help_lines: list[tuple[str, str]] = []
        self.setMouseTracking(True)
        self.setFocusPolicy(Qt.StrongFocus)
        self.setMinimumSize(200, 150)
        self._drag = None
        self._frame_ready.connect(self.update, Qt.QueuedConnection)
        controller.store.subscribe(self._on_change)

    # ------------------------------------------------------------ GL

    def initializeGL(self):
        def get_proc_address(_, name):
            ctx = QOpenGLContext.currentContext()
            addr = ctx.getProcAddress(name.decode()) if ctx else 0
            return int(addr) if addr else 0

        self._gpa = mpv.MpvGlGetProcAddressFn(get_proc_address)
        self.ctx = mpv.MpvRenderContext(self.c.engine.mpv, "opengl",
                                        opengl_init_params={"get_proc_address": self._gpa})
        self.ctx.update_cb = self._frame_ready.emit

    def paintGL(self):
        p = QPainter(self)
        try:
            # mpv draws inside the painter's native bracket: QPainter leaves GL
            # state behind (blending, masks) that otherwise corrupts the next
            # frame mpv renders - measured as a green cast once overlays drew.
            if self.ctx:
                r = self.devicePixelRatioF()
                p.beginNativePainting()
                self.ctx.render(flip_y=True, opengl_fbo={"w": round(self.width() * r), "h": round(self.height() * r),
                                                         "fbo": self.defaultFramebufferObject()})
                p.endNativePainting()
            p.setRenderHint(QPainter.Antialiasing)
            self._paint_overlay(p)
        finally:
            p.end()

    def release(self):
        """Free the render context before the engine goes: the other order
        crashes inside the driver."""
        if self.ctx:
            self.makeCurrent()
            self.ctx.free()
            self.ctx = None
            self.doneCurrent()

    def _on_change(self, changed: set[str]):
        if changed & {"crop_box", "crop_editing", "spec_live", "xray_cutoff", "out_rect", "path", "kind"}:
            self.update()

    # ------------------------------------------------------------ geometry

    def picture_rect(self) -> QRectF | None:
        """Where the picture sits in this widget, from the engine's own
        report of its output rectangle (so zoom and letterboxing count)."""
        x0, y0, x1, y1 = self.c.lv.out_rect
        if x1 - x0 < 4 or y1 - y0 < 4:
            return None
        r = self.devicePixelRatioF()
        return QRectF(x0 / r, y0 / r, (x1 - x0) / r, (y1 - y0) / r)

    def _box_view(self) -> QRectF | None:
        """The crop box on screen while editing."""
        box, pic = self.c.lv.crop_box, self.picture_rect()
        sw, sh = self.c.source_size()
        if not box or not pic or sw < 2:
            return None
        u0, v0, u1, v1 = layout.view_from_src(box.x, box.y, box.x + box.w, box.y + box.h, sw, sh,
                                              self.c.rotation())
        return QRectF(pic.x() + u0 * pic.width(), pic.y() + v0 * pic.height(),
                      (u1 - u0) * pic.width(), (v1 - v0) * pic.height())

    def _set_box_view(self, r: QRectF):
        pic = self.picture_rect()
        sw, sh = self.c.source_size()
        if not pic:
            return
        u0 = (r.left() - pic.x()) / pic.width()
        v0 = (r.top() - pic.y()) / pic.height()
        u1 = (r.right() - pic.x()) / pic.width()
        v1 = (r.bottom() - pic.y()) / pic.height()
        x0, y0, x1, y1 = layout.src_from_view(u0, v0, u1, v1, sw, sh, self.c.rotation())
        self.c.crop_set_box(Crop(round(x1 - x0), round(y1 - y0), round(x0), round(y0)))

    def _handle_points(self, r: QRectF) -> dict:
        cx, cy = r.center().x(), r.center().y()
        return {"nw": QPointF(r.left(), r.top()), "n": QPointF(cx, r.top()), "ne": QPointF(r.right(), r.top()),
                "e": QPointF(r.right(), cy), "se": QPointF(r.right(), r.bottom()), "s": QPointF(cx, r.bottom()),
                "sw": QPointF(r.left(), r.bottom()), "w": QPointF(r.left(), cy)}

    def _ratio(self) -> float | None:
        label = self.c.lv.crop_ratio
        if not label:
            return None
        a, b = label.split(":")
        return float(a) / float(b)

    # ------------------------------------------------------------ painting

    def _paint_overlay(self, p: QPainter):
        lv = self.c.lv
        if not lv.path:
            p.setPen(theme.qc(theme.FAINT))
            p.setFont(QFont(self.font().family(), 12))
            p.drawText(self.rect(), Qt.AlignCenter, "Drop a file here, or press Ctrl+O")
        if lv.crop_editing:
            self._paint_crop(p)
        if lv.spec_live:
            self._paint_spectro_scale(p)
        if self.show_info:
            self._paint_panel(p, self.c.info_lines(), QPointF(12, 12))
        if self.show_help and self.help_lines:
            self._paint_help(p)

    def _paint_crop(self, p: QPainter):
        pic, box = self.picture_rect(), self._box_view()
        if not pic or not box:
            return
        dim = QColor(0, 0, 0, 150)
        p.fillRect(QRectF(pic.left(), pic.top(), pic.width(), box.top() - pic.top()), dim)
        p.fillRect(QRectF(pic.left(), box.bottom(), pic.width(), pic.bottom() - box.bottom()), dim)
        p.fillRect(QRectF(pic.left(), box.top(), box.left() - pic.left(), box.height()), dim)
        p.fillRect(QRectF(box.right(), box.top(), pic.right() - box.right(), box.height()), dim)
        p.setPen(QPen(QColor(255, 255, 255, 70), 1))
        for i in (1, 2):
            x = box.left() + box.width() * i / 3
            y = box.top() + box.height() * i / 3
            p.drawLine(QPointF(x, box.top()), QPointF(x, box.bottom()))
            p.drawLine(QPointF(box.left(), y), QPointF(box.right(), y))
        p.setPen(QPen(self.accent, 2))
        p.setBrush(Qt.NoBrush)
        p.drawRect(box)
        p.setBrush(QColor("#ffffff"))
        for pt in self._handle_points(box).values():
            p.drawRoundedRect(QRectF(pt.x() - 5, pt.y() - 5, 10, 10), 2, 2)
        c = self.c.lv.crop_box
        text = f"{c.w} x {c.h}   {self.c.lv.crop_ratio or 'free'}"
        p.setPen(QColor("#ffffff"))
        p.setFont(QFont(self.font().family(), 10))
        above = box.top() - 22 > pic.top()
        y = box.top() - 20 if above else box.top() + 4
        p.drawText(QRectF(box.left(), y, box.width(), 16), Qt.AlignHCenter | Qt.AlignVCenter, text)

    def _paint_spectro_scale(self, p: QPainter):
        pic, sr = self.picture_rect(), self.c.lv.samplerate
        if not pic or not sr:
            return
        nyq = sr / 2
        step = 2000 if nyq <= 12000 else 5000 if nyq <= 30000 else 10000
        p.setFont(QFont(self.font().family(), 9))
        f = step
        while f < nyq - step * 0.3:
            y = pic.bottom() - f / nyq * pic.height()
            p.setPen(QPen(QColor(255, 255, 255, 50), 1))
            p.drawLine(QPointF(pic.left(), y), QPointF(pic.right(), y))
            p.setPen(QColor(255, 255, 255, 170))
            p.drawText(QPointF(pic.left() + 6, y - 3), f"{f / 1000:g}k")
            f += step
        cut = self.c.lv.xray_cutoff
        if 0 < cut < nyq:
            y = pic.bottom() - cut / nyq * pic.height()
            p.setPen(QPen(theme.qc(theme.HDR), 2))
            p.drawLine(QPointF(pic.left(), y), QPointF(pic.right(), y))
            p.drawText(QRectF(pic.left(), y - 18, pic.width() - 8, 16), Qt.AlignRight | Qt.AlignVCenter,
                       f"cutoff {cut / 1000:.1f} kHz")

    def _paint_panel(self, p: QPainter, lines: list[str], at: QPointF):
        p.setFont(QFont(self.font().family(), 10))
        fm = p.fontMetrics()
        w = max(fm.horizontalAdvance(t) for t in lines) + 24
        h = fm.height() * len(lines) + 18
        r = QRectF(at.x(), at.y(), min(w, self.width() - 24), h)
        p.setPen(QPen(theme.qc(theme.BORDER_HI), 1))
        p.setBrush(QColor(22, 22, 28, 235))
        p.drawRoundedRect(r, 6, 6)
        for i, t in enumerate(lines):
            p.setPen(self.accent if i == 0 else theme.qc(theme.TEXT))
            p.drawText(QPointF(r.left() + 12, r.top() + 9 + fm.ascent() + i * fm.height()), t)

    def _paint_help(self, p: QPainter):
        p.fillRect(self.rect(), QColor(0, 0, 0, 160))
        p.setFont(QFont(self.font().family(), 10))
        fm = p.fontMetrics()
        rows = [("Shortcuts", "click anywhere to close")] + self.help_lines
        kw = max(fm.horizontalAdvance(k) for k, _ in rows) + 30
        w = min(self.width() - 24, kw + max(fm.horizontalAdvance(v) for _, v in rows) + 40)
        lh = fm.height() + 6
        h = lh * len(rows) + 24
        r = QRectF((self.width() - w) / 2, max(8, (self.height() - h) / 2), w, h)
        p.setPen(QPen(theme.qc(theme.BORDER_HI), 1))
        p.setBrush(QColor(22, 22, 28, 245))
        p.drawRoundedRect(r, 8, 8)
        for i, (k, v) in enumerate(rows):
            y = r.top() + 12 + fm.ascent() + i * lh
            p.setPen(self.accent)
            p.drawText(QPointF(r.left() + 18, y), k)
            p.setPen(theme.qc(theme.TEXT if i else theme.DIM))
            p.drawText(QPointF(r.left() + 18 + kw, y), v)

    # ------------------------------------------------------------ mouse

    def _hit(self, pos: QPointF) -> str | None:
        box = self._box_view()
        if not box:
            return None
        for name, pt in self._handle_points(box).items():
            if abs(pt.x() - pos.x()) <= 8 and abs(pt.y() - pos.y()) <= 8:
                return name
        return "move" if box.contains(pos) else None

    def mousePressEvent(self, e):
        self.setFocus()
        pos = e.position()
        if self.show_help:
            self.show_help = False
            self.update()
            return
        lv = self.c.lv
        if e.button() == Qt.MiddleButton:
            self.c.toggle_pause()
            return
        if e.button() == Qt.BackButton:
            self.c.frame_step(False)
            return
        if e.button() == Qt.ForwardButton:
            self.c.frame_step(True)
            return
        if e.button() != Qt.LeftButton:
            return
        if lv.crop_editing:
            hit = self._hit(pos)
            if hit:
                self._drag = {"mode": "crop", "hit": hit, "start": pos, "box": QRectF(self._box_view())}
            return
        self._drag = {"mode": "pan", "start": pos, "last": pos, "moved": False,
                      "pan": (lv.pan_x, lv.pan_y)}

    def mouseMoveEvent(self, e):
        pos = e.position()
        d = self._drag
        if not d:
            if self.c.lv.crop_editing:
                hit = self._hit(pos)
                cursors = {"move": Qt.SizeAllCursor, "n": Qt.SizeVerCursor, "s": Qt.SizeVerCursor,
                           "e": Qt.SizeHorCursor, "w": Qt.SizeHorCursor, "nw": Qt.SizeFDiagCursor,
                           "se": Qt.SizeFDiagCursor, "ne": Qt.SizeBDiagCursor, "sw": Qt.SizeBDiagCursor}
                self.setCursor(cursors.get(hit, Qt.ArrowCursor))
            else:
                self.setCursor(Qt.ArrowCursor)
            return
        if d["mode"] == "crop":
            self._drag_crop(d, pos)
            return
        delta = pos - d["start"]
        if not d["moved"] and abs(delta.x()) + abs(delta.y()) < 4:
            return
        d["moved"] = True
        pic = self.picture_rect()
        if not pic:
            return
        lv = self.c.lv
        if lv.crop and lv.kind in ("video", "photo"):
            # Slide the full frame under the crop: drag right, see further left.
            step = pos - d["last"]
            d["last"] = pos
            sw, sh = self.c.source_size()
            a = layout.src_from_view(0.5, 0.5, 0.5, 0.5, lv.crop.w, lv.crop.h, self.c.rotation())
            b = layout.src_from_view(0.5 + step.x() / pic.width(), 0.5 + step.y() / pic.height(),
                                     0.5 + step.x() / pic.width(), 0.5 + step.y() / pic.height(),
                                     lv.crop.w, lv.crop.h, self.c.rotation())
            self.c.crop_slide(-(b[0] - a[0]), -(b[1] - a[1]))
        else:
            px, py = d["pan"]
            self.c.engine.set("video-pan-x", px + delta.x() / pic.width())
            self.c.engine.set("video-pan-y", py + delta.y() / pic.height())

    def _drag_crop(self, d, pos: QPointF):
        pic = self.picture_rect()
        if not pic:
            return
        r = QRectF(d["box"])
        dx, dy = pos.x() - d["start"].x(), pos.y() - d["start"].y()
        hit = d["hit"]
        if hit == "move":
            r.translate(dx, dy)
            r.moveLeft(max(pic.left(), min(r.left(), pic.right() - r.width())))
            r.moveTop(max(pic.top(), min(r.top(), pic.bottom() - r.height())))
        else:
            if "w" in hit:
                r.setLeft(min(r.left() + dx, r.right() - 12))
            if "e" in hit:
                r.setRight(max(r.right() + dx, r.left() + 12))
            if "n" in hit:
                r.setTop(min(r.top() + dy, r.bottom() - 12))
            if "s" in hit:
                r.setBottom(max(r.bottom() + dy, r.top() + 12))
            ratio = self._ratio()
            if ratio:
                # A locked ratio holds from any handle; the edge being pulled leads.
                if hit in ("n", "s"):
                    w = r.height() * ratio
                    r.setLeft(r.center().x() - w / 2)
                    r.setWidth(w)
                else:
                    h = r.width() / ratio
                    if "n" in hit:
                        r.setTop(r.bottom() - h)
                    else:
                        r.setHeight(h)
            r = r.intersected(pic)
        self._set_box_view(r)

    def mouseReleaseEvent(self, e):
        d, self._drag = self._drag, None
        if not d or e.button() != Qt.LeftButton:
            return
        if d["mode"] == "pan" and not d["moved"] and self.c.lv.kind in ("video", "audio"):
            self.c.toggle_pause()

    def mouseDoubleClickEvent(self, e):
        pass   # deliberately nothing: a fast double click is two pauses, not fullscreen

    def wheelEvent(self, e):
        dy = e.angleDelta().y()
        dx = e.angleDelta().x()
        if dx and not dy:
            self.c.frame_step(dx < 0)
            return
        if not dy:
            return
        up = dy > 0
        if e.modifiers() & Qt.ControlModifier or self.c.lv.kind == "photo":
            self.c.zoom_by(0.15 if up else -0.15)
        else:
            self.c.nudge_speed(0.1 if up else -0.1)
