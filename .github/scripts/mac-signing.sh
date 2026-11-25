# Sourced by the release workflow's packaging steps, and only there: the Mac signing and
# notarization credentials exist for the one command that packages. Written to $GITHUB_ENV
# before `npm ci` they reached every dependency's install script, the checks and the build.
# Absent secrets (a fork) turn identity auto-discovery off, so the build falls through to
# unsigned and notarization is skipped. Auto-discovery stays ON when CSC_LINK is set: it is how
# electron-builder finds the imported certificate in its temporary keychain.
if [ "$RUNNER_OS" = "macOS" ]; then
  if [ -n "$MAC_CERT_P12" ]; then
    export CSC_LINK="$MAC_CERT_P12" CSC_KEY_PASSWORD="$MAC_CERT_PASSWORD"
  else
    export CSC_IDENTITY_AUTO_DISCOVERY=false
  fi
  if [ -n "$APPLE_API_KEY_P8" ]; then
    printf '%s\n' "$APPLE_API_KEY_P8" > "$RUNNER_TEMP/apple_api_key.p8"
    trap 'rm -f "$RUNNER_TEMP/apple_api_key.p8"' EXIT
    export APPLE_API_KEY="$RUNNER_TEMP/apple_api_key.p8" APPLE_API_KEY_ID="$APPLE_API_KEY_ID"
    export APPLE_API_ISSUER="$APPLE_API_ISSUER_ID"
  fi
fi
