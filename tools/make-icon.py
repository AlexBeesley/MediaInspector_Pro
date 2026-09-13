"""Draws app.ico, the icon both shells build with.

The mark is the app's own language: the dark card, the accent yellow, and the
crop brackets from the on-picture crop editor framing a play triangle - an
inspector's framing marks around a player's transport.

Everything is drawn four times oversized and resampled down, which is what
keeps the diagonals of the triangle clean at 32px and below. Sizes below 48px
drop the brackets: they turn to mush, and a bigger triangle on a tile that runs
closer to the edges is what actually reads in a taskbar.

    python tools\\make-icon.py            # writes app.ico beside Build.ps1

Rebuild the exes afterwards - the icon is baked in at build time:
    .\\Build.ps1                          # MediaInspector_Pro.exe
    cd app && npm run build              # MediaInspector2.exe
"""

import os
from PIL import Image, ImageDraw

SIZES = [256, 128, 64, 48, 32, 24, 16]
SS = 4  # supersampling factor

TILE = (18, 18, 26, 255)        # --bg   from the panel's palette
BORDER = (46, 46, 56, 255)      # --border
ACCENT = (255, 208, 0, 255)     # --accent, the yellow tier colour


def draw_icon(size):
    s = size * SS
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # The tile. Windows already rounds and shadows large icons, so this stays a
    # simple rounded square rather than trying to imitate a system shape.
    pad = s * (0.03 if size >= 48 else 0.015)
    d.rounded_rectangle([pad, pad, s - pad, s - pad], radius=s * 0.22, fill=TILE,
                        outline=BORDER, width=max(1, int(s * 0.012)))

    detailed = size >= 48
    if detailed:
        # Crop brackets: two strokes per corner, the same shape the crop editor
        # puts on the picture.
        inset = s * 0.20
        arm = s * 0.17
        w = s * 0.055
        for cx, cy, dx, dy in ((inset, inset, 1, 1), (s - inset, inset, -1, 1),
                               (inset, s - inset, 1, -1), (s - inset, s - inset, -1, -1)):
            d.rounded_rectangle(sorted_box(cx, cy, cx + dx * arm, cy + dy * w), radius=w / 2, fill=ACCENT)
            d.rounded_rectangle(sorted_box(cx, cy, cx + dx * w, cy + dy * arm), radius=w / 2, fill=ACCENT)

    # Play triangle, optically centred: a triangle balanced on its bounding box
    # looks left-heavy, so it is nudged right by a fraction of its width.
    tw = s * (0.26 if detailed else 0.46)
    th = tw * 1.12
    cx, cy = s / 2 + tw * 0.10, s / 2
    d.polygon([(cx - tw / 2, cy - th / 2), (cx - tw / 2, cy + th / 2), (cx + tw / 2, cy)],
              fill=ACCENT)

    return img.resize((size, size), Image.LANCZOS)


def sorted_box(x0, y0, x1, y1):
    return [min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)]


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    frames = [draw_icon(n) for n in SIZES]
    out = os.path.join(root, "app.ico")
    # Pillow writes every frame it is given into the one .ico.
    frames[0].save(out, format="ICO", sizes=[(n, n) for n in SIZES],
                   append_images=frames[1:])
    print("wrote", out, os.path.getsize(out), "bytes,", len(SIZES), "sizes")

    # A flat preview, for looking at the thing without an icon viewer.
    strip_w = sum(f.width for f in frames) + 12 * len(frames)
    strip = Image.new("RGBA", (strip_w, 272), (10, 10, 14, 255))
    x = 6
    for f in frames:
        strip.paste(f, (x, (272 - f.height) // 2), f)
        x += f.width + 12
    preview = os.path.join(root, "tools", "icon-preview.png")
    strip.save(preview)
    print("wrote", preview)


if __name__ == "__main__":
    main()
