"""The look: one dark palette, one accent.

The accent is a signal, not decoration. It marks what is on, what is selected
and where the playhead is, and it is recoloured per media kind (and per frame
rate for video), so a glance says what is open and what is engaged.
"""

from __future__ import annotations

from PySide6.QtGui import QColor

BG = "#0d0d11"
PANEL = "#101015"
CARD = "#16161c"
CARD_HEAD = "#191920"
CTL = "#21212a"
CTL_HI = "#2b2b36"
CTL_LO = "#1a1a21"
INPUT = "#0b0b0e"
BORDER = "#26262f"
BORDER_HI = "#383843"
TEXT = "#d8d8de"
DIM = "#7b7b87"
FAINT = "#52525c"
INK = "#101014"          # text on the accent
DANGER = "#e05260"
HDR = "#d25aff"
GOOD = "#40d078"
WARN = "#ff9838"
INFO = "#3898ff"

MONO = '"Cascadia Mono", "Consolas", "DejaVu Sans Mono", monospace'


def qc(hex_: str, alpha: float = 1.0) -> QColor:
    c = QColor(hex_)
    c.setAlphaF(alpha)
    return c


def stylesheet(accent: str, scale: float = 1.0) -> str:
    def px(n):
        return f"{max(1, round(n * scale))}px"

    return f"""
* {{ font-size: {px(12)}; color: {TEXT}; }}
QMainWindow, QWidget#root {{ background: {BG}; }}
QToolTip {{ background: #1c1c24; color: {TEXT}; border: 1px solid {BORDER_HI}; padding: 4px 6px; }}

#header {{ background: qlineargradient(y1:0, y2:1, stop:0 #15151b, stop:1 #101016); border-bottom: 2px solid {accent}; }}
#kindBadge {{ background: {accent}; color: {INK}; font-weight: 700; font-size: {px(9.5)};
              border-radius: 3px; padding: 2px 6px; }}
#title {{ font-size: {px(12.5)}; }}
QLabel[chip="true"] {{ color: {DIM}; background: #1a1a21; border: 1px solid #23232c; border-radius: 3px;
                       padding: 0 5px; font-size: {px(10.5)}; }}
QLabel[chip="lit"] {{ color: {accent}; background: #1a1a21; border: 1px solid {accent}; border-radius: 3px;
                      padding: 0 5px; font-size: {px(10.5)}; }}

#panel {{ background: {PANEL}; }}
QScrollArea {{ border: 0; background: {PANEL}; }}
QScrollBar:vertical {{ background: transparent; width: 9px; }}
QScrollBar::handle:vertical {{ background: #26262f; border-radius: 4px; min-height: 30px; }}
QScrollBar::add-line, QScrollBar::sub-line {{ height: 0; }}
QSplitter::handle {{ background: #000; border-left: 1px solid {BORDER}; border-right: 1px solid {BORDER}; }}
QSplitter::handle:hover {{ background: {accent}; }}

#card {{ background: {CARD}; border: 1px solid {BORDER}; border-radius: 5px; }}
#cardHead {{ background: {CARD_HEAD}; border: 0; border-bottom: 1px solid {BORDER}; border-top-left-radius: 5px;
             border-top-right-radius: 5px; text-align: left; padding: 0 9px; color: {DIM};
             font-size: {px(10.5)}; font-weight: 600; letter-spacing: 1px; min-height: {px(26)}; }}
#cardHead:hover {{ color: {TEXT}; background: #1d1d25; }}
#cardBadge {{ color: {accent}; font-size: {px(9.5)}; }}

QPushButton {{ background: qlineargradient(y1:0, y2:1, stop:0 {CTL}, stop:1 {CTL_LO}); border: 1px solid {BORDER_HI};
               border-radius: 4px; padding: 0 9px; min-height: {px(24)}; font-size: {px(11.5)}; }}
QPushButton:hover {{ background: {CTL_HI}; border-color: #4a4a58; }}
QPushButton:pressed {{ background: {CTL_LO}; }}
QPushButton:disabled {{ color: {FAINT}; background: #15151b; border-color: #202028; }}
QPushButton[key="true"] {{ background: qlineargradient(y1:0, y2:1, stop:0 #33333f, stop:1 #292933); border-color: #4d4d5c; }}
QPushButton[key="true"]:hover {{ background: #3b3b48; }}
/* Engaged comes after key: a primary action that is on must read as on. */
QPushButton:checked, QPushButton[on="true"] {{ background: {accent}; color: {INK}; border-color: {accent}; font-weight: 600; }}
QPushButton[seg="true"] {{ background: transparent; border: 0; color: {DIM}; min-height: {px(20)}; border-radius: 3px; }}
QPushButton[seg="true"]:hover {{ background: {CTL}; color: {TEXT}; }}
QPushButton[seg="true"]:checked {{ background: {CTL_HI}; color: {accent}; border: 1px solid {BORDER_HI}; }}
QPushButton[seg="true"]:disabled {{ color: #3d3d46; }}
#seg {{ background: {INPUT}; border: 1px solid {BORDER}; border-radius: 5px; }}

QLineEdit, QComboBox, QSpinBox, QDoubleSpinBox {{ background: {INPUT}; border: 1px solid {BORDER}; border-radius: 4px;
              padding: 0 6px; min-height: {px(24)}; selection-background-color: {accent}; selection-color: {INK}; }}
QLineEdit {{ font-family: {MONO}; font-size: {px(11)}; }}
QLineEdit:focus, QComboBox:focus {{ border-color: {accent}; }}
QComboBox QAbstractItemView {{ background: #1c1c24; border: 1px solid {BORDER_HI}; selection-background-color: {CTL_HI}; }}

QSlider::groove:horizontal {{ height: 4px; background: #24242c; border-radius: 2px; }}
QSlider::sub-page:horizontal {{ background: {accent}; border-radius: 2px; }}
QSlider::handle:horizontal {{ background: #fff; border: 2px solid {accent}; width: 10px; height: 10px;
                              margin: -5px 0; border-radius: 7px; }}
QSlider::handle:horizontal:disabled {{ border-color: {FAINT}; }}

QCheckBox {{ spacing: 7px; color: {DIM}; }}
QCheckBox:checked {{ color: {TEXT}; }}
QCheckBox::indicator {{ width: {px(30)}; height: {px(16)}; border-radius: 8px; background: #24242c; border: 1px solid #43434f; }}
QCheckBox::indicator:checked {{ background: {accent}; border-color: {accent}; }}
QCheckBox[list="true"]::indicator {{ width: {px(12)}; height: {px(12)}; border-radius: 3px; }}

QLabel[role="hint"] {{ color: {FAINT}; font-size: {px(10.5)}; }}
QLabel[role="label"] {{ color: {DIM}; font-size: {px(11)}; }}
QLabel[role="section"] {{ color: {FAINT}; font-size: {px(9.5)}; letter-spacing: 1px; }}
QLabel[role="mono"] {{ font-family: {MONO}; }}

#transport {{ background: {CARD}; border-top: 1px solid {BORDER}; }}
#timecode {{ font-family: {MONO}; font-size: {px(15)}; font-weight: 600; }}
#duration {{ font-family: {MONO}; color: {DIM}; }}
#speedRead {{ font-family: {MONO}; color: {accent}; }}

#toast {{ background: #1c1c24; border: 1px solid {BORDER_HI}; border-radius: 5px; padding: 7px 13px; }}
#verdict {{ background: {INPUT}; border: 1px solid {BORDER}; border-radius: 4px; }}
"""
