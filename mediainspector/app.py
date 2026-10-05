"""Start-up: find libmpv, make sure only one window runs, open the window.

    python -m mediainspector [file] [--shot=out.png]

A second launch hands its file to the running window and exits, so "Open
with" from Explorer reuses it.
"""

from __future__ import annotations

import argparse
import getpass
import os
import sys

from . import paths

SERVER = f"mediainspector-{getpass.getuser()}"


def _find_libmpv():
    """libmpv-2.dll ships beside the exe (or in vendor/ from source); python-mpv
    looks for it on PATH, so put those folders first."""
    dirs = [d for d in paths.libmpv_search_dirs() if os.path.isdir(d)]
    os.environ["PATH"] = os.pathsep.join(dirs + [os.environ.get("PATH", "")])
    if sys.platform == "win32":
        for d in dirs:
            try:
                os.add_dll_directory(d)
            except OSError:
                pass


def _hand_off(path: str | None) -> bool:
    """True when another window is running and took the file."""
    from PySide6.QtNetwork import QLocalSocket
    sock = QLocalSocket()
    sock.connectToServer(SERVER)
    if not sock.waitForConnected(300):
        return False
    sock.write((os.path.abspath(path) if path else "").encode("utf-8"))
    sock.flush()
    sock.waitForBytesWritten(500)
    sock.disconnectFromServer()
    return True


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="mediainspector")
    ap.add_argument("file", nargs="?")
    ap.add_argument("--shot", help="render the window to this PNG after a few seconds and exit")
    ap.add_argument("--new-window", action="store_true", help="do not hand off to a running window")
    args = ap.parse_args(argv)

    _find_libmpv()
    from PySide6.QtCore import QCoreApplication, Qt, QTimer
    from PySide6.QtGui import QSurfaceFormat
    from PySide6.QtWidgets import QApplication

    # Desktop OpenGL, not ANGLE: libmpv's render API needs real GL.
    QCoreApplication.setAttribute(Qt.AA_UseDesktopOpenGL)
    QCoreApplication.setAttribute(Qt.AA_ShareOpenGLContexts)
    fmt = QSurfaceFormat()
    fmt.setSwapInterval(1)
    QSurfaceFormat.setDefaultFormat(fmt)
    app = QApplication(sys.argv[:1])
    app.setApplicationName("MediaInspector")

    if not args.new_window and not args.shot and _hand_off(args.file):
        return 0

    from PySide6.QtNetwork import QLocalServer

    from .controller import Controller
    from .core.state import Settings, Store
    from .engine.player import Engine
    from .ui.main_window import MainWindow

    settings_path = paths.settings_file()
    store = Store(Settings.load(settings_path))
    try:
        engine = Engine(store)
    except Exception as e:  # noqa: BLE001 - libmpv missing or refused to start
        from PySide6.QtWidgets import QMessageBox
        QMessageBox.critical(None, "MediaInspector", f"The media engine (libmpv) could not start:\n\n{e}\n\n"
                             "Run build\\fetch_libmpv.py, or reinstall the app.")
        return 1
    controller = Controller(store, engine, settings_path)
    win = MainWindow(controller)
    win.show()

    server = QLocalServer()
    QLocalServer.removeServer(SERVER)
    server.listen(SERVER)

    def incoming():
        s = server.nextPendingConnection()
        s.waitForReadyRead(500)
        path = bytes(s.readAll()).decode("utf-8", "replace").strip()
        if path:
            controller.open(path)
        win.setWindowState((win.windowState() & ~Qt.WindowMinimized) | Qt.WindowActive)
        win.raise_()
        win.activateWindow()
    server.newConnection.connect(incoming)

    start = args.file or (store.settings.last_file if os.path.isfile(store.settings.last_file) else None)
    if start:
        QTimer.singleShot(0, lambda: controller.open(start))

    if args.shot:
        def shot():
            win.screen().grabWindow(win.winId()).save(args.shot)
            print("saved", args.shot)
            win.close()
        QTimer.singleShot(3500, shot)

    rc = app.exec()
    server.close()
    return rc
