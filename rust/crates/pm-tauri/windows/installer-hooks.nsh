; Pulsar Manager 的 NSIS 安装/卸载钩子。
;
; 这个文件会在 installer.nsi 里被 !include，位置早于 PRODUCTNAME / MAINBINARYNAME
; 等 define，因此宏体里可以引用这些符号（展开发生在安装/卸载段），但函数体里
; 不能直接写 ${...}——需要产品名的函数由调用方通过 $R8 传入。
;
; 解决四件事：
;   1. 升级时清掉旧版本（含 Electron 版）留下的安装文件与快捷方式；
;   2. 卸载时删掉整个安装目录，而不是"目录空了才删"；
;   3. 卸载时清掉只记录安装位置/卸载信息的注册表项；
;   4. 用户勾选"删除应用程序数据"时，删掉本应用真正使用的
;      %APPDATA%\pulsar-manager（数据库、日志、密钥都在这），
;      而不是 Tauri 模板默认的 ${BUNDLEID} 目录。

; 升级标记：只有"装过本产品"的目录才做整目录清理，避免用户把程序装进一个
; 非空的自定义目录时误删他原有的文件。
Var PmHadPreviousInstall

; ---------------------------------------------------------------------------
; 工具函数
; ---------------------------------------------------------------------------

; 删除一个旧安装目录。$R0 = 目录。
; 先尝试跑旧版自带的卸载程序（静默、就地），它能一并清掉自己写的注册表项与快捷方式；
; 没有卸载程序或执行失败就整目录删除，绝不留下旧 exe / dll / resources。
Function PMRemoveLegacyDirectory
  IfFileExists "$R0\*.*" 0 pm_legacy_dir_done
  FindFirst $R3 $R4 "$R0\Uninstall*.exe"
  StrCmp $R4 "" pm_legacy_dir_none
  FindClose $R3
  ExecWait '"$R0\$R4" /S _?=$R0' $R5
  Goto pm_legacy_dir_rmdir
pm_legacy_dir_none:
  FindClose $R3
pm_legacy_dir_rmdir:
  RMDir /r "$R0"
pm_legacy_dir_done:
FunctionEnd

; 删除旧 Electron 版写在 HKCU 卸载表里的项。$R8 = 产品名。
; Tauri 自己的卸载键名恰好就是产品名，必须跳过，否则会把刚写的卸载信息删掉。
Function PMRemoveLegacyUninstallEntries
  StrCpy $R9 0
pm_legacy_reg_loop:
  EnumRegKey $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall" $R9
  StrCmp $R0 "" pm_legacy_reg_done
  StrCmp $R0 $R8 pm_legacy_reg_next
  ReadRegStr $R1 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R0" "DisplayName"
  StrCmp $R1 $R8 0 pm_legacy_reg_next
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R0"
  ; 删掉的是当前项，后一项会顶到同一个索引上，不能再 +1
  Goto pm_legacy_reg_loop
pm_legacy_reg_next:
  IntOp $R9 $R9 + 1
  Goto pm_legacy_reg_loop
pm_legacy_reg_done:
  ; electron-builder 还会按 appId 写一个产品键
  DeleteRegKey HKCU "Software\com.pulsar.manager"
FunctionEnd

; ---------------------------------------------------------------------------
; 旧 Electron 版清理（安装前、卸载前都跑）
; ---------------------------------------------------------------------------
!macro PM_PRE_CLEAN_LEGACY
  ; electron-builder 的 per-user 默认安装目录是 %LOCALAPPDATA%\Programs\<productName>；
  ; 早期包名是小写，两种都处理。
  StrCpy $R0 "$LOCALAPPDATA\Programs\Pulsar Manager"
  Call PMRemoveLegacyDirectory
  StrCpy $R0 "$LOCALAPPDATA\Programs\pulsar-manager"
  Call PMRemoveLegacyDirectory

  ; 旧快捷方式：目标指向旧目录，模板的 IsShortcutTarget 判断不会命中，直接按名字删
  Delete "$SMPROGRAMS\Pulsar Manager.lnk"
  Delete "$SMPROGRAMS\Pulsar Manager\Pulsar Manager.lnk"
  RMDir "$SMPROGRAMS\Pulsar Manager"
  Delete "$DESKTOP\Pulsar Manager.lnk"

  StrCpy $R8 "Pulsar Manager"
  Call PMRemoveLegacyUninstallEntries
!macroend

