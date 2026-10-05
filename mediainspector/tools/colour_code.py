"""Prefix video file names with a coloured dot for their frame-rate tier, so a
folder in Explorer shows at a glance which clips are worth slowing down.
The tiers are the app's own accent tiers.

    python -m mediainspector.tools.colour_code FOLDER [--dry-run] [--undo]

    🟡 30 fps and below   🔵 around 60 fps   🟢 above 60 fps
"""

from __future__ import annotations

import argparse
import os
import sys

import av

from ..core import media

DOTS = {"yellow": "🟡", "blue": "🔵", "green": "🟢"}


def frame_rate(path: str) -> float | None:
    try:
        with av.open(path) as c:
            if not c.streams.video:
                return None
            r = c.streams.video[0].average_rate or c.streams.video[0].guessed_rate
            return float(r) if r else None
    except av.FFmpegError:
        return None


def strip(name: str) -> str:
    for d in DOTS.values():
        if name.startswith(d + " "):
            return name[len(d) + 1:]
        if name.startswith(d):
            return name[len(d):]
    return name


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="colour_code")
    ap.add_argument("folder")
    ap.add_argument("--dry-run", action="store_true", help="say what would change, change nothing")
    ap.add_argument("--undo", action="store_true", help="take the dots back off")
    args = ap.parse_args(argv)
    done = skipped = 0
    for name in sorted(os.listdir(args.folder), key=str.lower):
        src = os.path.join(args.folder, name)
        if not os.path.isfile(src) or media.ext_of(name) not in media.VIDEO:
            continue
        base = strip(name)
        if args.undo:
            new = base
        else:
            fps = frame_rate(src)
            if not fps:
                print(f"skip  {name}  (no frame rate)")
                skipped += 1
                continue
            new = f"{DOTS[media.tier('video', fps)]} {base}"
        if new == name:
            continue
        print(f"{'would rename' if args.dry_run else 'rename'}  {name}  ->  {new}")
        if not args.dry_run:
            os.rename(src, os.path.join(args.folder, new))
        done += 1
    print(f"{done} renamed, {skipped} skipped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
