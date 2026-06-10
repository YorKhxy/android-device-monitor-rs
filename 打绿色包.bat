@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   打绿色包（免安装便携版）
echo ============================================
echo.
echo 将编译 release 并组装「exe + platform-tools + scrcpy」便携文件夹，
echo 产物在 release-portable\ 下（含 zip）。首次编译较慢，请耐心等待。
echo.
node scripts\build-portable.mjs %*
echo.
pause
