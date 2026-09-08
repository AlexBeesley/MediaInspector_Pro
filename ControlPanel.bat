@echo off
rem Opens only the MediaInspector_Pro control panel (the player can
rem already be running).
start "" powershell -NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0ControlPanel.ps1"
