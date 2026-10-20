@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is missing. Install Node.js 22 or newer from https://nodejs.org/
  pause
  exit /b 1
)
node -e "process.exit(Number(process.versions.node.split('.')[0])>=22?0:1)" >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 or newer is required. Update from https://nodejs.org/
  pause
  exit /b 1
)
node "%~dp0scripts\windows-start.mjs"
if errorlevel 1 (
  echo Startup failed. Read the message above, fix it, then run this file again.
  pause
  exit /b 1
)
endlocal
