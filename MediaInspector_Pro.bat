@echo off
rem ============================================================
rem  MediaInspector_Pro - the Electron shell around the mpv player.
rem
rem  Run this, or drop a media file on it, or set it as the "open with"
rem  target. A second launch hands the file to the window that is already
rem  open rather than starting a rival player on the same IPC pipe.
rem
rem  Prefers the packaged build if there is one, and falls back to running
rem  from source so the app is launchable either way.
rem      packaged:  cd app && npm run build
rem      from src:  cd app && npm install
rem ============================================================
setlocal
set ROOT=%~dp0
set PACKAGED=%ROOT%dist\MediaInspector_Pro-win32-x64\MediaInspector_Pro.exe
set ELECTRON=%ROOT%app\node_modules\electron\dist\electron.exe

if exist "%PACKAGED%" (
    start "MediaInspector_Pro" "%PACKAGED%" %*
    exit /b 0
)

if exist "%ELECTRON%" (
    start "MediaInspector_Pro" "%ELECTRON%" "%ROOT%app" %*
    exit /b 0
)

echo Neither a packaged build nor the dependencies were found.
echo   cd "%ROOT%app"
echo   npm install       ^&^& npm start        (run from source^)
echo   npm run build                          (build the exe^)
pause
exit /b 1
