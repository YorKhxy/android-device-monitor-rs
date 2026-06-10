@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === Build Update package (version bump + sign + latest.json) ===
echo Output: update-releases\  (latest\ + v^<version^>_^<time^>\)
echo Set version explicitly:  打热更包.bat --version=0.2.0 --notes="..."
echo.
node scripts\build-update.mjs %*
echo.
pause
