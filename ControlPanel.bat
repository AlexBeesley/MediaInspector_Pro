@echo off
rem Opens only the control panel (the player can already be running).
start "" powershell -NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0ControlPanel.ps1"
