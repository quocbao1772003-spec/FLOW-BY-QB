@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ==========================================================
echo    FLOWBOARD - CAI DAT (INSTALL)
echo ==========================================================
echo.

REM ---------- Tim Python ----------
set "PY="
where py >nul 2>&1
if %errorlevel%==0 set "PY=py -3"
if not defined PY (
  where python >nul 2>&1
  if !errorlevel!==0 set "PY=python"
)
if not defined PY (
  echo [LOI] Khong tim thay Python.
  echo       Tai Python 3.11+ tai: https://www.python.org/downloads/
  echo       Khi cai NHO TICH o "Add python.exe to PATH".
  echo.
  pause
  exit /b 1
)
echo [OK] Python: %PY%

REM ---------- Tim Node ----------
where node >nul 2>&1
if not %errorlevel%==0 (
  echo [LOI] Khong tim thay Node.js.
  echo       Tai Node 20+ tai: https://nodejs.org/en/download
  echo.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -v') do echo [OK] Node: %%v
echo.

REM ---------- 1/2: Agent (Python) ----------
echo [1/2] Cai dat agent (FastAPI, port 8101)...
cd /d "%~dp0agent"
if not exist ".venv\Scripts\python.exe" (
  echo       Tao virtual env...
  %PY% -m venv .venv
  if not exist ".venv\Scripts\python.exe" (
    echo [LOI] Tao virtual env that bai.
    pause
    exit /b 1
  )
)
".venv\Scripts\python.exe" -m pip install --upgrade pip
".venv\Scripts\python.exe" -m pip install -e .
if not %errorlevel%==0 (
  echo [LOI] Cai dependency Python that bai.
  pause
  exit /b 1
)
echo [OK] Agent da san sang.
echo.

REM ---------- 2/2: Frontend (Node) ----------
echo [2/2] Cai dat frontend (Vite + React, port 5173)...
cd /d "%~dp0frontend"
call npm install
if not %errorlevel%==0 (
  echo [LOI] npm install that bai.
  pause
  exit /b 1
)
echo [OK] Frontend da san sang.
echo.

cd /d "%~dp0"
echo ==========================================================
echo    CAI DAT XONG!
echo.
echo    Buoc tiep theo: chay file  MO-APP.bat
echo ==========================================================
echo.
pause
