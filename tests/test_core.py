import json

import numpy as np
import pytest

from mediainspector.core import filters, layout, media, motion, ramp
from mediainspector.core.state import Settings, Store


# ---------------------------------------------------------------- media

def test_kind_from_tracks():
    v = {"type": "video", "selected": True}
    a = {"type": "audio", "selected": True}
    assert media.detect_kind([v, a]) == "video"
    assert media.detect_kind([{**v, "albumart": True}, a]) == "audio"
    assert media.detect_kind([{**v, "image": True}], frame_count=1) == "photo"
    assert media.detect_kind([{**v, "image": True}], frame_count=40) == "video"
    assert media.detect_kind([a]) == "audio"


def test_display_shape_rotation():
    assert media.display_shape(3840, 2160, 90) == (2160, 3840)
    assert media.display_shape(3840, 2160, 90, 90) == (3840, 2160)
    assert media.display_shape(1920, 1080, 0, 270) == (1080, 1920)


def test_tiers_and_conform():
    assert media.tier("video", 120) == "green"
    assert media.tier("video", 59.94) == "blue"
    assert media.tier("video", 29.97) == "yellow"
    assert media.tier("audio", 0) == "audio"
    # The old build compared the source with itself and never slowed anything.
    assert media.conform_speed(120) == pytest.approx(0.2)
    assert media.conform_speed(24) is None


def test_step_scope(tmp_path):
    for n in ("a.mp4", "B.mov", "c.jpg", "d.mp4", "notes.txt"):
        (tmp_path / n).write_bytes(b"x")
    p = lambda n: str(tmp_path / n)  # noqa: E731
    assert media.step(p("a.mp4"), 1, False).path == p("B.mov")
    assert media.step(p("d.mp4"), 1, False).path == p("a.mp4")          # wraps
    # From a photo while browsing video only: from where it sorts.
    assert media.step(p("c.jpg"), 1, False).path == p("d.mp4")
    assert media.step(p("c.jpg"), -1, False).path == p("B.mov")
    s = media.step(p("B.mov"), 1, True)
    assert s.path == p("c.jpg") and (s.index, s.count) == (3, 4)


# ---------------------------------------------------------------- ramp

PTS = [(0, 1), (1, 0.25), (2, 0.25), (3, 2)]


def test_ramp_curve():
    pts = ramp.normalise(PTS)
    assert ramp.evaluate(pts, 0.75) == pytest.approx(0.31046, abs=1e-5)
    assert ramp.evaluate(pts, 1.5) == pytest.approx(0.25)
    assert ramp.evaluate(pts, 2.5) == pytest.approx(0.70711, abs=1e-5)
    assert ramp.evaluate(pts, 9) == 2
    assert ramp.evaluate([], 1) == 1


def test_ramp_timeline_matches_spec_fixture():
    tl = ramp.timeline(PTS, 0.5, 3.5)
    assert tl.out_seconds == pytest.approx(7.638, abs=1 / 60)
    # Flat 0.25x for a second takes four.
    assert tl.source_time_at(0) == 0.5
    assert tl.source_time_at(tl.out_seconds) == pytest.approx(3.5)
    ts = [tl.source_time_at(k / 60) for k in range(int(tl.out_seconds * 60))]
    assert all(b >= a for a, b in zip(ts, ts[1:]))


def test_ramp_helpers():
    assert ramp.output_fps(120) == 60 and ramp.output_fps(30) == 30
    d = ramp.dip(3.0, 10, 120)
    assert [s for _, s in d] == [1.0, 0.2, 0.2, 1.0]
    assert ramp.default_range([(2, 1), (5, 1)], 5.5) == (1, 5.5)


# ---------------------------------------------------------------- filters

def test_filters_one_graph():
    g = filters.Graph(crop=filters.Crop(100, 80, 10, 4), look={"saturation": 40, "hue": 10},
                      trail="bright", trail_length=0)
    names = [n for n, _ in g.stages()]
    assert names == ["crop", "hue", "lagfun"]
    assert [n for n, _ in g.stages(live=False)] == ["crop", "hue"]
    vf = filters.mpv_vf(g.stages())
    assert vf.startswith("lavfi=[crop=100:80:10:4,hue=") and "lagfun=decay=0.9" in vf
    assert filters.mpv_vf([]) == ""
    assert [n for n, _ in filters.trail_stages("dark", 50)] == ["negate", "lagfun", "negate"]
    assert filters.scale_stage(100, "lanczos") is None
    assert "lanczos" in filters.scale_stage(200, "lanczos")[1]


