; Custom NSIS include (electron-builder `nsis.include`).
;
; WHY THIS EXISTS: an electron-builder NSIS install can SILENTLY HALF-COMPLETE.
; The generated installer extracts the app payload with `Nsis7z::Extract` and
; NEVER CHECKS THE RESULT — the `Pop` after it is just restoring $OUTDIR — then
; copies whatever landed in the temp dir to the install directory and reports
; success. If the extraction stops part way, the user gets an install that
; looks finished, a working Start-menu shortcut, an entry in Apps & features,
; and an application that cannot start because its .exe was never written.
;
; Live-hit 2026-08-03 on Windows 11 ARM: every non-executable file arrived and
; the whole executable tail was missing. That tail is contiguous in the
; archive because 7z groups by file type, so a truncated extraction takes out
; the .exe and every .dll together and leaves the .pak/.dat/.bin files intact
; — which reads like something deliberately eating binaries, and cost most of
; a debugging session before the stored-order listing showed what it was.
; Windows then offered to "fix" the dead shortcut by pointing it at an
; unrelated Microsoft binary, which is its own hazard.
;
; The fix here does not attempt to explain the extraction failure. It makes
; the installer HONEST: if the app executable is not on disk when the install
; claims to be done, say so plainly and fail, instead of handing over a
; broken installation with a friendly shortcut on the desktop. That is the
; app's standing rule about failure paths, applied to the installer.

!macro customInstall
  ${ifNot} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    DetailPrint "Install verification FAILED: $INSTDIR\${APP_EXECUTABLE_FILENAME} is missing."
    ; /SD IDOK keeps silent installs (CI, `/S`) non-interactive; the non-zero
    ; abort is what the smoke job asserts on.
    MessageBox MB_OK|MB_ICONSTOP "TastyTunes did not install correctly.$\n$\nThe application file could not be written, so the install has been stopped rather than leaving you a shortcut that does nothing. This is usually a lack of free disk space, or security software interrupting the installer.$\n$\nNo files have been left behind." /SD IDOK
    ; Take the half-written install with us — a partial directory plus
    ; shortcuts is exactly the state that misleads.
    RMDir /r "$INSTDIR"
    Delete "$DESKTOP\${PRODUCT_FILENAME}.lnk"
    Delete "$SMPROGRAMS\${PRODUCT_FILENAME}.lnk"
    SetErrorLevel 2
    Abort "Install verification failed"
  ${endIf}
  DetailPrint "Install verified: ${APP_EXECUTABLE_FILENAME} is present."
!macroend
