#!/usr/bin/env bash
# Install the one-shot watchdog as a user timer. Safe to rerun.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/knobs.sh"
UNIT_NAME="${ORCH_WATCHDOG_UNIT:-orch-runtime-watchdog}"
UNIT_DIR="${ORCH_SYSTEMD_USER_DIR:-$HOME/.config/systemd/user}"
# Same one knob watchdog.sh resolves, same deprecated alias, same default — the
# installer and the tick it installs must never disagree about the cadence.
# `-` rather than `:-` on purpose: a knob SET to the empty string is a
# misconfiguration the central parser must see and refuse, not a silent
# fallback to the default.
INTERVAL="${ORCH_WATCHDOG_INTERVAL-${ORCH_WATCHDOG_INTERVAL_SECONDS-60}}"
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
# Fail-closed BEFORE any unit file is written. The interval is interpolated
# into a systemd unit verbatim, so an unvalidated value is both a cadence bug
# (0 or huge => disabled throttling or a dead watchdog) and an injection vector
# (an embedded newline appends arbitrary unit directives). knob_check rejects
# empty, non-numeric (which covers newlines and control characters), and
# out-of-range values with one shared rule — the same parser watchdog.sh runs
# at tick time. The reason is printed instead of the raw value so a hostile
# value cannot reach the terminal either.
if ! knob_check "$INTERVAL" 10 86400; then
  printf 'ERROR invalid-watchdog-cadence reason=%s allowed=10..86400 (integer seconds); refusing to write any unit file\n' \
    "$KNOB_REASON" >&2
  exit 2
fi
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
