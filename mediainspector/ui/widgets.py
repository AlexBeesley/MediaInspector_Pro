"""Small building blocks the panel is made of.

Two rules run through them: a control shows its own state (segments light
the live value, toggles reflect the store), and a control that does not apply
to the open kind is disabled rather than hidden, so nothing reshuffles under
the cursor.
"""

from __future__ import annotations

from typing import Callable, Iterable

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (QCheckBox, QFrame, QHBoxLayout, QLabel, QLineEdit, QPushButton, QSizePolicy,
                               QSlider, QVBoxLayout, QWidget)

# Widgets that apply to some kinds only; the window enables them per kind.
_KIND_GATED: list[tuple[QWidget, tuple[str, ...]]] = []


def gate(w: QWidget, kinds: Iterable[str] | None) -> QWidget:
    if kinds:
        _KIND_GATED.append((w, tuple(kinds)))
    return w


def apply_kind(kind: str):
    for w, kinds in list(_KIND_GATED):
        try:
            w.setEnabled(kind in kinds)
        except RuntimeError:          # widget deleted
            _KIND_GATED.remove((w, kinds))


def repolish(w: QWidget):
    w.style().unpolish(w)
    w.style().polish(w)


def set_on(w: QWidget, on: bool):
    """Light a button as engaged without making it checkable."""
    v = "true" if on else "false"
    if w.property("on") != v:
        w.setProperty("on", v)
        repolish(w)


def btn(text: str, slot: Callable | None = None, tip: str = "", kinds=None, key=False,
        checkable=False, grow=True) -> QPushButton:
    b = QPushButton(text)
    b.setCursor(Qt.PointingHandCursor)
    b.setFocusPolicy(Qt.NoFocus)
    if tip:
        b.setToolTip(tip)
    if key:
        b.setProperty("key", "true")
    if checkable:
        b.setCheckable(True)
    if slot:
        b.clicked.connect(lambda *_: slot())
    b.setSizePolicy(QSizePolicy.Expanding if grow else QSizePolicy.Fixed, QSizePolicy.Fixed)
    return gate(b, kinds)


def label(text: str, role: str = "label", width: int | None = None) -> QLabel:
    lb = QLabel(text)
    lb.setProperty("role", role)
    if width:
        lb.setFixedWidth(width)
    return lb


def hint(text: str) -> QLabel:
    lb = label(text, "hint")
    lb.setWordWrap(True)
    return lb


def section(text: str) -> QLabel:
    return label(text.upper(), "section")


def row(*widgets, spacing: int = 4) -> QWidget:
    w = QWidget()
    lay = QHBoxLayout(w)
    lay.setContentsMargins(0, 0, 0, 0)
    lay.setSpacing(spacing)
    for x in widgets:
        if x is None:
            lay.addStretch(1)
        else:
            lay.addWidget(x)
    return w


class Toggle(QCheckBox):
    def __init__(self, text: str = "", checked: bool = False, on_change: Callable | None = None, kinds=None):
        super().__init__(text)
        self.setChecked(checked)
        self.setCursor(Qt.PointingHandCursor)
        self.setFocusPolicy(Qt.NoFocus)
        if on_change:
            self.toggled.connect(on_change)
        gate(self, kinds)

    def set_quiet(self, on: bool):
        """Reflect state without firing the handler."""
        if self.isChecked() != on:
            self.blockSignals(True)
            self.setChecked(on)
            self.blockSignals(False)


class Segmented(QFrame):
    """One choice out of a few, with the live one lit."""
    picked = Signal(object)

    def __init__(self, items: list[tuple[str, object]], on_pick: Callable | None = None, kinds=None,
                 tips: dict | None = None):
        super().__init__()
        self.setObjectName("seg")
        lay = QHBoxLayout(self)
        lay.setContentsMargins(2, 2, 2, 2)
        lay.setSpacing(2)
        self.buttons: dict = {}
        for text, value in items:
            b = QPushButton(text)
            b.setProperty("seg", "true")
            b.setCheckable(True)
            b.setFocusPolicy(Qt.NoFocus)
            b.setCursor(Qt.PointingHandCursor)
            if tips and value in tips:
                b.setToolTip(tips[value])
            b.clicked.connect(lambda _=False, v=value: self.picked.emit(v))
            lay.addWidget(b)
            self.buttons[value] = gate(b, kinds)
        if on_pick:
            self.picked.connect(on_pick)

    def set(self, value):
        for v, b in self.buttons.items():
            b.setChecked(v == value)


