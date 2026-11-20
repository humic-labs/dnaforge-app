;  — Windows NSIS install breadcrumbs + best-effort phone-home beacons.
; Write failures / beacon failures must never stop the install. No compile-time failure paths.
;
; Primary:  $LOCALAPPDATA\DNAForge\logs\install.log
; Dual-write (init only): $EXEDIR\dnaforge-install.log
; Beacon: POST https://dnaforge.com/api/diagnostics/install-beacon (PowerShell, best-effort)
;
; Line contract (schema=1), example:
;   schema=1 event=init ts=2026-07-08T14:30:01 version=0.3.0 attempt=... instdir=... exepath=...

!ifndef VERSION
  !define VERSION "unknown"
!endif

!ifndef DNAFORGE_DIAGNOSTICS_BASE
  !define DNAFORGE_DIAGNOSTICS_BASE "https://dnaforge.com"
!endif

; Read once while makensis compiles Setup.exe. Runtime environment variables
; cannot relabel a packaged installer after these literals are embedded.
!ifndef DNAFORGE_BUILD_TAG
  !define DNAFORGE_BUILD_TAG "$%DNAFORGE_BUILD_TAG%"
!endif

!ifndef DNAFORGE_RELEASE_CHANNEL
  !define DNAFORGE_RELEASE_CHANNEL "$%DNAFORGE_RELEASE_CHANNEL%"
!endif

; FileFunc helpers used by the write/build macros. Safe to include here —
; electron-builder's multiUser.nsh also includes FileFunc.nsh (idempotent).
!include "FileFunc.nsh"
!include "LogicLib.nsh"
!include "file-associations.generated.nsh"
!insertmacro GetTime
!insertmacro GetParent

; Move the installation as one directory. The default per-file Rename fails
; on bundled paths beyond MAX_PATH and restores the old app before returning 2.
; A sibling destination stays on the installation volume. User profiles live
; outside INSTDIR and are not part of this operation.
!macro customRemoveFiles
  SetOutPath "$TEMP"
  ${If} ${isUpdated}
    Push $0
    Push $R0
    Push $R1
    ${GetParent} "$INSTDIR" $R0
    ClearErrors
    GetTempFileName $R1 "$R0"
    ${IfNot} ${Errors}
      Delete "$R1"
    ${EndIf}
    ${If} ${Errors}
      SetErrorLevel 2
      Abort "Cannot reserve the previous-installation directory; installation preserved."
    ${EndIf}
    System::Call 'kernel32::MoveFileW(w "\\?\$INSTDIR", w "\\?\$R1") i.r0'
    ${If} $0 == 0
      SetErrorLevel 2
      Abort "Cannot move the previous installation; installation preserved."
    ${EndIf}
    RMDir /r "\\?\$R1"
    ${If} ${Errors}
      DetailPrint "Previous installation cleanup remains at $R1."
    ${EndIf}
    Pop $R1
    Pop $R0
    Pop $0
  ${Else}
    RMDir /r "\\?\$INSTDIR"
  ${EndIf}
  ClearErrors
!macroend

