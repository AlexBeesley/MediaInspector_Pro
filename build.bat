@echo off
rem Builds dist\MediaInspector\MediaInspector.exe (a folder you can move or zip).
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" call setup.bat
".venv\Scripts\python.exe" -m pytest -q tests || (echo Tests failed - not building. & pause & exit /b 1)
".venv\Scripts\python.exe" -m PyInstaller --noconfirm build\mediainspector.spec || (pause & exit /b 1)
echo.
echo Built dist\MediaInspector\MediaInspector.exe
pause
