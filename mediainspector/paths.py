"""Where things live. Settings go in the user's config folder, not beside the
app, so moving or reinstalling the app never loses or breaks them."""

from __future__ import annotations

import os
import sys


def app_root() -> str:
    """The folder holding assets/: the package's parent from source, the
    bundle's unpack folder when packaged."""
    if getattr(sys, "frozen", False):
        return getattr(sys, "_MEIPASS", os.path.dirname(sys.executable))
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def assets(*parts: str) -> str:
    return os.path.join(app_root(), "assets", *parts)


def config_dir() -> str:
    if os.environ.get("MI_CONFIG_DIR"):
        return os.environ["MI_CONFIG_DIR"]
    if sys.platform == "win32":
        base = os.environ.get("APPDATA") or os.path.expanduser("~")
    else:
        base = os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config")
    return os.path.join(base, "MediaInspector")


def settings_file() -> str:
    return os.path.join(config_dir(), "settings.json")


def user_shader_dir() -> str:
    """Shaders the user drops in: alongside the bundled ones in the list."""
    return os.path.join(config_dir(), "shaders")


def default_export_dir() -> str:
    pics = os.path.join(os.path.expanduser("~"), "Pictures")
    base = pics if os.path.isdir(pics) else os.path.expanduser("~")
    return os.path.join(base, "MediaInspector Exports")


def libmpv_search_dirs() -> list[str]:
    """libmpv-2.dll ships next to the exe, or in vendor/ when run from source."""
    root = app_root()
    return [root, os.path.join(root, "vendor"), os.path.dirname(sys.executable)]
