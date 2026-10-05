"""The window: header, the card panel, the picture and the transport strip.

Owns what only a window can do - its size, fullscreen, always-on-top, UI
scale, dialogs, the keyboard map, drag-and-drop - and asks the controller for
everything else.
"""

from __future__ import annotations

import os

from PySide6.QtCore import QTimer, QUrl, Qt
from PySide6.QtGui import QColor, QDesktopServices, QGuiApplication, QKeySequence
from PySide6.QtWidgets import (QComboBox, QFileDialog, QHBoxLayout, QLabel, QLineEdit, QMainWindow, QSplitter,
                               QVBoxLayout, QWidget)

from .. import paths
from ..controller import Controller
from ..core import layout, media
from . import theme
from .panel import SHORTCUTS, Panel
from .transport import TransportBar
from .video_view import VideoView
from .widgets import apply_kind, btn, set_on

FILE_FILTER = ("All media (" + " ".join(f"*.{e}" for e in sorted(media.ALL)) + ");;"
               "Video (" + " ".join(f"*.{e}" for e in sorted(media.VIDEO)) + ");;"
               "Photos (" + " ".join(f"*.{e}" for e in sorted(media.PHOTO | media.RAW)) + ");;"
               "Audio (" + " ".join(f"*.{e}" for e in sorted(media.AUDIO)) + ");;All files (*)")

UI_SCALE_STEP = 1.1


