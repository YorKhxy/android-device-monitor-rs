@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   打热更包（版本自增 + 签名 + latest.json）
echo ============================================
echo.
echo 默认 patch 自增版本号；指定版本用： 打热更包.bat --version=0.2.0 --notes="修了xxx"
echo 签名私钥/密码读 src-tauri\.tauri-keys\（已 gitignore）。
echo 产物在 release-updates\（latest.json + setup.exe）。
echo.
node scripts\build-update.mjs %*
echo.
pause