; A replacement candidate must not depend on deletion code embedded in the version
; it is replacing. Older shipped uninstallers can time out while traversing the
; large application tree, and any candidate-version allowlist eventually stops
; protecting users who skip releases. app-builder-lib invokes
; customPrepareUpdate after CHECK_APP_RUNNING and before uninstallOldVersion.
; Validate every registry scope before moving anything. Once all populated
; scopes point at the candidate's installation directory, move that directory
; exactly once and suppress only those validated uninstall commands. This keeps
; a second registry scope from invoking a fallible old uninstaller after the
; first scope has already moved the live application. The pinned app-builder
; template skips the predecessor uninstaller only after this hook has prepared
; that registered directory. Fresh installs and moves to another installation
; directory retain electron-builder's ordinary installation behavior.
!macro DNAForgeValidateUpdaterRegistration rootKey stateVar
  !define DNAFORGE_VALIDATE_UID ${__COUNTER__}
  Push $R0
  Push $R1
  Push $R2
  StrCpy ${stateVar} "none"

  ClearErrors
  ReadRegStr $R0 ${rootKey} "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
  ReadRegStr $R1 ${rootKey} "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  ReadRegStr $R2 ${rootKey} "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
  ${If} $R0 == ""
  ${AndIf} $R1 == ""
  ${AndIf} $R2 == ""
    DetailPrint "No usable DNAForge uninstall registration exists in this registry scope."
    Goto dnaforge_validate_done_${DNAFORGE_VALIDATE_UID}
  ${EndIf}
  ${If} $R0 == ""
    StrCpy $R0 "unknown"
  ${EndIf}
  ${If} $R1 == ""
    DetailPrint "Registered DNAForge v$R0 has no verifiable installation directory. Retaining its normal uninstaller."
    Goto dnaforge_validate_failed_${DNAFORGE_VALIDATE_UID}
  ${EndIf}
  ${If} $R1 != "$INSTDIR"
    DetailPrint "Registered DNAForge v$R0 uses a different installation directory. Refusing to move either installation."
    Goto dnaforge_validate_failed_${DNAFORGE_VALIDATE_UID}
  ${EndIf}
  StrCpy ${stateVar} "same"
  Goto dnaforge_validate_done_${DNAFORGE_VALIDATE_UID}

  dnaforge_validate_failed_${DNAFORGE_VALIDATE_UID}:
    Exec '"$INSTDIR\DNAForge.exe" --update-retry-failed'
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONEXCLAMATION|MB_TOPMOST "DNAForge could not safely identify the previous installation. DNAForge will reopen. Choose Restart now again. If it still fails, install the current release from https://dnaforge.com/download."
    ${EndIf}
    SetErrorLevel 2
    Abort "Cannot verify the previous-installation registration. Installation preserved and DNAForge reopened."

  dnaforge_validate_done_${DNAFORGE_VALIDATE_UID}:
  Pop $R2
  Pop $R1
  Pop $R0
  !undef DNAFORGE_VALIDATE_UID
!macroend

!macro DNAForgeQuarantineUpdaterDirectory
  !define DNAFORGE_QUARANTINE_UID ${__COUNTER__}
  Push $R2
  Push $R3
  Push $R4
  Push $R5

  ; .onInit enters $INSTDIR before this hook runs. Leave it first so Windows
  ; does not treat this installer as a process holding the directory open.
  SetOutPath "$TEMP"
  StrCpy $dnaforgeUpdaterDirectoryState "unverified"
  StrCpy $R3 ""
  System::Call 'kernel32::GetFileAttributesW(w "\\?\$INSTDIR") i.r15 ?e'
  Pop $R4
  ${If} $R5 == -1
    ${If} $R4 == 2
    ${OrIf} $R4 == 3
      StrCpy $dnaforgeUpdaterDirectoryState "absent"
      Goto dnaforge_quarantine_safe_${DNAFORGE_QUARANTINE_UID}
    ${Else}
      Goto dnaforge_quarantine_prepare_failed_${DNAFORGE_QUARANTINE_UID}
    ${EndIf}
  ${EndIf}

  IntOp $R5 $R5 & 0x10
  ${If} $R5 == 0
    Goto dnaforge_quarantine_prepare_failed_${DNAFORGE_QUARANTINE_UID}
  ${EndIf}

  ${GetParent} "$INSTDIR" $R2
  ClearErrors
  GetTempFileName $R3 "$R2"
  ${IfNot} ${Errors}
    Delete "$R3"
  ${EndIf}
  ${If} ${Errors}
    Goto dnaforge_quarantine_prepare_failed_${DNAFORGE_QUARANTINE_UID}
  ${EndIf}

  ; v0.8.10 field evidence showed waypoint-api.exe releasing INSTDIR 13.8s
  ; after quitAndInstall began. Keep the candidate-owned move bounded at 30s.
  StrCpy $R4 0
  dnaforge_quarantine_retry_${DNAFORGE_QUARANTINE_UID}:
    IntOp $R4 $R4 + 1
    ClearErrors
    System::Call 'kernel32::MoveFileW(w "\\?\$INSTDIR", w "\\?\$R3") i.r15'
    ${If} $R5 != 0
      Goto dnaforge_quarantine_moved_${DNAFORGE_QUARANTINE_UID}
    ${EndIf}
    ${If} $R4 < 60
      Sleep 500
      Goto dnaforge_quarantine_retry_${DNAFORGE_QUARANTINE_UID}
    ${EndIf}
    Exec '"$INSTDIR\DNAForge.exe" --update-retry-failed'
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONEXCLAMATION|MB_TOPMOST "DNAForge could not replace the previous installation. DNAForge will reopen. Choose Restart now again. If it still fails, install the current release from https://dnaforge.com/download."
    ${EndIf}
    SetErrorLevel 2
    Abort "Cannot move the previous installation after 30 seconds. Installation preserved and DNAForge reopened."

  dnaforge_quarantine_prepare_failed_${DNAFORGE_QUARANTINE_UID}:
    Exec '"$INSTDIR\DNAForge.exe" --update-retry-failed'
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONEXCLAMATION|MB_TOPMOST "DNAForge could not safely identify and prepare the previous installation. DNAForge will reopen. Choose Restart now again. If it still fails, install the current release from https://dnaforge.com/download."
    ${EndIf}
    SetErrorLevel 2
    Abort "Cannot verify the previous-installation directory. Installation preserved and DNAForge reopened."

  dnaforge_quarantine_moved_${DNAFORGE_QUARANTINE_UID}:
    DetailPrint "Quarantined the previous DNAForge installation before installing ${VERSION}."
    StrCpy $dnaforgeUpdaterQuarantine "$R3"
    StrCpy $dnaforgeUpdaterDirectoryState "moved"

  dnaforge_quarantine_safe_${DNAFORGE_QUARANTINE_UID}:
    ${If} $dnaforgeUpdaterDirectoryState == "moved"
    ${OrIf} $dnaforgeUpdaterDirectoryState == "absent"
      SetOverwrite on
      ClearErrors
    ${EndIf}

  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  !undef DNAFORGE_QUARANTINE_UID
