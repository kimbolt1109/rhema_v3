@echo off
setlocal enabledelayedexpansion
REM ============================================================================
REM  SETUP-ASR.bat — one-time provisioning of Verger's LOCAL Whisper speech
REM  engine (faster-whisper). Double-click this on the church PC.
REM
REM  What this buys you: the confidence percentage in Verger's bottom bar,
REM  which needs a local speech recogniser. Nothing else in Verger needs this —
REM  slides, OBS control, the overlay and manual cues all work with no setup at
REM  all. See ASR-SETUP.md for the plain-language version.
REM
REM  Needs the internet only ONCE, to download the packages and model weights.
REM  Creates the environment at resources\asr-venv next to Verger.exe, which is
REM  where the app looks for it (resolveWhisperRuntime in WhisperProvider.ts).
REM ============================================================================
cd /d "%~dp0"

echo.
echo   ============================================================
echo     Verger - local Whisper speech engine setup
echo   ============================================================
echo.
echo   Working folder: %~dp0
echo.

if not exist "%~dp0resources" (
  echo   ERROR: no "resources" folder found next to this script.
  echo.
  echo   This script must live in the SAME folder as Verger.exe and
  echo   START.bat. If you moved SETUP-ASR.bat by itself, copy it back
  echo   next to Verger.exe and run it again from there.
  echo.
  pause
  exit /b 1
)

set "VENV_DIR=%~dp0resources\asr-venv"
set "VENV_PY=%VENV_DIR%\Scripts\python.exe"
set "SIDECAR=%~dp0resources\asr\whisper_sidecar.py"

if not exist "%SIDECAR%" (
  echo   ERROR: %SIDECAR%
  echo   is missing. This build was not packaged with the ASR sidecar, so
  echo   local speech recognition cannot be set up on this copy. Manual
  echo   operation still works fine. Re-copy the whole Verger folder if you
  echo   believe this is a mistake.
  echo.
  pause
  exit /b 1
)

echo   [1/5] Looking for Python...

set "PY_LAUNCHER="
where py >nul 2>nul
if not errorlevel 1 (
  py -3 --version >nul 2>nul
  if not errorlevel 1 set "PY_LAUNCHER=py -3"
)

if not defined PY_LAUNCHER (
  where python >nul 2>nul
  if not errorlevel 1 (
    python --version >nul 2>nul
    if not errorlevel 1 set "PY_LAUNCHER=python"
  )
)

if not defined PY_LAUNCHER (
  echo.
  echo   ------------------------------------------------------------
  echo     Python is not installed ^(or not on PATH^) on this PC.
  echo   ------------------------------------------------------------
  echo.
  echo   Local speech recognition needs Python 3. Get it from:
  echo.
  echo       https://www.python.org/downloads/windows/
  echo.
  echo   When installing:
  echo     - Choose the 64-bit installer ^(the default one^).
  echo     - Python 3.10 through 3.13 are well tested.
  echo     - TICK "Add python.exe to PATH" on the first install screen
  echo       ^(it is off by default and this script needs it^).
  echo.
  echo   After installing, close this window and double-click
  echo   SETUP-ASR.bat again.
  echo.
  pause
  exit /b 1
)

for /f "delims=" %%v in ('%PY_LAUNCHER% --version 2^>^&1') do set "PY_VERSION=%%v"
echo         found: %PY_VERSION%  ^(using "%PY_LAUNCHER%"^)
echo.

echo   [2/5] Setting up the Python environment...

if exist "%VENV_PY%" (
  echo         already exists, reusing:
  echo           %VENV_DIR%
) else (
  echo         creating:
  echo           %VENV_DIR%
  %PY_LAUNCHER% -m venv "%VENV_DIR%"
  if errorlevel 1 (
    echo.
    echo   ERROR: creating the environment failed. Common causes:
    echo     - Antivirus blocked writing here — exclude this folder or run
    echo       this script as Administrator once.
    echo     - The USB stick / folder is read-only.
    echo.
    pause
    exit /b 1
  )
)

if not exist "%VENV_PY%" (
  echo.
  echo   ERROR: expected %VENV_PY% after creating the environment, but it
  echo   is not there. Delete the folder "%VENV_DIR%" and run this again.
  echo.
  pause
  exit /b 1
)
echo.

echo   [3/5] Installing faster-whisper (needs internet, first time only)...
echo.

"%VENV_PY%" -m pip install --upgrade pip
if errorlevel 1 (
  echo.
  echo   WARNING: could not upgrade pip. Continuing anyway.
  echo.
)

"%VENV_PY%" -m pip install --upgrade faster-whisper
if errorlevel 1 (
  echo.
  echo   ------------------------------------------------------------
  echo     Installing faster-whisper failed.
  echo   ------------------------------------------------------------
  echo   Most likely: no internet connection right now. Connect this PC
  echo   to the internet and run SETUP-ASR.bat again — nothing is lost.
  echo   If it still fails with internet on, read pip's error above; a
  echo   corporate proxy/certificate may be blocking pypi.org.
  echo.
  pause
  exit /b 1
)
echo.
echo         faster-whisper installed.
echo.

echo   [4/5] Verifying the environment...
echo.
"%VENV_PY%" "%SIDECAR%" --selftest
if errorlevel 1 (
  echo.
  echo   ERROR: the self-test failed — the packages did not import cleanly
  echo   in this Python. Try installing Python 3.11 or 3.12 alongside your
  echo   current one, delete "%VENV_DIR%", and run SETUP-ASR.bat again.
  echo.
  pause
  exit /b 1
)
echo.
echo         self-test passed. ^("cudaDevices":0 in the line above means
echo         CPU-only, which is fine, just slower.^)
echo.

echo   [5/5] Pre-downloading the speech models (tiny + small, ~550 MB)...
echo         This needs internet and can take a while. Do not close this.
echo.

set "PREDL=%TEMP%\verger_asr_predownload.py"
> "%PREDL%" echo from faster_whisper import WhisperModel
>> "%PREDL%" echo models = ("tiny", "small")
>> "%PREDL%" echo for i, name in enumerate(models, 1):
>> "%PREDL%" echo     print(f"  ({i}/{len(models)}) downloading '{name}' ...", flush=True)
>> "%PREDL%" echo     WhisperModel(name, device="cpu", compute_type="int8")
>> "%PREDL%" echo     print(f"      '{name}' ready.", flush=True)
>> "%PREDL%" echo print("All models cached.", flush=True)

"%VENV_PY%" "%PREDL%"
set "PREDL_RESULT=%errorlevel%"
del "%PREDL%" >nul 2>nul

if not "%PREDL_RESULT%"=="0" (
  echo.
  echo   ------------------------------------------------------------
  echo     Model download did not finish.
  echo   ------------------------------------------------------------
  echo   The environment itself IS working ^(the self-test passed^), so
  echo   Verger will still download whatever is missing the first time you
  echo   start a local-ASR session — it will just take longer that once.
  echo   To finish it now, connect to reliable internet and re-run this.
  echo.
  pause
  exit /b 1
)

echo.
echo   ============================================================
echo     Done. Local Whisper speech recognition is set up.
echo   ============================================================
echo.
echo   Environment: %VENV_DIR%
echo.
echo   Next: check config.json has  "asr": { "engine": "whisper" }, start
echo   Verger, and open the Speech settings panel — it should report the
echo   local recogniser as available.
echo.
echo   Optional GPU acceleration (NVIDIA only): install CUDA 12 drivers and
echo     "%VENV_PY%" -m pip install nvidia-cublas-cu12 nvidia-cudnn-cu12
echo   CPU-only works fine without this, just slower.
echo.
pause
endlocal
