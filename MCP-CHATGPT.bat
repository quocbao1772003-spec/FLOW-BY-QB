@echo off
cd /d "%~dp0agent"
title Flowboard MCP - link cho ChatGPT / claude.ai

if not exist ".venv\Scripts\python.exe" (
  echo [LOI] Chua cai Flowboard. Chay CAI-DAT.bat truoc.
  pause
  exit /b 1
)

".venv\Scripts\python.exe" -c "import mcp" >nul 2>&1
if errorlevel 1 (
  echo Cai thu vien MCP lan dau...
  ".venv\Scripts\python.exe" -m pip install -q -e .
)

echo Nho: Flowboard phai dang chay (MO-APP.bat) va Chrome co extension.
echo.
".venv\Scripts\python.exe" -m flowboard_mcp public
pause
