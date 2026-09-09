@echo off
rem Launches MediaInspector_Pro. The app is a real .exe now - one window with
rem the picture and every control in it - so this is just a convenience
rem wrapper that builds it on first run. Drag any video, photo or audio file
rem onto this to open it.
setlocal
if not exist "%~dp0MediaInspector_Pro.exe" (
    echo Building MediaInspector_Pro.exe ...
    powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Build.ps1"
)
start "" "%~dp0MediaInspector_Pro.exe" %*
