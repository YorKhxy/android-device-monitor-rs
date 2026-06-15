@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === Clean project (free disk space) ===
echo Default (double-click): cargo clean -- removes src-tauri\target build cache
echo Pass --releases to also prune old release outputs (keep latest + newest 3)
echo Pass --dry to preview only (delete nothing)
echo   e.g.  run from cmd:  cleanup.bat --releases --dry
echo.
node scripts\clean.mjs %*
echo.
pause
