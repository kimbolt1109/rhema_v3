@echo off
setlocal enabledelayedexpansion
REM ============================================================
REM  Start the bundled OBS, but only once Verger's overlay server
REM  is actually listening.
REM
REM  WHY THIS FILE EXISTS. An OBS Browser Source loads its URL at
REM  the moment OBS creates the source - at OBS startup. If the
REM  overlay server is not listening by then, the page load is
REM  refused, and because "Refresh browser when scene becomes
REM  active" is deliberately OFF (so a camera cut never re-animates
REM  the overlay) it is NEVER retried. The result is the worst
REM  shape a fault can take: OBS reports connected, Verger reports
REM  connected, and nothing at all reaches the congregation
REM  screen. This was measured with netstat, not guessed.
REM
REM  So START.bat launches Verger, and this waits for port 7320
REM  before starting OBS. Verger no longer needs OBS up first - it
REM  waits for OBS's own port rather than asking once.
REM
REM  Do not run this by hand. START.bat is the entry point.
REM ============================================================
cd /d "%~dp0"

if not exist "%~dp0obs\bin\64bit\obs64.exe" exit /b 0

REM ------------------------------------------------------------
REM  An OBS the operator opened themselves always wins. Two OBS
REM  instances fight over the camera and the encoder, so if
REM  anything is already serving obs-websocket on 4455, leave it
REM  alone and start nothing.
REM ------------------------------------------------------------
netstat -an | findstr /C:":4455 " | findstr /C:"LISTENING" >nul 2>&1
if not errorlevel 1 exit /b 0

REM ------------------------------------------------------------
REM  Wait for the overlay server. 60 tries at one second: far more
REM  than Verger needs to bind a loopback port, and the cost of
REM  waiting is nothing because OBS has not started yet.
REM
REM  If it never appears we start OBS anyway rather than not at
REM  all - a stream with a stale overlay beats no OBS whatsoever,
REM  and the operator can right-click the Overlays source and
REM  choose Refresh.
REM ------------------------------------------------------------
set OVERLAYUP=0
for /L %%i in (1,1,60) do (
  if !OVERLAYUP!==0 (
    netstat -an | findstr /C:":7320 " | findstr /C:"LISTENING" >nul 2>&1
    if not errorlevel 1 (
      set OVERLAYUP=1
    ) else (
      timeout /t 1 /nobreak >nul
    )
  )
)

start "OBS" /D "%~dp0obs\bin\64bit" "%~dp0obs\bin\64bit\obs64.exe"
endlocal
exit /b 0
