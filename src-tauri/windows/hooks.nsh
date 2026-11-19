!macro FluxAddContextMenu ext
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.${ext}\shell\FLUX.Convert" "" "Convert with FLUX"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.${ext}\shell\FLUX.Convert" "Icon" "$INSTDIR\flux.exe"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.${ext}\shell\FLUX.Convert" "Position" "Top"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.${ext}\shell\FLUX.Convert\command" "" "$\"$INSTDIR\flux.exe$\" --convert $\"%1$\""
!macroend

!macro FluxRemoveContextMenu ext
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.${ext}\shell\FLUX.Convert"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro FluxAddContextMenu png
  !insertmacro FluxAddContextMenu jpg
  !insertmacro FluxAddContextMenu jpeg
  !insertmacro FluxAddContextMenu webp
  !insertmacro FluxAddContextMenu bmp
  !insertmacro FluxAddContextMenu json
  !insertmacro FluxAddContextMenu csv
  !insertmacro FluxAddContextMenu xml
  !insertmacro FluxAddContextMenu txt
  !insertmacro FluxAddContextMenu md
  !insertmacro FluxAddContextMenu yaml
  !insertmacro FluxAddContextMenu yml
  !insertmacro FluxAddContextMenu pdf
  !insertmacro FluxAddContextMenu docx
  !insertmacro FluxAddContextMenu pptx
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "FLUX" "$\"$INSTDIR\flux.exe$\""
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "$INSTDIR\Register-ShellExtension.ps1" -InstallRoot "$INSTDIR"' $0
  IfSilent fluxShellRegistrationComplete
  StrCmp $0 "0" fluxShellRegistrationComplete
  MessageBox MB_ICONEXCLAMATION|MB_OK "FLUX was installed, but Windows could not register the compact File Explorer menu. The legacy menu entry is still available under Show more options. See $LOCALAPPDATA\FLUX\shell-extension-install.log for details."
fluxShellRegistrationComplete:
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "$INSTDIR\Unregister-ShellExtension.ps1" -InstallRoot "$INSTDIR"' $0
  !insertmacro FluxRemoveContextMenu png
  !insertmacro FluxRemoveContextMenu jpg
  !insertmacro FluxRemoveContextMenu jpeg
  !insertmacro FluxRemoveContextMenu webp
  !insertmacro FluxRemoveContextMenu bmp
  !insertmacro FluxRemoveContextMenu json
  !insertmacro FluxRemoveContextMenu csv
  !insertmacro FluxRemoveContextMenu xml
  !insertmacro FluxRemoveContextMenu txt
  !insertmacro FluxRemoveContextMenu md
  !insertmacro FluxRemoveContextMenu yaml
  !insertmacro FluxRemoveContextMenu yml
  !insertmacro FluxRemoveContextMenu pdf
  !insertmacro FluxRemoveContextMenu docx
  !insertmacro FluxRemoveContextMenu pptx
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "FLUX"
!macroend