; ---------------------------------------------------------------------------
; 安装
; ---------------------------------------------------------------------------
!macro NSIS_HOOK_PREINSTALL
  StrCpy $PmHadPreviousInstall 0
  IfFileExists "$INSTDIR\${MAINBINARYNAME}.exe" 0 pm_pre_no_exe
  StrCpy $PmHadPreviousInstall 1
  Goto pm_pre_check_registry
pm_pre_no_exe:
  ; 旧 Rust 版把可执行文件叫 pulsar-manager.exe，迁移期要能认出来
  IfFileExists "$INSTDIR\pulsar-manager.exe" 0 pm_pre_check_registry
  StrCpy $PmHadPreviousInstall 1
pm_pre_check_registry:
  ReadRegStr $R0 SHCTX "${UNINSTKEY}" "InstallLocation"
  StrCmp $R0 "" pm_pre_clean_legacy
  StrCpy $PmHadPreviousInstall 1
pm_pre_clean_legacy:
  !insertmacro PM_PRE_CLEAN_LEGACY
!macroend

; 升级时（尤其是应用内更新），旧版本可能没走卸载流程，$INSTDIR 里会留下
; 上一版的 exe / dll / resources。安装目录归安装程序所有，除本次写进去的
; 主程序与卸载器外全部清掉。
!macro NSIS_HOOK_POSTINSTALL
  ; 只在升级时清；全新安装即使选了非空目录也不动用户的文件
  StrCmp $PmHadPreviousInstall 1 0 pm_stale_skip
  FindFirst $R0 $R1 "$INSTDIR\*.*"
pm_stale_loop:
  StrCmp $R1 "" pm_stale_done
  StrCmp $R1 "." pm_stale_next
  StrCmp $R1 ".." pm_stale_next
  StrCmp $R1 "${MAINBINARYNAME}.exe" pm_stale_next
  StrCmp $R1 "uninstall.exe" pm_stale_next
  IfFileExists "$INSTDIR\$R1\*.*" 0 pm_stale_file
  RMDir /r "$INSTDIR\$R1"
  Goto pm_stale_next
pm_stale_file:
  Delete "$INSTDIR\$R1"
  RMDir "$INSTDIR\$R1"
pm_stale_next:
  FindNext $R0 $R1
  Goto pm_stale_loop
pm_stale_done:
  FindClose $R0
pm_stale_skip:
!macroend

; ---------------------------------------------------------------------------
; 卸载
; ---------------------------------------------------------------------------
; 卸载前不做旧 Electron 版清理：它已经在本产品安装/升级时清过一次；
; 若没清过，说明用户是"新装"，那份旧安装不属于本次卸载的对象。
; 这里留一个空钩子，保持四个钩子的形状完整。
!macro NSIS_HOOK_PREUNINSTALL
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; 模板只 Delete 主程序 + uninstall.exe 再 RMDir，目录里有任何残留就删不掉。
  ; 这里是卸载的最后一步，直接整目录清干净。
  RMDir /r "$INSTDIR"

  ; 快捷方式兜底：旧版本/自定义安装目录留下的同名快捷方式
  Delete "$SMPROGRAMS\Pulsar Manager.lnk"
  Delete "$SMPROGRAMS\Pulsar Manager\Pulsar Manager.lnk"
  RMDir "$SMPROGRAMS\Pulsar Manager"
  Delete "$DESKTOP\Pulsar Manager.lnk"

  ; 安装位置、卸载信息与自启动项都只描述"安装"，和用户数据无关，卸载后必须删。
  ; 模板只在勾选删除应用数据时才删 MANUPRODUCTKEY，这里无条件清。
  DeleteRegKey SHCTX "${MANUPRODUCTKEY}"
  DeleteRegKey /ifempty SHCTX "${MANUKEY}"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCTNAME}"

  ; 是否保留用户文件由卸载确认页的"删除应用程序数据"勾选框决定（默认不勾 = 保留）。
  ; 勾选后把本应用真正使用的数据目录一起删掉：数据库、运行时日志、加密密钥都在
  ; %APPDATA%\pulsar-manager（从 Electron 版沿用），Tauri 模板只认 ${BUNDLEID}。
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    RMDir /r "$APPDATA\pulsar-manager"
    RMDir /r "$LOCALAPPDATA\pulsar-manager"
    DeleteRegKey HKCU "Software\com.pulsarmanager.desktop"
    DeleteRegKey HKCU "Software\pulsar-manager"
  ${EndIf}
!macroend
