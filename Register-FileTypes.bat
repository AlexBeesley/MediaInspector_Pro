@echo off
rem Adds "Open with MediaInspector_Pro" to the right-click menu for every
rem supported video, photo and audio extension.
rem Add the word  default  after the script name to also make it the default app.
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Register-FileTypes.ps1" %*
pause
