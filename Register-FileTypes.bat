@echo off
rem Adds "Open with SlowmoPlayer" to the right-click menu for .mp4/.mov/.m4v.
rem Add the word  default  after the script name to also make it the default app.
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Register-FileTypes.ps1" %*
pause