class SliderRow(QWidget):
    """Label, slider and a typeable value. Double-click the slider to zero it."""
    changed = Signal(int)
    committed = Signal(int)

    def __init__(self, name: str, lo: int, hi: int, value: int = 0, label_width: int = 76, kinds=None):
        super().__init__()
        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(7)
        self.name = label(name, width=label_width)
        self.slider = QSlider(Qt.Horizontal)
        self.slider.setRange(lo, hi)
        self.slider.setValue(int(value))
        self.slider.setFocusPolicy(Qt.NoFocus)
        self.num = QLineEdit(str(int(value)))
        self.num.setFixedWidth(44)
        self.num.setAlignment(Qt.AlignRight | Qt.AlignVCenter)
        lay.addWidget(self.name)
        lay.addWidget(self.slider, 1)
        lay.addWidget(self.num)
        self.slider.valueChanged.connect(self._moved)
        self.slider.sliderReleased.connect(lambda: self.committed.emit(self.slider.value()))
        self.num.editingFinished.connect(self._typed)
        self.slider.mouseDoubleClickEvent = lambda e: self.set_value(0, emit=True)
        gate(self, kinds)

    def _moved(self, v: int):
        self.num.setText(str(v))
        self.name.setStyleSheet("color: #d8d8de;" if v else "")
        self.changed.emit(v)

    def _typed(self):
        try:
            v = int(round(float(self.num.text())))
        except ValueError:
            v = self.slider.value()
        self.set_value(v, emit=True)
        self.committed.emit(self.slider.value())

    def set_value(self, v: int, emit: bool = False):
        if not emit:
            self.slider.blockSignals(True)
        self.slider.setValue(int(v))
        self.num.setText(str(self.slider.value()))
        self.name.setStyleSheet("color: #d8d8de;" if self.slider.value() else "")
        self.slider.blockSignals(False)

    def value(self) -> int:
        return self.slider.value()


class Card(QFrame):
    """A titled group that folds and remembers it. A folded card still says
    on its header what is engaged inside."""
    toggled = Signal(str, bool)

    def __init__(self, title: str, key: str, open_: bool = True):
        super().__init__()
        self.setObjectName("card")
        self.key = key
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSpacing(0)
        self.head = QPushButton()
        self.head.setObjectName("cardHead")
        self.head.setCursor(Qt.PointingHandCursor)
        self.head.setFocusPolicy(Qt.NoFocus)
        hl = QHBoxLayout(self.head)
        hl.setContentsMargins(9, 0, 9, 0)
        self.caret = QLabel()
        self.caret.setStyleSheet("color: #7b7b87;")
        self.title = QLabel(title.upper())
        self.title.setStyleSheet("color: inherit; font-weight: 600; letter-spacing: 1px; font-size: 10.5px;")
        self.badge = QLabel()
        self.badge.setObjectName("cardBadge")
        for w in (self.caret, self.title, self.badge):
            w.setAttribute(Qt.WA_TransparentForMouseEvents)
        hl.addWidget(self.caret)
        hl.addWidget(self.title)
        hl.addStretch(1)
        hl.addWidget(self.badge)
        outer.addWidget(self.head)
        self.body = QWidget()
        self.lay = QVBoxLayout(self.body)
        self.lay.setContentsMargins(9, 8, 9, 9)
        self.lay.setSpacing(4)
        outer.addWidget(self.body)
        self.head.clicked.connect(self._flip)
        self.set_open(open_)

    def add(self, *widgets):
        for w in widgets:
            self.lay.addWidget(w)
        return self

    def _flip(self):
        self.set_open(not self.body.isVisible())
        self.toggled.emit(self.key, self.body.isVisible())

    def set_open(self, on: bool):
        self.body.setVisible(on)
        self.caret.setText("▾" if on else "▸")

    def set_badge(self, text: str):
        if self.badge.text() != text:
            self.badge.setText(text)
