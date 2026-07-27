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
REM  If a portable OBS was assembled into this folder, start it
REM  FIRST — Verger reads OBS's settings at launch, so OBS has to
REM  be up before Verger is, or the operator has to press Connect.
REM
REM  Only when nothing is already serving on 4455. Two OBS
REM  instances fight over the camera and the encoder, so an OBS
REM  the operator already opened must always win over this one.
REM ============================================================
if exist "%~dp0obs\bin\64bit\obs64.exe" (
  netstat -an | findstr /C:":4455 " | findstr /C:"LISTENING" >nul 2>&1
  if errorlevel 1 (
    echo Starting OBS from this folder . . .
    start "OBS" /D "%~dp0obs\bin\64bit" "%~dp0obs\bin\64bit\obs64.exe"
    REM Give OBS time to open its WebSocket port before Verger looks for it.
    REM Verger still works if this is too short - the operator presses Connect.
    timeout /t 8 /nobreak >nul
  ) else (
    echo OBS is already running - leaving it alone.
  )
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
