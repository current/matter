#!/bin/bash
# Started detached by ship-local.mjs --install: quits the live mattr app, moves the old bundle to
# the Trash, installs the new one as /Applications/mattr.app and opens it.
# Usage: ship-local-install.sh <staged .app> <bundle id>
set -u
NEW_APP="$1"
BUNDLE_ID="$2"
DEST="/Applications/mattr.app"
APP_PATTERN='^/Applications/(Antimatter|mattr)\.app/Contents/MacOS/'
log() { echo "[$(date +%T)] $*"; }

sleep "${QUIT_DELAY:-20}"
if pgrep -f "$APP_PATTERN" >/dev/null; then
  log "quitting $BUNDLE_ID"
  osascript -e "tell application id \"$BUNDLE_ID\" to quit" || true
  for _ in $(seq 1 120); do
    pgrep -f "$APP_PATTERN" >/dev/null || break
    sleep 1
  done
  if pgrep -f "$APP_PATTERN" >/dev/null; then
    log "the app did not quit; nothing was changed"
    exit 1
  fi
fi

for old in /Applications/Antimatter.app "$DEST"; do
  if [ -d "$old" ]; then
    log "moving $old to the Trash"
    mv "$old" "$HOME/.Trash/$(basename "$old" .app)-$(date +%Y%m%d%H%M%S).app"
  fi
done
log "installing $DEST"
ditto "$NEW_APP" "$DEST"
log "opening $DEST"
open "$DEST"
