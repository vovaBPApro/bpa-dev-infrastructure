#!/usr/bin/env bash
# One watchdog tick.  A timer invokes this script; it never loops itself.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${ORCH_CONFIG_FILE:-$SCRIPT_DIR/runtime.env}"
if [[ -f "$CONFIG_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
fi
SESSION="${ORCH_SESSION:-orchestrator}"
RUNTIME_DIR="${ORCH_RUNTIME_DIR:-$SCRIPT_DIR/runtime}"
LOG_FILE="${ORCH_WATCHDOG_LOG:-$RUNTIME_DIR/watchdog.log}"
HEARTBEAT_FILE="${ORCH_HEARTBEAT_FILE:-}"
HEARTBEAT_MAX_AGE="${ORCH_HEARTBEAT_MAX_AGE:-1200}"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MISSION_CLI="${ORCH_MISSION_CLI:-$REPO_DIR/core/mission-cli.ts}"
STATE_DB="${ORCH_STATE_DB:-$REPO_DIR/runtime/state.db}"
LEASE_FILE="${ORCH_LEASE_FILE:-$RUNTIME_DIR/orchestrator.lease}"

log() { mkdir -p "$RUNTIME_DIR"; printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG_FILE"; }
pane_pid() { tmux list-panes -t "$SESSION" -F '#{pane_pid}' 2>/dev/null | head -n 1; }
state_available() { [[ -f "$STATE_DB" ]]; }
mission_cli() { INFRA_STATE_DB="$STATE_DB" bun "$MISSION_CLI" "$@"; }
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
  [[ -n "$HEARTBEAT_FILE" ]] || return 1
  [[ -f "$HEARTBEAT_FILE" ]] || return 1
  local modified now
  modified="$(stat -c %Y "$HEARTBEAT_FILE" 2>/dev/null || stat -f %m "$HEARTBEAT_FILE")"
  now="${ORCH_WATCHDOG_NOW:-$(date +%s)}"
  [[ "$modified" =~ ^[0-9]+$ && "$now" =~ ^[0-9]+$ ]] || return 1
  (( now - modified > HEARTBEAT_MAX_AGE ))
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
  "$SCRIPT_DIR/launch.sh" start
  exit 0
fi
if heartbeat_stale; then
  log "zombie session=$SESSION action=kill-relaunch"
  "$SCRIPT_DIR/launch.sh" stop
  "$SCRIPT_DIR/launch.sh" start
  exit 0
fi
exit 0