!macroend

!macro DNAForgeSuppressUpdaterRegistration rootKey stateVar
  ${If} ${stateVar} == "same"
    ${If} $dnaforgeUpdaterDirectoryState == "moved"
    ${OrIf} $dnaforgeUpdaterDirectoryState == "absent"
      DeleteRegValue ${rootKey} "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
      DeleteRegValue ${rootKey} "${UNINSTALL_REGISTRY_KEY}" "QuietUninstallString"
      ClearErrors
    ${EndIf}
  ${EndIf}
!macroend

!macro customPrepareUpdate
  Var /GLOBAL dnaforgeUpdaterQuarantine
  Var /GLOBAL dnaforgeUpdaterDirectoryState
  Var /GLOBAL dnaforgeUpdaterPrimaryRegistration
  Var /GLOBAL dnaforgeUpdaterSecondaryRegistration
  StrCpy $dnaforgeUpdaterQuarantine ""
  StrCpy $dnaforgeUpdaterDirectoryState "unverified"
  StrCpy $dnaforgeUpdaterPrimaryRegistration "none"
  StrCpy $dnaforgeUpdaterSecondaryRegistration "none"
  ; Website downloads have no --updated marker. A manual replacement may use
  ; the same safe path only when a real registration names this exact INSTDIR.
  ; Do not move an unregistered directory merely because a user selected it.
  !define DNAFORGE_PREPARE_UID ${__COUNTER__}
  Push $R0
  ${IfNot} ${isUpdated}
    ReadRegStr $R0 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" "InstallLocation"
    ${If} $R0 != "$INSTDIR"
      StrCpy $R0 ""
      ${If} $installMode == "all"
        ReadRegStr $R0 HKEY_CURRENT_USER "${INSTALL_REGISTRY_KEY}" "InstallLocation"
      ${EndIf}
      ${If} $R0 != "$INSTDIR"
        Goto dnaforge_prepare_done_${DNAFORGE_PREPARE_UID}
      ${EndIf}
    ${EndIf}
  ${EndIf}
  !insertmacro DNAForgeValidateUpdaterRegistration SHELL_CONTEXT $dnaforgeUpdaterPrimaryRegistration
  ${If} $installMode == "all"
    !insertmacro DNAForgeValidateUpdaterRegistration HKEY_CURRENT_USER $dnaforgeUpdaterSecondaryRegistration
  ${EndIf}
  !insertmacro DNAForgeQuarantineUpdaterDirectory
  !insertmacro DNAForgeSuppressUpdaterRegistration SHELL_CONTEXT $dnaforgeUpdaterPrimaryRegistration
  ${If} $installMode == "all"
    !insertmacro DNAForgeSuppressUpdaterRegistration HKEY_CURRENT_USER $dnaforgeUpdaterSecondaryRegistration
  ${EndIf}
  dnaforge_prepare_done_${DNAFORGE_PREPARE_UID}:
  ClearErrors
  Pop $R0
  !undef DNAFORGE_PREPARE_UID
!macroend

