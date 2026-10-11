@echo off
rem Claude-Firefox: baut das Firefox-Add-on aus der aktuellen Claude-Chrome-Extension.
rem Doppelklick genuegt. Weitere Optionen: build.cmd --help
setlocal
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js wurde nicht gefunden. Bitte zuerst Node.js installieren: https://nodejs.org
  pause
  exit /b 1
)
node scripts\build.mjs %*
set EXITCODE=%ERRORLEVEL%
echo.
pause
exit /b %EXITCODE%
