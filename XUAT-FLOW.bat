@echo off
cd /d "%~dp0"
echo ==========================================================
echo    FLOWBOARD - XUAT FLOW DE DUA LEN SERVER
echo ==========================================================
echo.
set "PY=agent\.venv\Scripts\python.exe"
if not exist "%PY%" set "PY=python"
"%PY%" "tools\xuat_flow.py"
echo.
echo Buoc tiep: mo https://flowboard.flowytb.app, dang nhap,
echo vao trang Flows, bam Import va chon file flowboard-export.zip
echo.
pause
