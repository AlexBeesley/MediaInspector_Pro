@echo off
rem One-time setup from source: a virtual environment, the Python packages,
rem and libmpv (the media engine) into vendor\.
setlocal
cd /d "%~dp0"
where py >nul 2>nul && (set "PY=py -3") || (set "PY=python")
%PY% -m venv .venv || goto :fail
".venv\Scripts\python.exe" -m pip install --upgrade pip || goto :fail
".venv\Scripts\python.exe" -m pip install -r requirements-dev.txt || goto :fail
".venv\Scripts\python.exe" build\fetch_libmpv.py || goto :fail
echo.
echo Ready. Run MediaInspector.bat, or build.bat for a standalone exe.
pause
exit /b 0
:fail
echo Setup failed - see the messages above.
pause
exit /b 1
