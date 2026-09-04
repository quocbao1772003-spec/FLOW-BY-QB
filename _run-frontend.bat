@echo off
title Flowboard Frontend - port 5173
cd /d "%~dp0frontend"
if not exist "node_modules" (
  echo [LOI] Chua cai dat. Chay CAI-DAT.bat truoc.
  pause
  exit /b 1
)
echo === Flowboard Frontend dang chay tren http://localhost:5173 ===
echo === Dong cua so nay de tat frontend ===
echo.
call npm run dev
pause
