"""Download libmpv (the media engine) into vendor/.

    python build/fetch_libmpv.py                 # latest Windows x86_64 dev build
    python build/fetch_libmpv.py --archive F.7z  # use an archive you downloaded

Builds come from shinchiro/mpv-winbuild-cmake, the same builds winget's
"shinchiro.mpv" installs. The "dev" archive carries libmpv-2.dll.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import re
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VENDOR = os.path.join(ROOT, "vendor")
API = "https://api.github.com/repos/shinchiro/mpv-winbuild-cmake/releases/latest"
# Plain x86_64, not the -v3 build (which needs AVX2 and refuses older CPUs).
ASSET = re.compile(r"^mpv-dev-x86_64-\d{8}-git-[0-9a-f]+\.7z$")
MANUAL = ("Download 'mpv-dev-x86_64-<date>-git-<hash>.7z' from\n"
          "  https://github.com/shinchiro/mpv-winbuild-cmake/releases\n"
          "  (or https://sourceforge.net/projects/mpv-player-windows/files/libmpv/)\n"
          "then run:  python build/fetch_libmpv.py --archive <that file>")


def latest_asset() -> tuple[str, str]:
    req = urllib.request.Request(API, headers={"Accept": "application/vnd.github+json",
                                               "User-Agent": "mediainspector-setup"})
    with urllib.request.urlopen(req, timeout=30) as r:
        rel = json.load(r)
    for a in rel.get("assets", []):
        if ASSET.match(a["name"]):
            return a["name"], a["browser_download_url"]
    raise LookupError(f"no plain x86_64 dev archive in release {rel.get('tag_name')}")


def extract(data: bytes) -> str:
    try:
        import py7zr
    except ImportError:
        sys.exit("py7zr is needed to unpack the archive:  pip install py7zr")
    os.makedirs(VENDOR, exist_ok=True)
    with py7zr.SevenZipFile(io.BytesIO(data)) as z:
        names = [n for n in z.getnames() if n.lower().endswith("libmpv-2.dll")]
        if not names:
            sys.exit("The archive has no libmpv-2.dll - is it the 'dev' archive?")
        z.extract(path=VENDOR, targets=names)
    src = os.path.join(VENDOR, names[0])
    dst = os.path.join(VENDOR, "libmpv-2.dll")
    if os.path.abspath(src) != os.path.abspath(dst):
        os.replace(src, dst)
    return dst


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--archive", help="a dev .7z already downloaded")
    args = ap.parse_args(argv)
    dst = os.path.join(VENDOR, "libmpv-2.dll")
    if args.archive:
        with open(args.archive, "rb") as f:
            print("Unpacked", extract(f.read()))
        return 0
    if os.path.exists(dst):
        print("libmpv already in", dst)
        return 0
    try:
        name, url = latest_asset()
        print("Downloading", name)
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "mediainspector-setup"}),
                                    timeout=300) as r:
            data = r.read()
    except Exception as e:  # noqa: BLE001
        print(f"Could not download libmpv automatically ({e}).\n{MANUAL}")
        return 1
    print("Unpacked", extract(data))
    return 0


if __name__ == "__main__":
    sys.exit(main())
