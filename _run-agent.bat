@echo off
title Flowboard Agent - port 8101
cd /d "%~dp0agent"
if not exist ".venv\Scripts\python.exe" (
  echo [LOI] Chua cai dat. Chay CAI-DAT.bat truoc.
  pause
  exit /b 1
)
echo === Flowboard Agent dang chay tren http://127.0.0.1:8101 ===
echo === Dong cua so nay de tat agent ===
echo.
".venv\Scripts\python.exe" -m uvicorn flowboard.main:app --reload --port 8101
pause
