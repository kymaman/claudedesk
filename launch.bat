@echo off
REM ClaudeDesk launcher — runs the built Electron bundle in production mode.
REM Used by the Desktop shortcut so the app opens without a dev server.

cd /d "%~dp0"

REM Compile electron main if missing (first-run after clone)
if not exist "dist-electron\main.js" (
  call npm run compile
)

REM Build frontend bundle if missing (first-run after clone)
if not exist "dist\index.html" (
  call npm run build:frontend
)

start "" "node_modules\electron\dist\electron.exe" "dist-electron\main.js"
