@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   启动热更服务器（端口 8788）
echo ============================================
echo.
echo 分发 release-updates\latest.json 与安装包。保持本窗口开着即服务运行中；
echo 关闭服务请运行「关闭热更服务器.bat」或直接关掉本窗口。
echo.
node scripts\serve-updates.mjs
echo.
echo 服务已停止。
pause
