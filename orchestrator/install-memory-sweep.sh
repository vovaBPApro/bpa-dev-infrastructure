#!/usr/bin/env bash
# Install the daily memory-sweep timer (INSTRUCTIONS_CONSILIUM_FINAL.md §2.5,
# F14: "a scheduled cron sweep files violations into the inbox as defects — an
# owner and a trigger, not a weekly intention"). Mirrors install-morning-timer.sh
# in style. Idempotent; safe to rerun. install | uninstall.
#
# The sweep runs tools/instructions/memory-sweep.ts against the real rules and
# memory surfaces and files any ungoverned-rule defect into this repo's
# instance/decisions/inbox.jsonl. It is non-destructive (report + file only).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib.sh"

UNIT_NAME="${ORCH_MEMORY_SWEEP_UNIT:-orch-memory-sweep}"
UNIT_DIR="${ORCH_SYSTEMD_USER_DIR:-$HOME/.config/systemd/user}"
MARKER='# managed by orchestrator/install-memory-sweep.sh'
SERVICE="$UNIT_DIR/$UNIT_NAME.service"
TIMER="$UNIT_DIR/$UNIT_NAME.timer"
SWEEP_TS="${ORCH_MEMORY_SWEEP_TS:-tools/instructions/memory-sweep.ts}"
ON_CALENDAR="${ORCH_MEMORY_SWEEP_ONCALENDAR:-*-*-* 04:30:00 Europe/Warsaw}"

usage() { printf '%s\n' 'Usage: install-memory-sweep.sh [install|uninstall|--help]'; }
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
printf '%s\n[Unit]\nDescription=BPA memory / rules governance sweep\n\n[Service]\nType=oneshot\nWorkingDirectory=%s\nExecStart=%s %s/%s --repo %s\n' \
  "$MARKER" "$REPO_DIR" "$BUN_BIN" "$REPO_DIR" "$SWEEP_TS" "$REPO_DIR" > "$tmp_service"
printf '%s\n[Unit]\nDescription=Timer for BPA memory / rules governance sweep\n\n[Timer]\nOnCalendar=%s\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n' \
  "$MARKER" "$ON_CALENDAR" > "$tmp_timer"
mv -f "$tmp_service" "$SERVICE"
mv -f "$tmp_timer" "$TIMER"
if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  systemctl --user daemon-reload
  systemctl --user enable --now "$UNIT_NAME.timer"
  printf 'installed: %s (%s)\n' "$UNIT_NAME" "$ON_CALENDAR"
else
  printf 'rendered: %s and %s\n' "$SERVICE" "$TIMER"
  printf 'activate when a user-systemd session is available: systemctl --user daemon-reload && systemctl --user enable --now %s.timer\n' "$UNIT_NAME"
fi
