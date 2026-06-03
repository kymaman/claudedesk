@echo off
REM Wrapper so the desktop .lnk can target a simple .cmd. The actual logic
REM lives in launch.ps1 (mtime-based rebuild + Electron spawn).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch.ps1"
