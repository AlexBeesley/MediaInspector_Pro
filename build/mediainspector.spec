# PyInstaller build: dist\MediaInspector\MediaInspector.exe, a folder that
# carries Python, Qt, FFmpeg (inside PyAV) and libmpv. Run build.bat.
import os

ROOT = os.path.abspath(os.path.join(SPECPATH, ".."))
dll = os.path.join(ROOT, "vendor", "libmpv-2.dll")
if not os.path.exists(dll):
    raise SystemExit("vendor/libmpv-2.dll is missing - run: python build/fetch_libmpv.py")

a = Analysis(
    [os.path.join(ROOT, "run.pyw")],
    pathex=[ROOT],
    binaries=[(dll, ".")],
    datas=[(os.path.join(ROOT, "assets"), "assets")],
    hiddenimports=["mpv", "av", "numpy", "PIL.Image", "PySide6.QtOpenGLWidgets", "PySide6.QtNetwork",
                   "mediainspector.tools.register", "mediainspector.tools.colour_code"],
    excludes=["tkinter", "PySide6.QtWebEngineCore", "PySide6.QtWebEngineWidgets", "PySide6.Qt3DCore",
              "PySide6.QtQuick3D", "PySide6.QtCharts", "PySide6.QtDataVisualization", "PySide6.QtMultimedia"],
)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="MediaInspector", console=False,
          icon=os.path.join(ROOT, "assets", "app.ico"))
coll = COLLECT(exe, a.binaries, a.datas, name="MediaInspector")
