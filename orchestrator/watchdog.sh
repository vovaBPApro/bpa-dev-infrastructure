#!/usr/bin/env bash
# One watchdog tick.  A timer invokes this script; it never loops itself.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${ORCH_CONFIG_FILE:-$SCRIPT_DIR/runtime.env}"
if [[ -f "$CONFIG_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
fi
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib.sh"
SESSION="${ORCH_SESSION:-orchestrator}"
RUNTIME_DIR="${ORCH_RUNTIME_DIR:-$SCRIPT_DIR/runtime}"
LOG_FILE="${ORCH_WATCHDOG_LOG:-$RUNTIME_DIR/watchdog.log}"
HEARTBEAT_FILE="${ORCH_HEARTBEAT_FILE:-$RUNTIME_DIR/orchestrator.heartbeat}"
HEARTBEAT_MAX_AGE="${ORCH_HEARTBEAT_MAX_AGE:-1200}"
HEARTBEAT_MISSING_SINCE_FILE="${ORCH_HEARTBEAT_MISSING_SINCE_FILE:-$RUNTIME_DIR/heartbeat-missing-since}"
LAUNCH_SCRIPT="${ORCH_LAUNCH_SCRIPT:-$SCRIPT_DIR/launch.sh}"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MISSION_CLI="${ORCH_MISSION_CLI:-$REPO_DIR/core/mission-cli.ts}"
STATE_DB="${ORCH_STATE_DB:-$REPO_DIR/runtime/state.db}"
LEASE_FILE="${ORCH_LEASE_FILE:-$RUNTIME_DIR/orchestrator.lease}"
INSTALL_ROOT="${ORCH_INSTALL_ROOT:-${INSTALL_ROOT:-$REPO_DIR}}"
NUDGE_OUTBOX_FILE="${NUDGE_OUTBOX_FILE:-$RUNTIME_DIR/nudges.outbox}"
FLEET_IDLE_NUDGE_MS="${FLEET_IDLE_NUDGE_MS:-900000}"
FLEET_NUDGE_REPEAT_MS="${FLEET_NUDGE_REPEAT_MS:-3600000}"
DISK_ALERT_PCT="${DISK_ALERT_PCT:-80}"
NUDGE_RATE_FILE="${NUDGE_RATE_FILE:-$RUNTIME_DIR/nudge-rate.tsv}"

log() { mkdir -p "$RUNTIME_DIR"; printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG_FILE"; }
validate_numeric_knob() {
  local name="$1" default="$2" value="${!1}"
  if ! [[ "$value" =~ ^[0-9]+$ ]]; then
    log "WATCHDOG invalid-knob name=$name value=$value using-default=$default"
    printf -v "$name" '%s' "$default"
  fi
}
validate_numeric_knob FLEET_IDLE_NUDGE_MS 900000
validate_numeric_knob FLEET_NUDGE_REPEAT_MS 3600000
validate_numeric_knob DISK_ALERT_PCT 80
validate_numeric_knob HEARTBEAT_MAX_AGE 1200

pane_pid() { tmux list-panes -t "$SESSION" -F '#{pane_pid}' 2>/dev/null | head -n 1; }
state_available() { [[ -f "$STATE_DB" ]]; }
mission_cli() { INFRA_STATE_DB="$STATE_DB" "$BUN_BIN" "$MISSION_CLI" "$@"; }
lease_state() {
  [[ -f "$LEASE_FILE" ]] || return 1
  LEASE_OWNER="$(sed -n 's/^owner=//p' "$LEASE_FILE")"
  LEASE_TOKEN="$(sed -n 's/^token=//p' "$LEASE_FILE")"
  [[ -n "$LEASE_OWNER" && "$LEASE_TOKEN" =~ ^[1-9][0-9]*$ ]]
}
stop_supervised_unit() { tmux kill-session -t "$SESSION" 2>/dev/null || true; }
session_healthy() {
  tmux has-session -t "$SESSION" 2>/dev/null || return 1
  local pid; pid="$(pane_pid)"; [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null
}
heartbeat_stale() {
  local heartbeat now
  now="${ORCH_WATCHDOG_NOW:-$(date +%s)}"
  if [[ ! -f "$HEARTBEAT_FILE" ]]; then
    if [[ ! -f "$HEARTBEAT_MISSING_SINCE_FILE" ]]; then
      printf '%s\n' "$now" > "$HEARTBEAT_MISSING_SINCE_FILE"
      return 1
    fi
    heartbeat="$(cat "$HEARTBEAT_MISSING_SINCE_FILE" 2>/dev/null)" || return 0
    [[ "$heartbeat" =~ ^[0-9]+$ && "$now" =~ ^[0-9]+$ ]] || return 0
    (( now - heartbeat > HEARTBEAT_MAX_AGE ))
    return
  fi
  rm -f "$HEARTBEAT_MISSING_SINCE_FILE"
  heartbeat="$(cat "$HEARTBEAT_FILE" 2>/dev/null)" || return 0
  [[ "$heartbeat" =~ ^[0-9]+$ && "$now" =~ ^[0-9]+$ ]] || return 0
  (( now - heartbeat > HEARTBEAT_MAX_AGE ))
}

# Watchdog nudge updates are written to a same-directory temporary file then
# renamed, so a Telegram reader observes either the old complete file or the
# new complete file. full-suite.sh follows the same outbox pattern.
append_nudge() {
  local line="$1" tmp lock_file lock_fd
  mkdir -p "$(dirname "$NUDGE_OUTBOX_FILE")"
  lock_file="${NUDGE_OUTBOX_FILE}.lock"
  exec {lock_fd}> "$lock_file"
  flock "$lock_fd"
  tmp="$(mktemp "$(dirname "$NUDGE_OUTBOX_FILE")/.nudges.outbox.XXXXXX")"
  [[ -f "$NUDGE_OUTBOX_FILE" ]] && cat "$NUDGE_OUTBOX_FILE" > "$tmp"
  printf '%s\n' "$line" >> "$tmp"
  mv -f "$tmp" "$NUDGE_OUTBOX_FILE"
  flock -u "$lock_fd"
  exec {lock_fd}>&-
}

nudge_due() {
  local kind="$1" key="$2" now="$3" last=0
  [[ "$now" =~ ^[0-9]+$ ]] || return 1
  if [[ -f "$NUDGE_RATE_FILE" ]]; then
    last="$(awk -F '\t' -v kind="$kind" -v key="$key" '$1 == kind && $2 == key { value=$3 } END { print value+0 }' "$NUDGE_RATE_FILE")"
  fi
  (( now - last >= FLEET_NUDGE_REPEAT_MS ))
}

record_nudge() {
  local kind="$1" key="$2" now="$3" tmp
  mkdir -p "$(dirname "$NUDGE_RATE_FILE")"
  tmp="$(mktemp "$(dirname "$NUDGE_RATE_FILE")/.nudge-rate.XXXXXX")"
  [[ -f "$NUDGE_RATE_FILE" ]] && awk -F '\t' -v kind="$kind" -v key="$key" '!($1 == kind && $2 == key)' "$NUDGE_RATE_FILE" > "$tmp"
  printf '%s\t%s\t%s\n' "$kind" "$key" "$now" >> "$tmp"
  mv -f "$tmp" "$NUDGE_RATE_FILE"
}

check_disk_pressure() {
  local pct now
  pct="$(df -P "$INSTALL_ROOT" 2>/dev/null | awk 'NR == 2 { value=$5; sub(/%$/, "", value); print value }')"
  [[ "$pct" =~ ^[0-9]+$ ]] || { log "SKIP reason=disk-stat-unavailable root=$INSTALL_ROOT"; return; }
  if (( pct >= DISK_ALERT_PCT )); then
    log "WATCHDOG disk-pressure pct=$pct root=$INSTALL_ROOT"
    now="${ORCH_WATCHDOG_NOW_MS:-$(( $(date +%s) * 1000 ))}"
    if nudge_due disk "$INSTALL_ROOT" "$now"; then
      append_nudge "NUDGE disk-pressure pct=$pct root=$INSTALL_ROOT"
      record_nudge disk "$INSTALL_ROOT" "$now"
    fi
  fi
}

check_mission_pressure() {
  local status_output now
  state_available || { log "SKIP reason=mission-pressure-state-db-absent path=$STATE_DB"; return; }
  if ! status_output="$(mission_cli status 2>/dev/null)"; then
    log "SKIP reason=mission-pressure-status-unavailable"
    return
  fi
  now="${ORCH_WATCHDOG_NOW_MS:-$(( $(date +%s) * 1000 ))}"
  while IFS=$'\t' read -r correlation open_lanes active updated_at; do
    [[ -n "$correlation" ]] || continue
    [[ "$open_lanes" =~ ^[0-9]+$ && "$active" =~ ^[0-9]+$ && "$updated_at" =~ ^[0-9]+$ ]] || continue
    if (( open_lanes > 0 && now - updated_at >= FLEET_IDLE_NUDGE_MS )) && nudge_due mission "$correlation" "$now"; then
      append_nudge "NUDGE mission=$correlation open_lanes=$open_lanes active=$active idle_ms=$(( now - updated_at ))"
      record_nudge mission "$correlation" "$now"
    fi
  done < <(printf '%s' "$status_output" | "$BUN_BIN" -e '
const input = await Bun.stdin.text();
const status = JSON.parse(input);
for (const mission of status.missions) {
  const lanes = status.lanes.filter((lane) => lane.missionId === mission.id);
  const active = status.leases.filter((lease) => lanes.some((lane) => lane.id === lease.key)).length;
  const updatedAt = Math.max(mission.updatedAt, ...lanes.map((lane) => lane.updatedAt));
  console.log([mission.correlationId, lanes.length, active, updatedAt].join("\t"));
}')
}

if state_available; then
  if ! lease_state; then
    log "SKIP reason=lease-state-missing"
  elif ! mission_cli lease renew "$LEASE_OWNER" orchestrator "$LEASE_TOKEN" >/dev/null 2>&1; then
    log "WATCHDOG lease-lost owner=$LEASE_OWNER token=$LEASE_TOKEN"
    stop_supervised_unit
    exit 0
  fi
else
  log "SKIP reason=state-db-absent path=$STATE_DB"
fi

if ! session_healthy; then
  log "dead session=$SESSION action=relaunch"
  "$LAUNCH_SCRIPT" start
  exit 0
fi
if heartbeat_stale; then
  if [[ -f "$HEARTBEAT_FILE" ]]; then
    log "zombie session=$SESSION action=kill-relaunch"
  else
    log "heartbeat-missing session=$SESSION action=kill-relaunch"
  fi
  "$LAUNCH_SCRIPT" stop
  "$LAUNCH_SCRIPT" start
  exit 0
fi

check_disk_pressure || log "WATCHDOG observability-check-failed check=disk-pressure"
check_mission_pressure || log "WATCHDOG observability-check-failed check=mission-pressure"
exit 0
