@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === Build Portable (green) package ===
echo Output: src\release\^<month^>\AndroidDeviceMonitor_^<date^>_^<time^>\
echo First build takes a while (release compile). Please wait.
echo.
node scripts\build-portable.mjs %*
echo.
pause
