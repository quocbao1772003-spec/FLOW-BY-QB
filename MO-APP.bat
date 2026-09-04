@echo off
cd /d "%~dp0"

echo ==========================================================
echo    FLOWBOARD - MO APP
echo ==========================================================
echo.

if not exist "agent\.venv\Scripts\python.exe" goto :needinstall
if not exist "frontend\node_modules" goto :needinstall
goto :run

:needinstall
echo Chua cai dat xong. Dang chay CAI-DAT.bat truoc...
echo.
call "%~dp0CAI-DAT.bat"
if not exist "agent\.venv\Scripts\python.exe" exit /b 1
if not exist "frontend\node_modules" exit /b 1

:run
echo Khoi dong agent (port 8101)...
start "" "%~dp0_run-agent.bat"
echo Khoi dong frontend (port 5173)...
start "" "%~dp0_run-frontend.bat"
echo.
echo Doi 12 giay cho server khoi dong...
timeout /t 12 /nobreak >nul
echo Mo trinh duyet: http://localhost:5173
start "" http://localhost:5173
echo.
echo ==========================================================
echo    App dang chay. Hai cua so den la agent + frontend.
echo    Dong 2 cua so do de tat app.
echo.
echo    NHO: phai load Chrome extension trong thu muc
echo    extension\  va dang nhap Google Flow (Pro/Ultra).
echo ==========================================================
echo.
pause
