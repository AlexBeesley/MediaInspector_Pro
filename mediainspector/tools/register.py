"""Add (or remove) "Open with MediaInspector" for every supported file type,
for the current user only - nothing needs admin rights.

    python -m mediainspector.tools.register            # register
    python -m mediainspector.tools.register --remove   # take it all out

It writes the path of the running exe (or the source launcher), so run it
again after moving the app.
"""

from __future__ import annotations

import argparse
import os
import sys

from ..core import media

PROGIDS = {"video": "MediaInspector.Video", "photo": "MediaInspector.Photo", "audio": "MediaInspector.Audio"}
APP = "MediaInspector.exe"
VERB = "MediaInspector"
CLASSES = r"Software\Classes"


def _exts():
    return {"video": sorted(media.VIDEO), "photo": sorted(media.PHOTO | media.RAW), "audio": sorted(media.AUDIO)}


def command() -> str:
    if getattr(sys, "frozen", False):
        return f'"{sys.executable}" "%1"'
    pyw = os.path.join(os.path.dirname(sys.executable), "pythonw.exe")
    exe = pyw if os.path.exists(pyw) else sys.executable
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    return f'"{exe}" "{os.path.join(root, "run.pyw")}" "%1"'


def _delete_tree(winreg, root, path):
    try:
        with winreg.OpenKey(root, path, 0, winreg.KEY_ALL_ACCESS) as k:
            while True:
                try:
                    sub = winreg.EnumKey(k, 0)
                except OSError:
                    break
                _delete_tree(winreg, root, path + "\\" + sub)
        winreg.DeleteKey(root, path)
    except FileNotFoundError:
        pass


def remove(winreg):
    hk = winreg.HKEY_CURRENT_USER
    for kind, exts in _exts().items():
        _delete_tree(winreg, hk, f"{CLASSES}\\{PROGIDS[kind]}")
        for e in exts:
            _delete_tree(winreg, hk, f"{CLASSES}\\SystemFileAssociations\\.{e}\\shell\\{VERB}")
            try:
                with winreg.OpenKey(hk, f"{CLASSES}\\.{e}\\OpenWithProgids", 0, winreg.KEY_ALL_ACCESS) as k:
                    winreg.DeleteValue(k, PROGIDS[kind])
            except FileNotFoundError:
                pass
    _delete_tree(winreg, hk, f"{CLASSES}\\Applications\\{APP}")


def register(winreg):
    hk = winreg.HKEY_CURRENT_USER
    cmd = command()
    icon = sys.executable + ",0" if getattr(sys, "frozen", False) else ""

    def put(path, name, value):
        with winreg.CreateKeyEx(hk, path, 0, winreg.KEY_WRITE) as k:
            winreg.SetValueEx(k, name, 0, winreg.REG_SZ, value)

    put(f"{CLASSES}\\Applications\\{APP}", "FriendlyAppName", "MediaInspector")
    put(f"{CLASSES}\\Applications\\{APP}\\shell\\open\\command", "", cmd)
    for kind, exts in _exts().items():
        pid = PROGIDS[kind]
        put(f"{CLASSES}\\{pid}", "", f"MediaInspector {kind}")
        put(f"{CLASSES}\\{pid}\\shell\\open\\command", "", cmd)
        if icon:
            put(f"{CLASSES}\\{pid}\\DefaultIcon", "", icon)
        for e in exts:
            put(f"{CLASSES}\\Applications\\{APP}\\SupportedTypes", f".{e}", "")
            put(f"{CLASSES}\\.{e}\\OpenWithProgids", pid, "")
            put(f"{CLASSES}\\SystemFileAssociations\\.{e}\\shell\\{VERB}", "", "Open with MediaInspector")
            if icon:
                put(f"{CLASSES}\\SystemFileAssociations\\.{e}\\shell\\{VERB}", "Icon", icon)
            put(f"{CLASSES}\\SystemFileAssociations\\.{e}\\shell\\{VERB}\\command", "", cmd)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="register")
    ap.add_argument("--remove", action="store_true")
    args = ap.parse_args(argv)
    if sys.platform != "win32":
        print("File-type registration is for Windows.")
        return 1
    import winreg
    remove(winreg)
    if args.remove:
        print("Removed. If MediaInspector was the default app, pick a new one in Settings > Apps > Default apps.")
        return 0
    register(winreg)
    import ctypes
    ctypes.windll.shell32.SHChangeNotify(0x08000000, 0, None, None)   # tell Explorer
    n = sum(len(v) for v in _exts().values())
    print(f"Registered {n} file types for {command()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
