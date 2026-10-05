"""The whole app, driven end to end: real window, real engine, real jobs.

Needs a display with OpenGL (any desktop; on a headless Linux box run under
xvfb-run). Skipped otherwise.
"""

import os
import shutil
import sys
import time

import pytest

pytestmark = pytest.mark.skipif(
    sys.platform.startswith("linux") and not os.environ.get("DISPLAY"),
    reason="needs a display with OpenGL (use xvfb-run)")


@pytest.fixture(scope="module")
def app(media, tmp_path_factory):
    os.environ["QT_QPA_PLATFORM"] = "xcb" if sys.platform.startswith("linux") else os.environ.get("QT_QPA_PLATFORM", "")
    if not os.environ["QT_QPA_PLATFORM"]:
        del os.environ["QT_QPA_PLATFORM"]
    cfg = tmp_path_factory.mktemp("cfg")
    os.environ["MI_CONFIG_DIR"] = str(cfg)
    from mediainspector import app as A
    A._find_libmpv()
    from PySide6.QtCore import QCoreApplication, Qt
    from PySide6.QtWidgets import QApplication
    QCoreApplication.setAttribute(Qt.AA_UseDesktopOpenGL)
    qa = QApplication.instance() or QApplication([])
    from mediainspector.controller import Controller
    from mediainspector.core.state import Settings, Store
    from mediainspector.engine.player import Engine
    from mediainspector.ui.main_window import MainWindow
    store = Store(Settings(export_dir=str(tmp_path_factory.mktemp("exports")), mute=True))
    engine = Engine(store)
    c = Controller(store, engine, str(cfg / "settings.json"))
    w = MainWindow(c)
    w.resize(1500, 900)
    w.show()
    folder = tmp_path_factory.mktemp("folder")
    for n in ("ball120.mp4", "fake128.flac", "genuine.flac"):
        shutil.copy(media(n), folder / n)
    yield qa, c, w, folder
    w.close()


def pump(qa, sec=0.2):
    end = time.time() + sec
    while time.time() < end:
        qa.processEvents()
        time.sleep(0.005)


def until(qa, cond, timeout=10.0):
    end = time.time() + timeout
    while time.time() < end:
        qa.processEvents()
        if cond():
            return True
        time.sleep(0.01)
    return False


def open_file(qa, c, path):
    seq = c.lv.loaded_seq
    c.open(str(path))
    assert until(qa, lambda: c.lv.loaded_seq > seq), "file never loaded"
    pump(qa, 0.3)


def test_video_loads_and_reports(app):
    qa, c, w, folder = app
    open_file(qa, c, folder / "ball120.mp4")
    assert c.lv.kind == "video" and (c.lv.width, c.lv.height) == (640, 360)
    assert c.lv.fps == pytest.approx(120)
    assert "ball120.mp4" in w.windowTitle()
    assert w.transport.shuttle.isVisible()


def test_seek_and_frame_step(app):
    qa, c, w, folder = app
    c.engine.set("pause", True)
    c.seek(1.0)
    assert until(qa, lambda: abs(c.lv.time_pos - 1.0) < 0.01)
    c.frame_step(True)
    assert until(qa, lambda: abs(c.lv.time_pos - (1.0 + 1 / 120)) < 0.004)


def test_slowmo_conforms_to_24(app):
    qa, c, w, folder = app
    c.slowmo_toggle()
    assert until(qa, lambda: abs(c.lv.speed - 0.2) < 1e-6)
    c.slowmo_toggle()
    assert until(qa, lambda: c.lv.speed == 1.0)


def test_trail_and_look_reach_the_engine(app):
    qa, c, w, folder = app
    c.set_trail("bright")
    c.set_look("saturation", 40)
    c.apply_graph()
    vf = str(c.engine.get("vf"))
    assert "lagfun" in vf and "hue=h=0:s=1.4" in vf
    from PySide6.QtCore import Qt
    from PySide6.QtTest import QTest
    QTest.keyClick(w, Qt.Key_T)          # bright -> dark
    assert c.lv.trail == "dark"
    c.set_trail("off")
    c.reset_look()
    assert "lagfun" not in str(c.engine.get("vf"))


def test_crop_ratio_and_editor_drag(app):
    qa, c, w, folder = app
    c.crop_ratio("1:1")
    assert c.lv.crop and (c.lv.crop.w, c.lv.crop.h) == (360, 360)
    assert c.display_size() == (360, 360)
    c.crop_clear()
    c.crop_start()
    pump(qa, 0.3)
    box = w.view._box_view()
    assert box is not None
    from PySide6.QtCore import QPoint, Qt
    from PySide6.QtTest import QTest
    start = QPoint(int(box.right()), int(box.bottom()))
    QTest.mousePress(w.view, Qt.LeftButton, Qt.NoModifier, start)
    QTest.mouseMove(w.view, start - QPoint(int(box.width() / 2), int(box.height() / 2)))
    QTest.mouseRelease(w.view, Qt.LeftButton, Qt.NoModifier, start - QPoint(int(box.width() / 2), int(box.height() / 2)))
    b = c.lv.crop_box
    assert 280 <= b.w <= 360 and 160 <= b.h <= 200 and (b.x, b.y) == (0, 0)
    c.crop_apply()
    assert c.lv.crop is not None and not c.lv.crop_editing
    c.crop_clear()


