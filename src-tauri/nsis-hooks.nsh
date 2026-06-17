; NSIS 安装/卸载前钩子（Tauri bundle.windows.nsis.installerHooks 注入）。
;
; 解决「Error opening file for writing: ...\platform-tools\...\AdbWinApi.dll」(os error 32)：
; 双击 Setup 手动安装/更新时，旧版 app 可能仍在跑、或它起的 adb server 变成孤儿进程没退，
; 锁住安装目录里的 AdbWinApi.dll，NSIS 覆盖该文件就报错。Tauri 自带的 CheckIfAppIsRunning 只查 app 进程、
; 不管 adb，故在写文件前先把 app 与 adb 都清掉、释放 DLL 句柄。
;
; 可用符号（installer.nsi 在 !insertmacro 本宏前已定义/包含）：${MAINBINARYNAME} ${PRODUCTNAME} $INSTDIR、LogicLib、nsExec。

; 关旧版 app + 停 adb server + 兜底杀残留 adb，再留时间让句柄释放。
!macro ADM_KILL_APP_AND_ADB
  DetailPrint "安装前清理：关闭旧版与 adb server，释放被占用的 AdbWinApi.dll…"
  ; 1) 关掉正在运行的旧版（含子进程）。
  nsExec::Exec 'taskkill /F /T /IM "${MAINBINARYNAME}.exe"'
  Pop $0
  ; 2) 优雅停 adb server（用安装目录自带 adb，存在才调）——正常情况下这一步就释放了 DLL。
  ${If} ${FileExists} "$INSTDIR\platform-tools\win\platform-tools\adb.exe"
    nsExec::Exec '"$INSTDIR\platform-tools\win\platform-tools\adb.exe" kill-server'
    Pop $0
  ${EndIf}
  ; 3) 兜底：杀掉仍残留、可能锁着 DLL 的 adb.exe（孤儿 server / 客户端）。
  nsExec::Exec 'taskkill /F /IM adb.exe'
  Pop $0
  ; 4) 给文件句柄释放留时间，避免紧接着覆盖仍撞占用。
  Sleep 1000
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro ADM_KILL_APP_AND_ADB
!macroend

; 卸载同样会删除该 DLL，同样会撞占用 → 卸载前也清一遍。
!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro ADM_KILL_APP_AND_ADB
!macroend
