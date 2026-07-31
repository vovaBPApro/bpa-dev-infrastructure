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
# A lane installer must point the persistent unit at the canonical checkout,
# not at its short-lived worktree. git-common-dir is the canonical .git dir for
# both ordinary clones and linked worktrees.
GIT_COMMON_DIR="$(git -C "$SCRIPT_DIR/.." rev-parse --path-format=absolute --git-common-dir)"
REPO_DIR="${ORCH_REPO_DIR:-$(dirname "$GIT_COMMON_DIR")}"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib.sh"

UNIT_NAME="${ORCH_MEMORY_SWEEP_UNIT:-orch-memory-sweep}"
UNIT_DIR="${ORCH_SYSTEMD_USER_DIR:-$HOME/.config/systemd/user}"
MARKER='# managed by orchestrator/install-memory-sweep.sh'
SERVICE="$UNIT_DIR/$UNIT_NAME.service"
TIMER="$UNIT_DIR/$UNIT_NAME.timer"
SWEEP_TS="${ORCH_MEMORY_SWEEP_TS:-tools/instructions/memory-sweep.ts}"
ON_CALENDAR="${ORCH_MEMORY_SWEEP_ONCALENDAR:-*-*-* 04:30:00}"
SYSTEMCTL_BIN="${ORCH_SYSTEMCTL_BIN:-$(command -v systemctl || true)}"

# Non-login automation may not inherit the user-bus environment even while the
# user manager is live. Reconstruct the standard local address when available.
runtime_dir="/run/user/$(id -u)"
if [[ -S "$runtime_dir/bus" ]]; then
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-$runtime_dir}"
  export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$runtime_dir/bus}"
fi

usage() { printf '%s\n' 'Usage: install-memory-sweep.sh [install|uninstall|--help]'; }
case "${1:-install}" in
  -h|--help|help) usage; exit 0 ;;
  uninstall)
    if [[ -n "$SYSTEMCTL_BIN" ]]; then "$SYSTEMCTL_BIN" --user disable --now "$UNIT_NAME.timer" 2>/dev/null || true; fi
    rm -f "$SERVICE" "$TIMER"
    if [[ -n "$SYSTEMCTL_BIN" ]] && "$SYSTEMCTL_BIN" --user show-environment >/dev/null 2>&1; then "$SYSTEMCTL_BIN" --user daemon-reload; fi
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
if [[ -n "$SYSTEMCTL_BIN" ]] && "$SYSTEMCTL_BIN" --user show-environment >/dev/null 2>&1; then
  "$SYSTEMCTL_BIN" --user daemon-reload
  "$SYSTEMCTL_BIN" --user enable --now "$UNIT_NAME.timer"
  printf 'installed: %s (%s)\n' "$UNIT_NAME" "$ON_CALENDAR"
else
  printf 'rendered: %s and %s\n' "$SERVICE" "$TIMER"
  printf 'activate when a user-systemd session is available: systemctl --user daemon-reload && systemctl --user enable --now %s.timer\n' "$UNIT_NAME"
fi
