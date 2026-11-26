#!/bin/bash
# Started via launchd (or detached fallback) by ship-local.mjs --install: quits the live Matter app,
# moves the old bundle to the Trash, installs /Applications/Matter.app, re-registers it, and verifies
# that the relaunched app and its local server come back healthy.
# Usage: ship-local-install.sh <staged .app> <bundle id>
set -u

if [ -n "${LOG_FILE:-}" ]; then
  exec >> "$LOG_FILE" 2>&1
fi

# Strip Electron / agent env vars as defense-in-depth so the relaunched app never inherits them.
unset ELECTRON_RUN_AS_NODE NODE_OPTIONS
for var in $(compgen -e); do
  case "$var" in
    T3_*|T3CODE_*|CLAUDE*|ANTIGRAVITY*)
      unset "$var"
      ;;
  esac
done

NEW_APP="$1"
BUNDLE_ID="$2"
DEST="/Applications/Matter.app"
APP_PATTERN='^/Applications/(Antimatter|mattr|Matter)\.app/Contents/MacOS/'
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
QUIT_DELAY_SECS="${QUIT_DELAY:-20}"
VERIFY_URL="${VERIFY_URL-http://127.0.0.1:3773/.well-known/t3/environment}"
USED_DIRECT_FALLBACK=0

log() { echo "[$(date +%T)] $*"; }

cleanup() {
  if [ -n "${PLIST_PATH:-}" ] && [ -f "$PLIST_PATH" ]; then
    rm -f "$PLIST_PATH" || true
  fi
  if [ -n "${LAUNCHD_LABEL:-}" ] && [ "$USED_DIRECT_FALLBACK" -eq 0 ]; then
    local uid
    uid="$(id -u)"
    (sleep 1; launchctl bootout "gui/${uid}/${LAUNCHD_LABEL}" >/dev/null 2>&1 || true) >/dev/null 2>&1 </dev/null &
  fi
}
trap cleanup EXIT

is_app_running() {
  pgrep -f "$APP_PATTERN" >/dev/null 2>&1
}

is_server_healthy() {
  if [ -z "$VERIFY_URL" ]; then
    return 0
  fi
  curl -sf --max-time 2 "$VERIFY_URL" >/dev/null 2>&1
}

wait_for_healthy() {
  local max_wait=20
  local elapsed=0
  while [ "$elapsed" -lt "$max_wait" ]; do
    if is_app_running && is_server_healthy; then
      return 0
    fi
    if [ "$elapsed" -ge 15 ] && [ "$max_wait" -lt 35 ] && is_app_running; then
      log "Matter process is alive; extending health check wait to 35s"
      max_wait=35
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  if is_app_running && is_server_healthy; then
    return 0
  fi
  return 1
}

run_launch_attempt() {
  local attempt="$1"
  local output=""
  local status=0
  case "$attempt" in
    1)
      log "relaunch attempt 1/4: open -a \"$DEST\""
      output="$(open -a "$DEST" 2>&1)" || status=$?
      log "attempt 1 exit=$status${output:+ output=$output}"
      ;;
    2)
      log "relaunch attempt 2/4: open -n \"$DEST\""
      output="$(open -n "$DEST" 2>&1)" || status=$?
      log "attempt 2 exit=$status${output:+ output=$output}"
      ;;
    3)
      log "relaunch attempt 3/4: open -g -n \"$DEST\""
      output="$(open -g -n "$DEST" 2>&1)" || status=$?
      log "attempt 3 exit=$status${output:+ output=$output}"
      ;;
    4)
      local bin="$DEST/Contents/MacOS/Matter"
      if [ ! -x "$bin" ]; then
        local exe_name
        exe_name="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$DEST/Contents/Info.plist" 2>/dev/null || true)"
        if [ -n "$exe_name" ] && [ -x "$DEST/Contents/MacOS/$exe_name" ]; then
          bin="$DEST/Contents/MacOS/$exe_name"
        fi
      fi
      log "relaunch attempt 4/4: direct binary fallback ($bin)"
      USED_DIRECT_FALLBACK=1
      nohup "$bin" >/dev/null 2>&1 </dev/null &
      log "attempt 4 spawned fallback pid=$!"
      ;;
  esac
}

log "scheduled install (quit delay ${QUIT_DELAY_SECS}s, staged=$NEW_APP)"

if [ ! -d "$NEW_APP" ]; then
  log "staged app not found: $NEW_APP"
  exit 1
fi

sleep "$QUIT_DELAY_SECS"

if is_app_running; then
  log "quitting $BUNDLE_ID"
  osascript -e "tell application id \"$BUNDLE_ID\" to quit" || true
  for _ in $(seq 1 120); do
    is_app_running || break
    sleep 1
  done
  if is_app_running; then
    log "the app did not quit; nothing was changed"
    exit 1
  fi
fi

if lsof -nP -iTCP:3773 -sTCP:LISTEN >/dev/null 2>&1; then
  log "waiting for port 3773 to release"
  for _ in $(seq 1 10); do
    lsof -nP -iTCP:3773 -sTCP:LISTEN >/dev/null 2>&1 || break
    sleep 1
  done
  if lsof -nP -iTCP:3773 -sTCP:LISTEN >/dev/null 2>&1; then
    log "warning: port 3773 still listening after 10s"
  fi
fi
sleep 1

for old in /Applications/Antimatter.app /Applications/mattr.app "$DEST"; do
  if [ -d "$old" ]; then
    trash_target="$HOME/.Trash/$(basename "$old" .app)-$(date +%Y%m%d%H%M%S).app"
    log "moving $old to $trash_target"
    if ! mv "$old" "$trash_target"; then
      log "failed to move $old to Trash; aborting"
      exit 1
    fi
  fi
done

log "installing $DEST"
if ! ditto "$NEW_APP" "$DEST"; then
  log "ditto failed copying $NEW_APP to $DEST; aborting"
  exit 1
fi

if xattr -p com.apple.quarantine "$DEST" >/dev/null 2>&1; then
  log "clearing com.apple.quarantine on $DEST"
  xattr -dr com.apple.quarantine "$DEST" || true
fi

log "re-registering $DEST with LaunchServices"
"$LSREGISTER" -f "$DEST" || true

for attempt in 1 2 3 4; do
  if [ "$attempt" -gt 1 ] && is_app_running; then
    log "Matter process is still running after previous attempt; skipping duplicate launch"
    break
  fi
  run_launch_attempt "$attempt"
  if wait_for_healthy; then
    pids="$(pgrep -f "$APP_PATTERN" | tr '\n' ',' | sed 's/,$//')"
    log "Matter relaunched and healthy (pid ${pids}, 127.0.0.1:3773 ready)"
    exit 0
  fi
  log "attempt $attempt did not reach healthy state"
done

log "ERROR: Matter failed to relaunch cleanly after all attempts"
log "diagnostics: pgrep -fl:"
pgrep -fl "$APP_PATTERN" || log "  (no matching processes)"
log "diagnostics: ls -ld \"$DEST\":"
ls -ld "$DEST" || true
log "diagnostics: lsof port 3773:"
lsof -nP -iTCP:3773 -sTCP:LISTEN || log "  (port 3773 not listening)"
exit 1
