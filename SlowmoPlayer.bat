@echo off
rem Launches the player via Launch.ps1, which restores the last video and
rem window position, then remembers the window position while it runs.
rem The control panel stays off until you press Ctrl+P / the Panel button.
start "" powershell -NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0Launch.ps1" %*
