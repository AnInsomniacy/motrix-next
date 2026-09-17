; Rayburst Native Messaging registration and icon refresh.

!macro NSIS_HOOK_POSTINSTALL
  ; Register the allowlisted, activation-only native messaging host.
  WriteRegStr SHCTX \
    "Software\Google\Chrome\NativeMessagingHosts\dev.aninsomniacy.rayburst.browser" \
    "" "$INSTDIR\native-messaging\manifests\chromium.json"
  WriteRegStr SHCTX \
    "Software\Microsoft\Edge\NativeMessagingHosts\dev.aninsomniacy.rayburst.browser" \
    "" "$INSTDIR\native-messaging\manifests\chromium.json"
  WriteRegStr SHCTX \
    "Software\Mozilla\NativeMessagingHosts\dev.aninsomniacy.rayburst.browser" \
    "" "$INSTDIR\native-messaging\manifests\firefox.json"

  ; Flush Windows icon cache so updated icons appear immediately.
  ; ie4uinit.exe is a built-in Windows 10/11 system utility that
  ; soft-refreshes the shell icon display without requiring a reboot.
  ; This is the industry-standard approach used by Electron, VS Code,
  ; and other major desktop applications.
  nsExec::ExecToLog 'ie4uinit.exe -show'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Remove only registrations that still belong to this installation.
  ReadRegStr $R0 SHCTX \
    "Software\Google\Chrome\NativeMessagingHosts\dev.aninsomniacy.rayburst.browser" ""
  ${If} $R0 == "$INSTDIR\native-messaging\manifests\chromium.json"
    DeleteRegKey SHCTX \
      "Software\Google\Chrome\NativeMessagingHosts\dev.aninsomniacy.rayburst.browser"
  ${EndIf}
  ReadRegStr $R0 SHCTX \
    "Software\Microsoft\Edge\NativeMessagingHosts\dev.aninsomniacy.rayburst.browser" ""
  ${If} $R0 == "$INSTDIR\native-messaging\manifests\chromium.json"
    DeleteRegKey SHCTX \
      "Software\Microsoft\Edge\NativeMessagingHosts\dev.aninsomniacy.rayburst.browser"
  ${EndIf}
  ReadRegStr $R0 SHCTX \
    "Software\Mozilla\NativeMessagingHosts\dev.aninsomniacy.rayburst.browser" ""
  ${If} $R0 == "$INSTDIR\native-messaging\manifests\firefox.json"
    DeleteRegKey SHCTX \
      "Software\Mozilla\NativeMessagingHosts\dev.aninsomniacy.rayburst.browser"
  ${EndIf}

  ; Runtime repair writes HKCU even for per-machine installs.
  ReadRegStr $R0 HKCU \
    "Software\Google\Chrome\NativeMessagingHosts\dev.aninsomniacy.rayburst.browser" ""
  ${If} $R0 == "$INSTDIR\native-messaging\manifests\chromium.json"
    DeleteRegKey HKCU \
      "Software\Google\Chrome\NativeMessagingHosts\dev.aninsomniacy.rayburst.browser"
  ${EndIf}
  ReadRegStr $R0 HKCU \
    "Software\Microsoft\Edge\NativeMessagingHosts\dev.aninsomniacy.rayburst.browser" ""
  ${If} $R0 == "$INSTDIR\native-messaging\manifests\chromium.json"
    DeleteRegKey HKCU \
      "Software\Microsoft\Edge\NativeMessagingHosts\dev.aninsomniacy.rayburst.browser"
  ${EndIf}
  ReadRegStr $R0 HKCU \
    "Software\Mozilla\NativeMessagingHosts\dev.aninsomniacy.rayburst.browser" ""
  ${If} $R0 == "$INSTDIR\native-messaging\manifests\firefox.json"
    DeleteRegKey HKCU \
      "Software\Mozilla\NativeMessagingHosts\dev.aninsomniacy.rayburst.browser"
  ${EndIf}
!macroend
