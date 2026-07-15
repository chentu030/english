@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   快速背單字 - 本機伺服器啟動中...
echo   網址： http://localhost:8000
echo   要關閉：直接關掉這個黑色視窗
echo ============================================
start "" http://localhost:8000
python -m http.server 8000
pause
