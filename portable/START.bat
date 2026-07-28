@echo off
setlocal
REM ============================================================
REM  Verger launcher. Double-click this file to start Verger.
REM
REM  cd /d "%~dp0" makes this work from ANY drive letter, because
REM  a USB stick is not always E: — %~dp0 is the folder this .bat
REM  lives in, and everything Verger reads (config.json, .env,
REM  your plan + assets) is resolved from here.
REM ============================================================
cd /d "%~dp0"

if not exist "%~dp0Verger.exe" (
  echo.
  echo   Could not find Verger.exe next to this launcher.
  echo   Copy the WHOLE folder to the USB stick, not just START.bat.
  echo.
  pause
  exit /b 1
)

REM ============================================================
REM  If a portable OBS was assembled into this folder, hand it to
REM  a small launcher that starts it AFTER Verger's overlay server
REM  is listening.
REM
REM  The order matters and it is not the obvious one. An OBS
REM  Browser Source loads its URL at the moment OBS creates it. If
REM  OBS starts first, the overlay server is not up yet, the page
REM  load is REFUSED, and because "Refresh browser when scene
REM  becomes active" is deliberately OFF - so a camera cut never
REM  re-animates the overlay - it is never retried. OBS says
REM  connected, Verger says connected, and nothing reaches the
REM  congregation screen. Measured, not guessed.
REM
REM  Verger no longer needs OBS up first: it WAITS for OBS's port
REM  (waitForObsPort) instead of asking once.
REM ============================================================
if exist "%~dp0obs\bin\64bit\obs64.exe" (
  echo Starting OBS as soon as Verger is ready . . .
  start "Verger OBS launcher" /MIN "%~dp0obs-launcher.bat"
)

echo Starting Verger . . .
echo (You can minimize this window once Verger's own window opens.)
echo.

REM /wait so we can see the exit code and pause on a crash instead of
REM the window vanishing before the error can be read.
start /wait "Verger" "%~dp0Verger.exe" %*
set EXITCODE=%errorlevel%

if not "%EXITCODE%"=="0" (
  echo.
  echo ============================================================
  echo   Verger exited with error code %EXITCODE%.
  echo   Open RUNBOOK.md in this folder — it lists the five most
  echo   likely problems and exactly how to fix each one.
  echo ============================================================
  echo.
  pause
)
endlocal
