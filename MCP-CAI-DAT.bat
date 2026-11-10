@echo off
cd /d "%~dp0agent"

echo ==========================================================
echo    FLOWBOARD MCP - KET NOI CLAUDE / CODEX
echo ==========================================================
echo.

if not exist ".venv\Scripts\python.exe" (
  echo [LOI] Chua cai Flowboard. Chay CAI-DAT.bat truoc.
  pause
  exit /b 1
)

echo [1/2] Cai thu vien MCP vao agent...
".venv\Scripts\python.exe" -m pip install -q -e .
if errorlevel 1 (
  echo [LOI] Cai thu vien that bai. Kiem tra mang roi chay lai.
  pause
  exit /b 1
)
echo.

echo [2/2] Dang ky "flowboard" vao Claude Desktop, Claude Code, Codex...
".venv\Scripts\python.exe" -m flowboard_mcp install
echo.
echo ==========================================================
echo    XONG.
echo    - Claude Desktop: thoat han app (ca icon duoi khay) roi mo lai.
echo    - Claude Code / Codex: mo phien moi la co tool "flowboard".
echo    - ChatGPT / claude.ai tren web, dien thoai: chay MCP-CHATGPT.bat
echo    Nho mo Flowboard truoc (MO-APP.bat) moi dieu khien duoc.
echo ==========================================================
pause
