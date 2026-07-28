#!/usr/bin/env bash
# Install the one-shot morning report timer. Safe to rerun.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_NAME="${ORCH_MORNING_UNIT:-orch-morning-report}"
UNIT_DIR="${ORCH_SYSTEMD_USER_DIR:-$HOME/.config/systemd/user}"
MARKER='# managed by orchestrator/install-morning-timer.sh'
SERVICE="$UNIT_DIR/$UNIT_NAME.service"
TIMER="$UNIT_DIR/$UNIT_NAME.timer"

usage() { printf '%s\n' 'Usage: install-morning-timer.sh [install|uninstall|--help]'; }
case "${1:-install}" in
  -h|--help|help) usage; exit 0 ;;
  uninstall)
    if command -v systemctl >/dev/null 2>&1; then systemctl --user disable --now "$UNIT_NAME.timer" 2>/dev/null || true; fi
    rm -f "$SERVICE" "$TIMER"
    if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then systemctl --user daemon-reload; fi
    printf 'uninstalled: %s\n' "$UNIT_NAME"; exit 0 ;;
  install) ;;
  *) usage >&2; exit 2 ;;
esac

mkdir -p "$UNIT_DIR"
tmp_service="$(mktemp "$UNIT_DIR/.${UNIT_NAME}.service.XXXXXX")"
tmp_timer="$(mktemp "$UNIT_DIR/.${UNIT_NAME}.timer.XXXXXX")"
trap 'rm -f "$tmp_service" "$tmp_timer"' EXIT
printf '%s\n[Unit]\nDescription=BPA morning readiness report\n\n[Service]\nType=oneshot\nExecStart=%s/morning.sh\n' "$MARKER" "$SCRIPT_DIR" > "$tmp_service"
printf '%s\n[Unit]\nDescription=Timer for BPA morning readiness report\n\n[Timer]\nOnCalendar=*-*-* 07:40:00 Europe/Warsaw\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n' "$MARKER" > "$tmp_timer"
mv -f "$tmp_service" "$SERVICE"
mv -f "$tmp_timer" "$TIMER"
if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  systemctl --user daemon-reload
  systemctl --user enable --now "$UNIT_NAME.timer"
  printf 'installed: %s (07:40 Europe/Warsaw)\n' "$UNIT_NAME"
else
  printf 'rendered: %s and %s\n' "$SERVICE" "$TIMER"
  printf 'activate when a user-systemd session is available: systemctl --user daemon-reload && systemctl --user enable --now %s.timer\n' "$UNIT_NAME"
fi
