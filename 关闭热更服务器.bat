@echo off
chcp 65001 >nul
echo === Stop Update Server (port 8384) ===
set "FOUND="
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8384" ^| findstr LISTENING') do (
  echo Killing PID %%a ...
  taskkill /F /PID %%a >nul 2>&1
  set "FOUND=1"
)
if defined FOUND (echo Done.) else (echo No running update server found.)
echo.
pause
