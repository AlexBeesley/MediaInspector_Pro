@echo off
rem Launches MediaInspector_Pro via Launch.ps1, which restores the last file
rem and window position, then remembers the window position while it runs.
rem Drag any video, photo or audio file onto this to open it.
rem The control panel stays off until you press Ctrl+P / the Panel button.
start "" powershell -NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0Launch.ps1" %*
