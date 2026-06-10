@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === Update Server (port 8384) ===
echo Keep this window OPEN = server running. Close it to stop.
echo Client update URL: http://YOUR-LAN-IP:8384/latest.json
echo.
node scripts\serve-updates.mjs
echo.
echo (server stopped)
pause
