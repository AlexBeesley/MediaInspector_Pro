"""The decode-side jobs against generated media: the X-ray fixture set from
the spec, and real exports through FFmpeg."""

import av
import numpy as np
import pytest

from mediainspector.engine import exports

NEVER = lambda: False  # noqa: E731


@pytest.mark.parametrize("name, level, cutoff", [
    ("genuine.flac", "genuine", None),
    ("hires_real.flac", "genuine", None),
    ("fake128.flac", "suspect", (15500, 17500)),
    ("fake192.flac", "suspect", (17500, 19500)),
    ("lossy128.mp3", "lossy", (15500, 17500)),
    ("lossy320.mp3", "lossy", (19000, 20600)),
    ("hires_up.flac", "suspect", None),
    ("rolloff.flac", "genuine", None),
    ("silent.flac", "unknown", None),
])
def test_xray_verdicts(media, name, level, cutoff):
    r = exports.xray_job(media(name), NEVER)["result"]
    assert r.verdict.level == level, (name, r.verdict, r.cutoff_hz, r.band_hz)
    if cutoff:
        assert cutoff[0] <= r.cutoff_hz <= cutoff[1]
    if name == "hires_up.flac":
        assert "upsampled" in r.verdict.detail


def test_xray_cancel(media):
    with pytest.raises(exports.Stop):
        exports.xray_job(media("genuine.flac"), lambda: True)


def _probe(path):
    with av.open(path) as c:
        v = c.streams.video[0]
        n = sum(1 for _ in c.decode(v))
        return n, v.codec_context.width, v.codec_context.height, float(v.average_rate)


def test_trim_applies_crop_look_and_rotation(media, tmp_path):
    spec = exports.ClipSpec(media("ball120.mp4"), str(tmp_path / "t.mp4"), 0.5, 1.5,
                            [("crop", "320:200:10:10"), ("hue", "s=0")], rotate=90)
    exports.trim(spec, NEVER)
    n, w, h, fps = _probe(spec.out)
    assert (w, h) == (200, 320)               # rotated a quarter turn after the crop
    assert 115 <= n <= 122 and fps == 120
    with av.open(spec.out) as c:
        f = next(c.decode(video=0)).to_ndarray(format="rgb24").astype(int)
    assert np.abs(f[..., 0] - f[..., 1]).mean() < 6  # desaturated


def test_ramp_export_duration(media, tmp_path):
    pts = [(0, 1), (1, 0.25), (2, 0.25), (3, 2)]
    spec = exports.ClipSpec(media("ball120.mp4"), str(tmp_path / "r.mp4"), 0.5, 2.9, [])
    out, seconds = exports.ramp_export(spec, pts, 120, NEVER)
    n, w, h, fps = _probe(out)
    assert fps == 60
    assert abs(n / 60 - seconds) <= 1 / 60 + 1e-9


def test_motion_profile_finds_the_burst(media):
    r = exports.motion_profile(media("ball120.mp4"), 0, 3, [], 0, 120, NEVER)
    assert r["peak"] == pytest.approx(2.0, abs=0.2)


def test_timeslice_file(media, tmp_path):
    r = exports.timeslice(media("ball120.mp4"), str(tmp_path), 0.1, 2.9, [], 0, 120, 6, 28, False, NEVER)
    assert r["copies"] == 6 and (r["w"], r["h"]) == (640, 360)
    from PIL import Image
    img = np.asarray(Image.open(r["path"]))
    # Every copy solid (no fade), side by side along the ball's path.
    row = img[int(360 * 0.6)]
    bright_runs = np.diff((row.min(axis=1) > 200).astype(int)).clip(0).sum()
    assert bright_runs >= 5
    assert img[20, 20].max() < 200   # background plate, no ghost


def test_unique_path(tmp_path):
    a = exports.unique_path(str(tmp_path), "x", "png")
    open(a, "w").close()
    assert exports.unique_path(str(tmp_path), "x", "png").endswith("x_2.png")
