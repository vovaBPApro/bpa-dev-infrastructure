#!/usr/bin/env bash
# Render a fail-soft operator screen from durable state and local host probes.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${ORCH_CONFIG_FILE:-$SCRIPT_DIR/runtime.env}"
if [[ -f "$CONFIG_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
fi
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib.sh"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNTIME_DIR="${ORCH_RUNTIME_DIR:-$SCRIPT_DIR/runtime}"
STATE_DB="${ORCH_STATE_DB:-$REPO_DIR/runtime/state.db}"
MISSION_CLI="${ORCH_MISSION_CLI:-$REPO_DIR/core/mission-cli.ts}"
INSTALL_ROOT="${ORCH_INSTALL_ROOT:-${INSTALL_ROOT:-$REPO_DIR}}"
NUDGE_OUTBOX_FILE="${NUDGE_OUTBOX_FILE:-$RUNTIME_DIR/nudges.outbox}"
DECISIONS_FILE="${DECISIONS_FILE:-$RUNTIME_DIR/decisions.md}"
PROC_ROOT="${ORCH_PROC_ROOT:-/proc}"
DF_BIN="${ORCH_DF_BIN:-df}"

printf 'Fleet status\n\n'
printf 'Missions / lanes / leases\n'
if [[ -f "$STATE_DB" ]] && status_json="$(INFRA_STATE_DB="$STATE_DB" "$BUN_BIN" "$MISSION_CLI" status 2>/dev/null)"; then
  # shellcheck disable=SC2016 # JavaScript template expressions are intentionally literal.
  printf '%s' "$status_json" | "$BUN_BIN" -e '
const input = await Bun.stdin.text(); const status = JSON.parse(input);
console.log(`counts     missions=${status.missions.length} lanes=${status.lanes.length} leases=${status.leases.length}`);
if (status.missions.length === 0) console.log("missions   SKIP no open missions");
for (const mission of status.missions) {
  const lanes = status.lanes.filter((lane) => lane.missionId === mission.id);
  const active = status.leases.filter((lease) => lanes.some((lane) => lane.id === lease.key)).length;
  console.log(`mission    ${mission.correlationId} open_lanes=${lanes.length} active=${active}`);
}'
else
  printf 'counts     SKIP state DB or mission status unavailable\n'
fi

printf '\nServer resources\n'
if [[ -r "$PROC_ROOT/meminfo" ]]; then
  mem_available="$(awk '/^MemAvailable:/ { print $2 }' "$PROC_ROOT/meminfo")"
  mem_total="$(awk '/^MemTotal:/ { print $2 }' "$PROC_ROOT/meminfo")"
  printf 'ram        free=%sKiB total=%sKiB\n' "${mem_available:-SKIP}" "${mem_total:-SKIP}"
else
  printf 'ram        SKIP %s/meminfo unavailable\n' "$PROC_ROOT"
fi
if [[ -r "$PROC_ROOT/loadavg" ]]; then
  read -r load_one load_five load_fifteen _ < "$PROC_ROOT/loadavg"
  printf 'cpu        load_avg=%s %s %s\n' "$load_one" "$load_five" "$load_fifteen"
else
  printf 'cpu        SKIP %s/loadavg unavailable\n' "$PROC_ROOT"
fi
disk_row() {
  local label="$1" path="$2" pct
  pct="$("$DF_BIN" -P "$path" 2>/dev/null | awk 'NR == 2 { print $5 }' || true)"
  if [[ -n "$pct" ]]; then printf 'disk       %-8s use=%s path=%s\n' "$label" "$pct" "$path"; else printf 'disk       %-8s SKIP path=%s\n' "$label" "$path"; fi
}
disk_row root /
disk_row install "$INSTALL_ROOT"

printf '\nNewest nudges\n'
if [[ -f "$NUDGE_OUTBOX_FILE" ]]; then
  tail -n 10 "$NUDGE_OUTBOX_FILE"
else
  printf 'SKIP nudge outbox absent: %s\n' "$NUDGE_OUTBOX_FILE"
fi

printf '\nPending decisions\n'
if [[ -f "$DECISIONS_FILE" ]]; then
  pending="$(grep -E '^- \[ \]' "$DECISIONS_FILE" || true)"
  if [[ -n "$pending" ]]; then printf '%s\n' "$pending"; else printf 'SKIP no pending decisions\n'; fi
else
  printf 'SKIP decisions file absent: %s\n' "$DECISIONS_FILE"
fi
