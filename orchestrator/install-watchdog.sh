#!/usr/bin/env bash
# Install the one-shot watchdog as a user timer. Safe to rerun.
# INSTALLATION is inert: `install` only renders the unit files and reloads
# systemd — it never enables or starts the timer. ARMING is a separate,
# explicit operator act (`arm`), per the standing deploy ruling that the
# watchdog timer stays unarmed until deliberately armed.
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

usage() {
  printf '%s\n' \
    'Usage: install-watchdog.sh [install|arm|disarm|uninstall|--help]' \
    '  install    render the unit files INERT (no enable, no start) — the default' \
    '  arm        explicitly enable --now the timer; the ONLY arming path' \
    '  disarm     disable --now the timer, keeping the unit files' \
    '  uninstall  disarm and remove the unit files'
}
case "${1:-install}" in
  -h|--help|help) usage; exit 0 ;;
  arm)
    # Arming must never be an install side effect. Refuse to arm what was
    # never installed, so a typo cannot enable a dangling unit reference.
    if [[ ! -f "$SERVICE" || ! -f "$TIMER" ]]; then
      printf 'ERROR not-installed unit=%s; run install-watchdog.sh install first\n' "$UNIT_NAME" >&2
      exit 2
    fi
    systemctl --user enable --now "$UNIT_NAME.timer"
    enabled="$(systemctl --user is-enabled "$UNIT_NAME.timer" 2>/dev/null || true)"
    active="$(systemctl --user is-active "$UNIT_NAME.timer" 2>/dev/null || true)"
    next_trigger="$(systemctl --user show "$UNIT_NAME.timer" --property=NextElapseUSecRealtime --value 2>/dev/null || true)"
    if [[ "$enabled" != enabled || "$active" != active ]] ||
       ! finite_future_systemd_trigger "$next_trigger" "${ORCH_WATCHDOG_NOW:-$(date +%s)}"; then
      systemctl --user disable --now "$UNIT_NAME.timer" 2>/dev/null || true
      printf 'ERROR arm-unproven unit=%s enabled=%s active=%s next=%s\n' \
        "$UNIT_NAME" "${enabled:-unknown}" "${active:-unknown}" "${next_trigger:-none}" >&2
      exit 3
    fi
    printf 'armed: %s\n' "$UNIT_NAME"
    exit 0
    ;;
  disarm)
    systemctl --user disable --now "$UNIT_NAME.timer"
    printf 'disarmed: %s\n' "$UNIT_NAME"
    exit 0
    ;;
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
printf 'installed: %s (every %ss) INERT; arm explicitly with: install-watchdog.sh arm\n' \
  "$UNIT_NAME" "$INTERVAL"