class MainWindow(QMainWindow):
    def __init__(self, c: Controller):
        super().__init__()
        self.c = c
        self.setWindowTitle("MediaInspector")
        self.setAcceptDrops(True)
        self.setMinimumSize(900, 560)
        icon = paths.assets("app.ico")
        if os.path.exists(icon):
            from PySide6.QtGui import QIcon
            self.setWindowIcon(QIcon(icon))
        self.accent = media.TIER_COLOURS["yellow"]

        root = QWidget()
        root.setObjectName("root")
        v = QVBoxLayout(root)
        v.setContentsMargins(0, 0, 0, 0)
        v.setSpacing(0)
        v.addWidget(self._header())

        self.split = QSplitter(Qt.Horizontal)
        self.split.setHandleWidth(5)
        self.split.setChildrenCollapsible(False)
        self.view = VideoView(c)
        self.view.help_lines = SHORTCUTS
        self.transport = TransportBar(c)
        right = QWidget()
        rl = QVBoxLayout(right)
        rl.setContentsMargins(0, 0, 0, 0)
        rl.setSpacing(0)
        rl.addWidget(self.view, 1)
        rl.addWidget(self.transport)
        self.panel = Panel(c, self)
        self.panel.setMinimumWidth(layout.MIN_PANEL)
        self.split.addWidget(self.panel)
        self.split.addWidget(right)
        self.split.setStretchFactor(1, 1)
        self.split.splitterMoved.connect(self._splitter_moved)
        self.split.handle(1).installEventFilter(self)
        v.addWidget(self.split, 1)
        self.setCentralWidget(root)

        self._toast = QLabel(self)
        self._toast.setObjectName("toast")
        self._toast.hide()
        self._toast_timer = QTimer(self, interval=2600, singleShot=True, timeout=self._toast.hide)

        self._fit = QTimer(self, interval=60, singleShot=True, timeout=self.fit_to_media)
        c.message.connect(self.toast)
        c.fit_requested.connect(self._fit.start)
        c.store.subscribe(self._on_change)
        self._restore_geometry()
        self.apply_theme()
        apply_kind("video")

    # ------------------------------------------------------------ header

    def _header(self) -> QWidget:
        h = QWidget()
        h.setObjectName("header")
        h.setAttribute(Qt.WA_StyledBackground, True)
        h.setFixedHeight(46)
        lay = QHBoxLayout(h)
        lay.setContentsMargins(10, 0, 10, 0)
        lay.setSpacing(10)
        self.kind_badge = QLabel("VIDEO")
        self.kind_badge.setObjectName("kindBadge")
        lay.addWidget(self.kind_badge)
        col = QVBoxLayout()
        col.setSpacing(1)
        self.title_lbl = QLabel("Open a file to start")
        self.title_lbl.setObjectName("title")
        self.chips = QHBoxLayout()
        self.chips.setSpacing(5)
        self.chips.addStretch(1)
        col.addWidget(self.title_lbl)
        col.addLayout(self.chips)
        lay.addLayout(col, 1)
        self.crop_head = btn("Crop", self.c.crop_toggle, "Adjust the crop on the picture  (c)", ["video", "photo"],
                             grow=False)
        self.top_head = btn("Pin", self.toggle_on_top, "Keep the window on top", grow=False)
        for b in (btn("Open", self.open_dialog, "Open a file  (Ctrl+O)", grow=False), self.crop_head,
                  btn("Full", self.toggle_fullscreen, "Fullscreen  (f)", grow=False), self.top_head):
            lay.addWidget(b)
        return h

    def _chips(self):
        while self.chips.count() > 1:
            w = self.chips.takeAt(0).widget()
            if w:
                # Hidden now: deleteLater runs on the next loop, and until then a
                # removed chip would still paint where it used to sit.
                w.hide()
                w.deleteLater()
        lv = self.c.lv
        items = []
        if lv.width and lv.kind != "audio":     # an audio file's "size" is the spectrogram's
            w, h = self.c.display_size()
            items.append((f"{w}×{h}", "true"))
        if lv.kind == "video" and lv.fps:
            items.append((f"{lv.fps:.2f}".rstrip("0").rstrip(".") + " fps", "lit"))
        codec = lv.video_codec.split(" ")[0] if lv.video_codec else lv.audio_codec
        if codec:
            items.append((codec, "true"))
        if lv.path:
            hw = lv.hwdec
            items.append(("GPU " + hw if hw and hw != "no" else "CPU decode", "true"))
        if lv.kind == "video" and lv.frame:
            items.append((f"frame {lv.frame}", "true"))
        for i, (text, kind) in enumerate(items):
            chip = QLabel(text)
            chip.setProperty("chip", kind)
            self.chips.insertWidget(i, chip)

    # ------------------------------------------------------------ state

    def _on_change(self, changed: set[str]):
        lv = self.c.lv
        if changed & {"kind", "fps"}:
            apply_kind(lv.kind or "video")
            self.kind_badge.setText((lv.kind or "media").upper())
            self.apply_theme()
        if "path" in changed or "filename" in changed:
            self.title_lbl.setText(lv.filename or "Open a file to start")
            self.setWindowTitle(f"MediaInspector - {lv.filename}" if lv.filename else "MediaInspector")
        if changed & {"width", "height", "fps", "video_codec", "audio_codec", "hwdec", "path", "crop", "rotate",
                      "user_rotate"} or ("frame" in changed and lv.pause):
            self._chips()
        if changed & {"width", "height", "rotate", "user_rotate", "crop"}:
            self._fit.start()
        if "crop_editing" in changed:
            set_on(self.crop_head, lv.crop_editing)
        if "settings.auto_panel" in changed and self.c.st.auto_panel:
            self.apply_auto_panel()

    def apply_theme(self):
        lv = self.c.lv
        self.accent = media.TIER_COLOURS[media.tier(lv.kind or "video", lv.fps)]
        self.setStyleSheet(theme.stylesheet(self.accent, self.c.st.ui_scale))
        self.view.accent = QColor(self.accent)
        self.transport.set_accent(self.accent)
        self.panel.set_accent(self.accent)
        self.view.update()

    # ------------------------------------------------------------ geometry

    def _restore_geometry(self):
        g = self.c.st.window or {}
        if g.get("w") and g.get("h"):
            self.resize(g["w"], g["h"])
            self.move(g.get("x", 100), g.get("y", 100))
        else:
            self.resize(1600, 1000)
        if self.c.st.auto_panel:
            QTimer.singleShot(0, self.apply_auto_panel)
        else:
            QTimer.singleShot(0, lambda: self.set_panel_width(self.c.st.panel_width))
        if g.get("maximized"):
            QTimer.singleShot(0, self.showMaximized)

    def save_geometry(self):
        g = self.normalGeometry() if self.isMaximized() or self.isFullScreen() else self.geometry()
        self.c.store.configure(window={"x": g.x(), "y": g.y(), "w": g.width(), "h": g.height(),
                                       "maximized": self.isMaximized()})

    def set_panel_width(self, px: int):
        total = self.split.width() - self.split.handleWidth()
        w = layout.clamp_panel(px, total)
        self.split.setSizes([w, max(1, total - w)])
        return w

    def apply_auto_panel(self):
        """Give the picture the shape it wants; the panel takes the rest."""
        if not self.c.st.auto_panel:
            return
        w, h = self.c.display_size()
        if w < 1 or h < 1:
            return
        total = self.split.width() - self.split.handleWidth()
        self.set_panel_width(layout.auto_panel_width(total, self.view.height(), w / h))

    def _splitter_moved(self, *_):
        if self._adjusting:
            return
        if self.c.st.auto_panel:
            self.c.store.configure(auto_panel=False)
            self.toast("Panel width is manual now - double-click the divider to hand it back")
        self.c.store.configure(panel_width=self.panel.width())

    _adjusting = False

    def eventFilter(self, obj, ev):
        if ev.type() == ev.Type.MouseButtonDblClick:
            self.set_auto_panel(True)
            self.toast("Panel follows the media's shape again")
            return True
        return super().eventFilter(obj, ev)

    def set_auto_panel(self, on: bool):
        self.c.store.configure(auto_panel=bool(on))
        if on:
            self.apply_auto_panel()

    def fit_to_media(self):
        """Size the window so the picture lands at the media's own size,
        chrome added around it rather than carved out of it."""
        if not self.c.st.fit_window or self.isMaximized() or self.isFullScreen():
            self.apply_auto_panel()
            return
        lv = self.c.lv
        if lv.kind == "audio" and not lv.spec_live:
            self.apply_auto_panel()
            return
        mw, mh = self.c.view_size()
        if mw < 1 or mh < 1:
            return
        screen = self.screen() or QGuiApplication.primaryScreen()
        area = screen.availableGeometry()
        dpr = self.devicePixelRatioF() or 1.0
        # The picture's pixels are device pixels; the window is laid out in
        # logical ones. On a 150% display a 1920 px frame needs 1280 logical.
        mw, mh = mw / dpr, mh / dpr
        panel_w = layout.clamp_panel(self.panel.width(), self.width())
        chrome_w = self.width() - self.view.width() if not self.c.st.auto_panel else panel_w + self.split.handleWidth()
        chrome_h = self.height() - self.view.height()
        size = layout.fit_window(round(mw), round(mh), chrome_w, chrome_h, area.width(), area.height())
        if not size:
            return
        self._adjusting = True
        self.resize(*size)
        geo = self.frameGeometry()
        if not area.contains(geo):
            self.move(max(area.left(), min(geo.left(), area.right() - geo.width())),
                      max(area.top(), min(geo.top(), area.bottom() - geo.height())))
        QTimer.singleShot(0, self._after_fit)

    def _after_fit(self):
        self.apply_auto_panel()
        self._adjusting = False

    def resizeEvent(self, e):
        super().resizeEvent(e)
        if self.c.st.auto_panel:
            self._adjusting = True
            self.apply_auto_panel()
            self._adjusting = False
        self._place_toast()

    # ------------------------------------------------------------ window actions

    def toast(self, text: str):
        self._toast.setText(text)
        self._toast.adjustSize()
        self._place_toast()
        self._toast.show()
        self._toast.raise_()
        self._toast_timer.start()

    def _place_toast(self):
        t = self._toast
        w = min(t.sizeHint().width(), self.width() - 40)
        t.resize(w, t.sizeHint().height())
        t.move((self.width() - w) // 2, self.height() - t.height() - 24)

    def open_dialog(self):
        start = os.path.dirname(self.c.lv.path) if self.c.lv.path else os.path.expanduser("~")
        path, _ = QFileDialog.getOpenFileName(self, "Open media", start, FILE_FILTER)
        if path:
            self.c.open(path)

    def open_folder(self, folder: str):
        os.makedirs(folder, exist_ok=True)
        QDesktopServices.openUrl(QUrl.fromLocalFile(folder))

    def open_shader_folder(self):
        self.open_folder(paths.user_shader_dir())
        self.toast("Drop .glsl files here, then press Rescan")

    def toggle_fullscreen(self):
        if self.isFullScreen():
            self.showNormal()
        else:
            self.showFullScreen()

    def toggle_on_top(self):
        on = not bool(self.windowFlags() & Qt.WindowStaysOnTopHint)
        self.setWindowFlag(Qt.WindowStaysOnTopHint, on)
        self.show()
        set_on(self.top_head, on)
        self.toast("Always on top" if on else "On top off")

    def toggle_info(self):
        self.view.show_info = not self.view.show_info
        self.view.update()

    def toggle_help(self):
        self.view.show_help = not self.view.show_help
        self.view.update()

    def ui_scale_by(self, step: int):
        s = 1.0 if step == 0 else self.c.st.ui_scale * (UI_SCALE_STEP if step > 0 else 1 / UI_SCALE_STEP)
        s = max(0.7, min(2.0, s))
        self.c.store.configure(ui_scale=s)
        self.apply_theme()
        self.toast(f"UI scale {s * 100:.0f}%")

    # ------------------------------------------------------------ keyboard

    def keyPressEvent(self, e):
        focus = QGuiApplication.focusObject()
        if isinstance(focus, (QLineEdit,)) or (isinstance(focus, QComboBox) and focus.isEditable()):
            return super().keyPressEvent(e)
        c, k, mods = self.c, e.key(), e.modifiers()
        shift, ctrl, alt = bool(mods & Qt.ShiftModifier), bool(mods & Qt.ControlModifier), bool(mods & Qt.AltModifier)
        if alt and k in (Qt.Key_Left, Qt.Key_Right, Qt.Key_Up, Qt.Key_Down):
            dx = {Qt.Key_Left: -8, Qt.Key_Right: 8}.get(k, 0)
            dy = {Qt.Key_Up: -8, Qt.Key_Down: 8}.get(k, 0)
            c.crop_slide(dx, dy)
            return
        if ctrl:
            if k == Qt.Key_O:
                self.open_dialog()
            elif k in (Qt.Key_Equal, Qt.Key_Plus):
                self.ui_scale_by(1)
            elif k in (Qt.Key_Minus, Qt.Key_Underscore):
                self.ui_scale_by(-1)
            elif k == Qt.Key_0:
                self.ui_scale_by(0)
            return
        keys = {
            Qt.Key_Space: c.toggle_pause,
            Qt.Key_PageUp: lambda: c.step(-1), Qt.Key_PageDown: lambda: c.step(1),
            Qt.Key_Less: lambda: c.step(-1), Qt.Key_Greater: lambda: c.step(1),
            Qt.Key_BracketLeft: lambda: c.nudge_speed(-0.1), Qt.Key_BracketRight: lambda: c.nudge_speed(0.1),
            Qt.Key_Backspace: c.reset_speed, Qt.Key_S: c.slowmo_toggle,
            Qt.Key_B: lambda: c.set_browse_all(not c.st.browse_all), Qt.Key_E: c.export_frame,
            Qt.Key_I: self.toggle_info, Qt.Key_U: c.cycle_upscale, Qt.Key_T: c.cycle_trail,
            Qt.Key_C: c.crop_toggle, Qt.Key_Z: c.zoom_fit, Qt.Key_X: c.zoom_actual,
            Qt.Key_W: self.fit_to_media, Qt.Key_9: lambda: c.volume_by(-5), Qt.Key_0: lambda: c.volume_by(5),
            Qt.Key_M: c.toggle_mute, Qt.Key_A: c.cycle_audio, Qt.Key_L: c.toggle_loop,
            Qt.Key_F: self.toggle_fullscreen, Qt.Key_F11: self.toggle_fullscreen,
            Qt.Key_H: self.toggle_help, Qt.Key_F1: self.toggle_help,
        }
        if k == Qt.Key_Left:
            c.frame_step(False) if shift else c.step(-1)
        elif k == Qt.Key_Right:
            c.frame_step(True) if shift else c.step(1)
        elif k == Qt.Key_R:
            c.rotate_by(-90 if shift else 90)
        elif k in (Qt.Key_Return, Qt.Key_Enter):
            if c.lv.crop_editing:
                c.crop_apply()
        elif k == Qt.Key_Escape:
            if c.lv.crop_editing:
                c.crop_cancel()
            elif self.view.show_help:
                self.toggle_help()
            elif self.isFullScreen():
                self.showNormal()
        elif k in keys:
            keys[k]()
        else:
            super().keyPressEvent(e)

    # ------------------------------------------------------------ drop + close

    def dragEnterEvent(self, e):
        if e.mimeData().hasUrls():
            e.acceptProposedAction()

    def dropEvent(self, e):
        urls = [u.toLocalFile() for u in e.mimeData().urls() if u.isLocalFile()]
        if urls:
            self.c.open(urls[0])

    def closeEvent(self, e):
        self.save_geometry()
        self.c.jobs.cancel_group("file")
        self.c.save_settings()
        self.view.release()
        self.c.engine.shutdown()
        super().closeEvent(e)


def shortcut_text(seq: str) -> str:
    return QKeySequence(seq).toString(QKeySequence.NativeText)
