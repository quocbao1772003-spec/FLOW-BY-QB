@echo off
cd /d "%~dp0"

echo ==========================================================
echo    CAI DAT CLAUDE CODE CLI cho Flowboard
echo ==========================================================
echo.

where npm >nul 2>&1
if not %errorlevel%==0 (
  echo [LOI] Khong tim thay npm. Cai Node.js 20+ tai https://nodejs.org
  pause
  exit /b 1
)

echo [1/3] Cai Claude Code CLI (npm global)...
call npm install -g @anthropic-ai/claude-code
if not %errorlevel%==0 (
  echo [LOI] Cai that bai. Thu mo cua so nay bang "Run as administrator".
  pause
  exit /b 1
)
echo.

echo [2/3] Kiem tra phien ban...
call claude --version
echo.

echo [3/3] Dang nhap tai khoan Claude...
echo       Cua so trinh duyet se mo ra de dang nhap OAuth.
echo       Dang nhap xong thi go /exit de thoat Claude.
echo.
pause
call claude

echo.
echo ==========================================================
echo    XONG. Bay gio:
echo    1) Dong 2 cua so agent + frontend cu (neu dang mo)
echo    2) Chay lai MO-APP.bat
echo    3) Trong app: chon the "Claude Code" -^> Run tests -^> Apply
echo ==========================================================
echo.
pause
