@echo off
rem ============================================================
rem  MediaExplorer - indexed, cached browser for media on any disk.
rem
rem  Run this, or drop a folder on it. Double-clicking a media file in it
rem  opens MediaInspector_Pro. Prefers the packaged build, falls back to
rem  running from source.
rem      packaged:  cd explorer && npm run build
rem      from src:  cd explorer && npm install
rem ============================================================
setlocal
set ROOT=%~dp0
set PACKAGED=%ROOT%dist\MediaExplorer-win32-x64\MediaExplorer.exe
set ELECTRON=%ROOT%explorer\node_modules\electron\dist\electron.exe

if exist "%PACKAGED%" (
    start "MediaExplorer" "%PACKAGED%" %*
    exit /b 0
)

if exist "%ELECTRON%" (
    start "MediaExplorer" "%ELECTRON%" "%ROOT%explorer" %*
    exit /b 0
)

echo Neither a packaged build nor the dependencies were found.
echo   cd "%ROOT%explorer"
echo   npm install       ^&^& npm start        (run from source^)
echo   npm run build                          (build the exe^)
pause
exit /b 1
