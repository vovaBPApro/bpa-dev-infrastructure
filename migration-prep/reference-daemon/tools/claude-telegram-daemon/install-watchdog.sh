#!/usr/bin/env bash
# Install/refresh the external orchestrator watchdog under launchd (user agent).
# Idempotent: safe to re-run after editing the script or plist.
#
#   ./install-watchdog.sh            # install + load + start
#   ./install-watchdog.sh uninstall  # unload + remove
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL="com.bpa.orchestrator-watchdog"
PLIST_SRC="$SCRIPT_DIR/$LABEL.plist"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"
RUNTIME_SCRIPT="$HOME/.claude/channels/telegram/daemon/orchestrator-watchdog.sh"
UID_NUM="$(id -u)"

unload() {
  launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || launchctl unload "$PLIST_DST" 2>/dev/null || true
}

if [ "${1:-}" = "uninstall" ]; then
  unload
  rm -f "$PLIST_DST"
  echo "watchdog uninstalled"
  exit 0
fi

# Ensure the runtime script exists and is executable.
if [ ! -f "$RUNTIME_SCRIPT" ]; then
  echo "ERROR: runtime watchdog script missing at $RUNTIME_SCRIPT" >&2
  echo "Sync the daemon files to runtime first." >&2
  exit 1
fi
chmod +x "$RUNTIME_SCRIPT"

mkdir -p "$(dirname "$PLIST_DST")"
cp "$PLIST_SRC" "$PLIST_DST"

unload
# bootstrap is the modern loader; fall back to legacy load on older macOS.
launchctl bootstrap "gui/$UID_NUM" "$PLIST_DST" 2>/dev/null || launchctl load "$PLIST_DST"
launchctl enable "gui/$UID_NUM/$LABEL" 2>/dev/null || true
launchctl kickstart -k "gui/$UID_NUM/$LABEL" 2>/dev/null || true

echo "watchdog installed and started ($LABEL, every 600s)."
echo "logs: ~/.claude/channels/telegram/daemon/runtime/watchdog.log"
echo "pause: touch ~/.claude/channels/telegram/daemon/runtime/orchestrator-done"
echo "resume: rm ~/.claude/channels/telegram/daemon/runtime/orchestrator-done"
