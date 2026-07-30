#!/usr/bin/env bash
# Install the one-shot watchdog as a user timer. Safe to rerun.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_NAME="${ORCH_WATCHDOG_UNIT:-orch-runtime-watchdog}"
UNIT_DIR="${ORCH_SYSTEMD_USER_DIR:-$HOME/.config/systemd/user}"
# Same one knob watchdog.sh resolves, same deprecated alias, same default — the
# installer and the tick it installs must never disagree about the cadence.
INTERVAL="${ORCH_WATCHDOG_INTERVAL:-${ORCH_WATCHDOG_INTERVAL_SECONDS:-60}}"
MARKER='# managed by orchestrator/install-watchdog.sh'
SERVICE="$UNIT_DIR/$UNIT_NAME.service"
TIMER="$UNIT_DIR/$UNIT_NAME.timer"

usage() { printf '%s\n' 'Usage: install-watchdog.sh [install|uninstall|--help]'; }
case "${1:-install}" in
  -h|--help|help) usage; exit 0 ;;
  uninstall)
    systemctl --user disable --now "$UNIT_NAME.timer" 2>/dev/null || true
    rm -f "$SERVICE" "$TIMER"
    systemctl --user daemon-reload
    printf 'uninstalled: %s\n' "$UNIT_NAME"
    exit 0
    ;;
  install) ;;
  *) usage >&2; exit 2 ;;
esac
mkdir -p "$UNIT_DIR"
tmp_service="$(mktemp "$UNIT_DIR/.${UNIT_NAME}.service.XXXXXX")"
tmp_timer="$(mktemp "$UNIT_DIR/.${UNIT_NAME}.timer.XXXXXX")"
trap 'rm -f "$tmp_service" "$tmp_timer"' EXIT
{
  printf '%s\n[Unit]\nDescription=Orchestrator runtime watchdog\n\n[Service]\nType=oneshot\nExecStart=%s/watchdog.sh\n' "$MARKER" "$SCRIPT_DIR"
} > "$tmp_service"
{
  printf '%s\n[Unit]\nDescription=Timer for orchestrator runtime watchdog\n\n[Timer]\nOnBootSec=30\nOnUnitActiveSec=%s\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n' "$MARKER" "$INTERVAL"
} > "$tmp_timer"
mv "$tmp_service" "$SERVICE"
mv "$tmp_timer" "$TIMER"
systemctl --user daemon-reload
systemctl --user enable --now "$UNIT_NAME.timer"
printf 'installed: %s (every %ss)\n' "$UNIT_NAME" "$INTERVAL"