def test_ramp_follows_and_hand_override(app):
    qa, c, w, folder = app
    c.set_ramp_points([(0, 1), (1, 0.25), (3, 0.25)])
    c.seek(2.0)
    c.engine.set("pause", False)
    c.set_ramp_on(True)
    assert until(qa, lambda: abs(c.lv.speed - 0.25) < 0.01)
    c.set_speed(2.0)
    assert until(qa, lambda: not c.lv.ramp_on)
    assert c.lv.speed == 2.0
    c.engine.set("pause", True)


def test_snap_to_action(app):
    qa, c, w, folder = app
    c.set_ramp_points([])
    c.ramp_snap()
    assert until(qa, lambda: bool(c.ramp_points), 20)
    centre = (c.ramp_points[1][0] + c.ramp_points[2][0]) / 2
    assert centre == pytest.approx(2.0, abs=0.25)


def test_exports(app):
    qa, c, w, folder = app
    out = c.export_dir()
    c.crop_rect(320, 200, 0, 0)
    c.engine.set("pause", True)
    c.seek(1.0)
    pump(qa, 0.4)
    before = set(os.listdir(out)) if os.path.isdir(out) else set()
    c.export_frame()
    c.set_trim(0.5, 1.0)
    c.export_trim()
    c.timeslice()
    c.ramp_export()
    assert until(qa, lambda: len(set(os.listdir(out)) - before) >= 4, 60), os.listdir(out)
    assert until(qa, lambda: not any(c.jobs.running(n) for n in list(c.jobs._tokens)), 60)
    new = sorted(set(os.listdir(out)) - before)
    from PIL import Image
    frame = next(n for n in new if "_frame" in n)
    assert Image.open(os.path.join(out, frame)).size == (320, 200)
    assert any("_trim_" in n for n in new) and any("_timeslice_" in n for n in new) and any("_ramp_" in n for n in new)
    c.crop_clear()
    c.set_trim(0.0, None)


def test_audio_xray_and_spectrogram(app):
    qa, c, w, folder = app
    open_file(qa, c, folder / "fake128.flac")
    assert c.lv.kind == "audio"
    assert until(qa, lambda: c.xray["state"] == "done", 20)
    assert c.xray["result"].verdict.level == "suspect"
    assert 15500 < c.lv.xray_cutoff < 17500
    c.set_spectrogram(True)
    assert until(qa, lambda: c.lv.spec_live and c.engine.get("width") == 1280)
    c.set_spectrogram(False)
    assert until(qa, lambda: c.engine.get("current-tracks/audio/id") == 1)


def test_browse_steps_through_folder(app):
    qa, c, w, folder = app
    c.set_browse_all(True)
    seq = c.lv.loaded_seq
    c.step(1)                              # fake128.flac -> genuine.flac
    assert until(qa, lambda: c.lv.loaded_seq > seq)
    assert c.lv.filename == "genuine.flac"
    assert until(qa, lambda: c.xray["state"] == "done", 20)
    assert c.xray["result"].verdict.level == "genuine"


def test_photo_and_actual_pixels(app, tmp_path):
    qa, c, w, folder = app
    from PIL import Image
    p = tmp_path / "still.png"
    Image.new("RGB", (3000, 2000), (40, 80, 120)).save(p)
    open_file(qa, c, p)
    assert c.lv.kind == "photo"
    c.zoom_actual()
    pump(qa, 0.4)
    x0, y0, x1, y1 = c.lv.out_rect
    assert abs((x1 - x0) - 3000) <= 2           # one source pixel per device pixel
    c.zoom_fit()


def test_screenshot_for_review(app, tmp_path_factory):
    qa, c, w, folder = app
    open_file(qa, c, folder / "ball120.mp4")
    c.set_ramp_points([(1, 1), (1.8, 0.2), (2.2, 0.2), (3, 1)])
    for card in w.panel.flow.cards:
        card.set_open(card.key in ("playback", "ramp", "motion", "xray"))
    w.panel.flow.reflow()
    c.seek(2.0)
    pump(qa, 2.5)
    path = os.environ.get("MI_SHOT", str(tmp_path_factory.mktemp("shot") / "app.png"))
    # The screen's pixels, not QWidget.grab(): grab() re-renders the GL view
    # off-screen and can composite it wrongly; this is what the eye sees.
    w.screen().grabWindow(w.winId()).save(path)
    assert os.path.getsize(path) > 10000