# ---------------------------------------------------------------- layout

def test_layout():
    assert layout.fit_window(1920, 1080, 500, 120, 3840, 2100) == (2420, 1200)
    w, h = layout.fit_window(3840, 2160, 500, 120, 2560, 1400)
    assert w <= 2560 * 0.96 + 1 and h <= 1400 * 0.94 + 1
    assert layout.actual_size_zoom(3840, 1920, 0) == pytest.approx(1.0)
    assert layout.actual_size_zoom(3840, 3840, 1.0) == pytest.approx(1.0)
    assert layout.ratio_rect(1920, 1080, 1, 1) == (1080, 1080)
    assert layout.ratio_rect(1920, 1080, 9, 16) == (608, 1080)
    assert layout.auto_panel_width(1600, 900, 9 / 16) == 1600 - round(900 * 9 / 16)
    assert layout.clamp_panel(10, 1600) == layout.MIN_PANEL


# ---------------------------------------------------------------- state

def test_settings_round_trip_and_bad_types(tmp_path):
    p = str(tmp_path / "s.json")
    s = Settings(volume=40, look={"temp": 5})
    s.set_ramp("/a.mp4", [(1.23456, 0.5)])
    s.save(p)
    t = Settings.load(p)
    assert t.volume == 40 and t.look == {"temp": 5} and t.ramps == {"/a.mp4": [[1.235, 0.5]]}
    with open(p, "w") as f:
        json.dump({"volume": "loud", "mute": 1, "fit_window": False}, f)
    t = Settings.load(p)
    assert t.volume == 100 and t.mute is True and t.fit_window is False
    open(p, "w").write("{nonsense")
    assert Settings.load(p).volume == 100


def test_ramps_capped():
    s = Settings()
    for i in range(130):
        s.set_ramp(f"/{i}.mp4", [(1, 1)])
    assert len(s.ramps) == Settings.MAX_RAMPS and "/129.mp4" in s.ramps and "/0.mp4" not in s.ramps


def test_store_notifies_only_changes():
    st, seen = Store(), []
    st.subscribe(seen.append)
    st.update(pause=True, time_pos=1.0)
    st.update(pause=True)
    st.configure(volume=50)
    assert seen == [{"time_pos"}, {"settings.volume"}]


# ---------------------------------------------------------------- motion

def test_timeslice_composites_moving_subject():
    h, w = 60, 120
    bg = np.full((h, w, 3), 40, np.uint8)
    frames = []
    for i in range(12):
        f = bg.copy()
        x = 5 + i * 9
        f[20:40, x:x + 10] = 250
        frames.append(f)
    img, n = motion.timeslice(frames, copies=4, threshold=28, fade=False)
    assert n == 4
    # Background stays clean; the first and last positions both appear.
    assert img[5, 5].tolist() == [40, 40, 40]
    assert img[30, 9].min() > 200 and img[30, 5 + 11 * 9 + 4].min() > 200


def test_motion_peak():
    t = np.arange(100) / 30
    e = np.ones(100)
    e[60:64] = 20
    assert motion.peak_time(t, e) == pytest.approx(t[61], abs=2 / 30)


@pytest.mark.parametrize("rot", [0, 90, 180, 270])
def test_crop_mapping_round_trips(rot):
    rect = (100, 50, 700, 450)
    v = layout.view_from_src(*rect, 1920, 1080, rot)
    back = layout.src_from_view(*v, 1920, 1080, rot)
    assert back == pytest.approx(rect)
    assert v[0] < v[2] and v[1] < v[3]


def test_crop_mapping_rotate_90_puts_source_top_on_the_right():
    # A strip along the source's top edge shows down the right-hand side.
    u0, v0, u1, v1 = layout.view_from_src(0, 0, 1920, 100, 1920, 1080, 90)
    assert u1 == pytest.approx(1) and u0 > 0.9 and (v0, v1) == (0, 1)


def test_clamp_crop():
    assert layout.clamp_crop(-5, 2000, 99, 3, 1920, 1080) == (98, 16, 0, 1064)
