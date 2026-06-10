@echo off
chcp 65001 >nul
echo ============================================
echo   关闭热更服务器（端口 8384）
echo ============================================
echo.
set "FOUND="
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8384" ^| findstr LISTENING') do (
  echo 结束占用 8384 的进程 PID=%%a
  taskkill /F /PID %%a >nul 2>&1
  set "FOUND=1"
)
if defined FOUND (echo 已关闭。) else (echo 未发现运行中的热更服务器。)
echo.
pause