; Shared best-effort append. Clears errors so a failed write cannot abort install.
; Unique label per expansion via __COUNTER__ (macro is inserted more than once).
!macro DNAForgeInstallLogWrite path line
  !define DNAFORGE_LOG_UID ${__COUNTER__}
  Push $R8
  Push $R9
  ClearErrors
  ${GetParent} `${path}` $R9
  ; NSIS CreateDirectory is recursive — creates DNAForge\logs when needed.
  CreateDirectory `$R9`
  ClearErrors
  FileOpen $R8 `${path}` a
  IfErrors dnaforge_install_log_write_done_${DNAFORGE_LOG_UID}
    FileSeek $R8 0 END
    FileWrite $R8 `${line}$\r$\n`
    ; FileClose flushes; there is no FileFlush instruction in NSIS 3.0.4
    ; (electron-builder's makensis). Inventing FileFlush aborts the build.
    FileClose $R8
  dnaforge_install_log_write_done_${DNAFORGE_LOG_UID}:
  ClearErrors
  Pop $R9
  Pop $R8
  !undef DNAFORGE_LOG_UID
!macroend

!macro DNAForgeInstallIdentityWrite path attemptId downloadId
  !define DNAFORGE_IDENTITY_UID ${__COUNTER__}
  Push $R8
  Push $R9
  ClearErrors
  ${GetParent} `${path}` $R9
  CreateDirectory `$R9`
  ClearErrors
  ; Remove the prior run before writing. If a lock or ACL blocks deletion,
  ; leave it untouched; the desktop rejects it unless its attempt also matches
  ; the newest install.log init line.
  Delete `${path}`
  IfErrors dnaforge_install_identity_write_done_${DNAFORGE_IDENTITY_UID}
  FileOpen $R8 `${path}` w
  IfErrors dnaforge_install_identity_write_done_${DNAFORGE_IDENTITY_UID}
    FileWrite $R8 `${attemptId}$\r$\n`
    ${If} `${downloadId}` != ""
      FileWrite $R8 `${downloadId}$\r$\n`
    ${EndIf}
    FileClose $R8
  dnaforge_install_identity_write_done_${DNAFORGE_IDENTITY_UID}:
  ClearErrors
  Pop $R9
  Pop $R8
  !undef DNAFORGE_IDENTITY_UID
!macroend

!macro DNAForgeInstallLogBuildLine event outVar
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  ; Local wall-clock: day month year weekday hour minute second
  ${GetTime} "" "L" $0 $1 $2 $3 $4 $5 $6
  StrCpy `${outVar}` "schema=1 event=${event} ts=$2-$1-$0T$4:$5:$6 version=${VERSION} attempt=$R6 instdir=$INSTDIR exepath=$EXEPATH"
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

; Best-effort HTTP beacon via a real PowerShell script (not an inline -Command).
; Inline -Command + NSIS $$ escaping repeatedly failed to phone home in CI
; (empty mock journal). Script lives in resources/ and is extracted to $PLUGINSDIR.
;
; CI override: $EXEDIR\dnaforge-diagnostics-url.txt (allowlisted in the .ps1).
!macro DNAForgeInstallBeacon event
  Push $R0
  Push $R1
  InitPluginsDir
  ; Extract once per process is fine; File is idempotent enough for our purposes.
  File "/oname=$PLUGINSDIR\dnaforge-install-beacon.ps1" "${BUILD_RESOURCES_DIR}\dnaforge-install-beacon.ps1"
  nsExec::ExecToStack 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\dnaforge-install-beacon.ps1" -DiagnosticsBase "${DNAFORGE_DIAGNOSTICS_BASE}" -Event "${event}" -AppVersion "${VERSION}" -AttemptId "$R6" -DownloadId "$R4" -DesktopBuildTag "${DNAFORGE_BUILD_TAG}" -DesktopReleaseChannel "${DNAFORGE_RELEASE_CHANNEL}" -ExeDir "$EXEDIR"'
  Pop $R0 ; exit code (ignored)
  Pop $R1 ; stdout (ignored)
  ClearErrors
  Pop $R1
  Pop $R0
!macroend

; Mid-flight breadcrumb — dual-write so support can find a file next to Setup.exe
; when LocalAppData is unavailable or the install dies before completion.
; Also mints attempt_id ($R6) and fires install_beacon event=init.
!macro customInit
  ; electron-updater v0.8.0 invokes quitAndInstall() with its default
  ; isSilent=false, which launches the candidate as `--updated --force-run`
  ; without /S. A one-click NSIS window then waits for user interaction during
  ; an unattended update. The candidate can recognize that trusted updater
  ; marker itself, so make every updated install silent before any installer
  ; work. This also protects upgrades from older callers we cannot patch.
  ${If} ${isUpdated}
    SetSilent silent
  ${EndIf}

  ; Mint a stable attempt id for this installer run into $R6.
  nsExec::ExecToStack 'powershell -NoProfile -NonInteractive -Command "[guid]::NewGuid().ToString()"'
  Pop $R0 ; exit code
  Pop $R6 ; stdout (guid) or empty
  ${If} $R6 == ""
    Push $0
    Push $1
    Push $2
    Push $3
    Push $4
    Push $5
    Push $6
    ${GetTime} "" "L" $0 $1 $2 $3 $4 $5 $6
    StrCpy $R6 "nsis-$2$1$0-$4$5$6"
    Pop $6
    Pop $5
    Pop $4
    Pop $3
    Pop $2
    Pop $1
    Pop $0
  ${EndIf}

  ; Trim CR/LF from PowerShell guid stdout (otherwise -AttemptId breaks).
  Push $R1
  StrCpy $R1 $R6 1 -1
  ${If} $R1 == "$\n"
    StrCpy $R6 $R6 -1
  ${EndIf}
  StrCpy $R1 $R6 1 -1
  ${If} $R1 == "$\r"
    StrCpy $R6 $R6 -1
  ${EndIf}
  Pop $R1

  InitPluginsDir
  File "/oname=$PLUGINSDIR\dnaforge-download-identity.ps1" "${BUILD_RESOURCES_DIR}\dnaforge-download-identity.ps1"
  nsExec::ExecToStack 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\dnaforge-download-identity.ps1" -InstallerPath "$EXEPATH"'
  Pop $R0
  Pop $R4
  Push $R1
  StrCpy $R1 $R4 1 -1
  ${If} $R1 == "$\n"
    StrCpy $R4 $R4 -1
  ${EndIf}
  StrCpy $R1 $R4 1 -1
  ${If} $R1 == "$\r"
    StrCpy $R4 $R4 -1
  ${EndIf}
  Pop $R1

  !insertmacro DNAForgeInstallIdentityWrite "$LOCALAPPDATA\DNAForge\logs\install-attempt.id" "$R6" "$R4"
  ; Beacon BEFORE install.log init line.  T2 kill-after-init watches
  ; for event=init in the log; if the beacon runs after that write, taskkill
  ; aborts PowerShell and the mock journal stays empty.
  !insertmacro DNAForgeInstallBeacon "init"
  Push $R7
  !insertmacro DNAForgeInstallLogBuildLine "init" "$R7"
  !insertmacro DNAForgeInstallLogWrite "$LOCALAPPDATA\DNAForge\logs\install.log" "$R7"
  !insertmacro DNAForgeInstallLogWrite "$EXEDIR\dnaforge-install.log" "$R7"
  Pop $R7
!macroend

; Completion marker — primary path only (plan: dual-write is critical on init).
!macro customInstall
  !if "${PRODUCT_NAME}" == "DNAForge"
    !insertmacro DNAForgeRegisterFileAssociations
  !endif
  ; Prefer $R6 from customInit; if empty, re-read persisted attempt id (best-effort).
  ${If} $R6 == ""
    Push $R0
    ClearErrors
    FileOpen $R0 "$LOCALAPPDATA\DNAForge\logs\install-attempt.id" r
    IfErrors dnaforge_attempt_read_done
      FileRead $R0 $R6
      FileClose $R0
    dnaforge_attempt_read_done:
    ClearErrors
    Pop $R0
  ${EndIf}

  Push $R7
  !insertmacro DNAForgeInstallLogBuildLine "install_complete" "$R7"
  !insertmacro DNAForgeInstallLogWrite "$LOCALAPPDATA\DNAForge\logs\install.log" "$R7"
  !insertmacro DNAForgeInstallBeacon "install_complete"
  Pop $R7

  ; Keep the previous installation recoverable until candidate extraction,
  ; registry, shortcuts, associations, and completion logging all succeed.
  ${If} $dnaforgeUpdaterQuarantine != ""
    ClearErrors
    RMDir /r "\\?\$dnaforgeUpdaterQuarantine"
    ${If} ${Errors}
      DetailPrint "Previous installation cleanup remains at $dnaforgeUpdaterQuarantine."
    ${EndIf}
    StrCpy $dnaforgeUpdaterQuarantine ""
    ClearErrors
  ${EndIf}
!macroend

; Remove only DNAForge-owned ProgIDs, capability values, and Open With entries.
; Never delete an extension key or UserChoice: those belong to Windows/the user.
!macro customUnInstall
  !if "${PRODUCT_NAME}" == "DNAForge"
    !insertmacro DNAForgeUnregisterFileAssociations
  !endif
!macroend
