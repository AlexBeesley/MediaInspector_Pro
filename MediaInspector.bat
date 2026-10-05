@echo off
rem Runs the packaged build if there is one, otherwise from source.
rem Drag a file onto this to open it.
setlocal
set "ROOT=%~dp0"
if exist "%ROOT%dist\MediaInspector\MediaInspector.exe" (
  start "" "%ROOT%dist\MediaInspector\MediaInspector.exe" %*
  exit /b
)
if exist "%ROOT%.venv\Scripts\pythonw.exe" (
  start "" "%ROOT%.venv\Scripts\pythonw.exe" "%ROOT%run.pyw" %*
  exit /b
)
echo Not set up yet. Run setup.bat first.
pause
