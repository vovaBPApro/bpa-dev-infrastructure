#!/usr/bin/env bash
# Verify deployed unit files and prove that the drift guard's timer is armed.
# The explicit guard-unit anchor below is deliberately independent of both the
# systemd directory and instance/expected-units.tsv: deleting an item from both
# of those inputs must remain a named failure.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST_FILE="${MANIFEST_FILE:-$SCRIPT_DIR/../instance/expected-units.tsv}"
UNIT_DRIFT_CHECK="${UNIT_DRIFT_CHECK:-$SCRIPT_DIR/check-unit-drift.sh}"
SYSTEMCTL_BIN="${SYSTEMCTL_BIN:-systemctl}"
TIMEOUT_BIN="${TIMEOUT_BIN:-timeout}"
SYSTEMD_TIMEOUT_SECONDS="${SYSTEMD_TIMEOUT_SECONDS:-15}"

required_guard_units=(
  bpa-deploy-drift-guard.service
  bpa-deploy-drift-guard.timer
)

fail_input() {
  printf 'DEPLOY-DRIFT ERROR: %s\n' "$1" >&2
  exit 2
}

[[ "$SYSTEMD_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] || fail_input "invalid systemd timeout: $SYSTEMD_TIMEOUT_SECONDS"
[[ -f "$MANIFEST_FILE" && -r "$MANIFEST_FILE" ]] || fail_input "expected-units manifest unreadable: $MANIFEST_FILE"
[[ -x "$UNIT_DRIFT_CHECK" ]] || fail_input "unit drift checker unavailable: $UNIT_DRIFT_CHECK"
command -v "$SYSTEMCTL_BIN" >/dev/null 2>&1 || fail_input "systemctl command unavailable: $SYSTEMCTL_BIN"
command -v "$TIMEOUT_BIN" >/dev/null 2>&1 || fail_input "timeout command unavailable: $TIMEOUT_BIN"

for required_unit in "${required_guard_units[@]}"; do
  if ! awk -F '\t' -v unit="$required_unit" '$1 == unit && ($2 == "generic" || $2 == "instance") { found=1 } END { exit !found }' "$MANIFEST_FILE"; then
    printf 'DEPLOY-DRIFT ALARM: independent anchor missing required manifest unit: %s\n' "$required_unit" >&2
    exit 1
  fi
done

# Probe the manager separately. A failed or timed-out probe is not equivalent
# to an inactive unit and must name systemd as the unavailable boundary.
if ! "$TIMEOUT_BIN" "$SYSTEMD_TIMEOUT_SECONDS" "$SYSTEMCTL_BIN" show-environment >/dev/null 2>&1; then
  fail_input "systemd unreachable or timed out after ${SYSTEMD_TIMEOUT_SECONDS}s"
fi

result=0
if ! "$UNIT_DRIFT_CHECK"; then
  printf 'DEPLOY-DRIFT ALARM: deployed unit files differ from the independent manifest\n' >&2
  result=1
fi

if ! "$TIMEOUT_BIN" "$SYSTEMD_TIMEOUT_SECONDS" "$SYSTEMCTL_BIN" is-enabled --quiet bpa-deploy-drift-guard.timer; then
  printf 'DEPLOY-DRIFT ALARM: guard arming absent: bpa-deploy-drift-guard.timer is not enabled\n' >&2
  result=1
fi
if ! "$TIMEOUT_BIN" "$SYSTEMD_TIMEOUT_SECONDS" "$SYSTEMCTL_BIN" is-active --quiet bpa-deploy-drift-guard.timer; then
  printf 'DEPLOY-DRIFT ALARM: guard arming absent: bpa-deploy-drift-guard.timer is not active\n' >&2
  result=1
fi

if ((result == 0)); then
  printf 'DEPLOY-DRIFT CLEAN: deployed units match and bpa-deploy-drift-guard.timer is enabled and active\n'
fi
exit "$result"
