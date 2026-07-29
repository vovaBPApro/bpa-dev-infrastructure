#!/usr/bin/env bash
# Launch an isolated tmux-hosted orchestrator.  The systemd scope prevents a
# Telegram daemon restart from taking the CLI session down with its cgroup.
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
WORK_DIR="${ORCH_WORK_DIR:-$PWD}"
RUNTIME_DIR="${ORCH_RUNTIME_DIR:-$SCRIPT_DIR/runtime}"
PROVIDER="${ORCH_PROVIDER:-codex}"
MODEL="${ORCH_MODEL:-}"
LOCK_FILE="${ORCH_LOCK_FILE:-$RUNTIME_DIR/launch.lock}"
AUTH_PREFLIGHT="${ORCH_AUTH_PREFLIGHT:-$SCRIPT_DIR/preflight-cli-auth.sh}"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SINGLETON_LOCK_FILE="${ORCH_SINGLETON_LOCK_FILE:-$REPO_DIR/runtime/orchestrator.singleton.lock}"
MISSION_CLI="${ORCH_MISSION_CLI:-$REPO_DIR/core/mission-cli.ts}"
STATE_DB="${ORCH_STATE_DB:-$REPO_DIR/runtime/state.db}"
LEASE_TTL_MS="${ORCH_LEASE_TTL_MS:-120000}"
LEASE_FILE="${ORCH_LEASE_FILE:-$RUNTIME_DIR/orchestrator.lease}"
HEARTBEAT_FILE="${ORCH_HEARTBEAT_FILE:-$RUNTIME_DIR/orchestrator.heartbeat}"

usage() {
  printf '%s\n' 'Usage: launch.sh [start|stop|status|--help]'
}

session_exists() { tmux has-session -t "$SESSION" 2>/dev/null; }

state_available() { [[ -f "$STATE_DB" ]]; }

mission_cli() { INFRA_STATE_DB="$STATE_DB" "$BUN_BIN" "$MISSION_CLI" "$@"; }

lease_state() {
  [[ -f "$LEASE_FILE" ]] || return 1
  LEASE_OWNER="$(sed -n 's/^owner=//p' "$LEASE_FILE")"
  LEASE_TOKEN="$(sed -n 's/^token=//p' "$LEASE_FILE")"
  [[ -n "$LEASE_OWNER" && "$LEASE_TOKEN" =~ ^[1-9][0-9]*$ ]]
}

write_lease_state() {
  local owner="$1" token="$2"
  umask 077
  printf 'owner=%s\ntoken=%s\n' "$owner" "$token" > "$LEASE_FILE"
}

release_current_lease() {
  if [[ -n "${owner:-}" && -n "${token:-}" ]]; then
    mission_cli lease release "$owner" orchestrator "$token" >/dev/null 2>&1 || true
  fi
  rm -f "$LEASE_FILE"
}

lease_owner_from_status() {
  sed -nE 's/.*"key":"orchestrator","owner":"([^"]+)".*/\1/p' | head -n 1
}

status() {
  if session_exists; then
    printf 'running: %s\n' "$SESSION"
  else
    printf 'stopped: %s\n' "$SESSION"
    return 1
  fi
}

stop() {
  if session_exists; then
    tmux kill-session -t "$SESSION"
    if state_available && lease_state; then
      mission_cli lease release "$LEASE_OWNER" orchestrator "$LEASE_TOKEN" >/dev/null 2>&1 || true
    fi
    rm -f "$LEASE_FILE"
    printf 'stopped: %s\n' "$SESSION"
  else
    printf 'already stopped: %s\n' "$SESSION"
  fi
}

build_command() {
  case "$PROVIDER" in
    claude)
      [[ -n "$MODEL" ]] && printf 'exec claude --model %q --dangerously-skip-permissions' "$MODEL" || printf '%s' 'exec claude --dangerously-skip-permissions'
      ;;
    codex)
      local relay="${ORCH_TURNEND_RELAY:-$SCRIPT_DIR/orchestrator-turnend-relay.sh}"
      local notify=""
      if [[ -x "$relay" ]]; then
        printf -v notify ' --config notify=%q' "[\"$relay\"]"
      fi
      [[ -n "$MODEL" ]] && printf 'exec codex --model %q --dangerously-bypass-approvals-and-sandbox%s' "$MODEL" "$notify" || printf 'exec codex --dangerously-bypass-approvals-and-sandbox%s' "$notify"
      ;;
    *) printf 'unsupported provider: %s\n' "$PROVIDER" >&2; return 2 ;;
  esac
}

start() {
  mkdir -p "$RUNTIME_DIR" "$(dirname "$SINGLETON_LOCK_FILE")"
  umask 077
  : >> "$SINGLETON_LOCK_FILE"
  chmod 0600 "$SINGLETON_LOCK_FILE"
  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    printf 'launch already in progress\n' >&2
    return 1
  fi
  if session_exists; then
    printf 'session already exists: %s\n' "$SESSION" >&2
    return 1
  fi
  if state_available; then
    mission_cli reap
    local status_output held_owner lease_output owner token
    status_output="$(mission_cli status)"
    held_owner="$(printf '%s\n' "$status_output" | lease_owner_from_status)"
    if ! lease_output="$(mission_cli lease acquire "$(hostname):$$" orchestrator "$LEASE_TTL_MS" 2>&1)"; then
      if [[ -n "$held_owner" ]]; then
        printf 'ERROR orchestrator-lease-held owner=%s\n' "$held_owner" >&2
        return 1
      fi
      printf '%s\n' "$lease_output" >&2
      return 1
    fi
    owner="$(hostname):$$"
    token="$(sed -nE 's/^LEASE key=orchestrator owner=.* token=([1-9][0-9]*)$/\1/p' <<<"$lease_output")"
    [[ -n "$token" ]] || { printf 'ERROR orchestrator-lease-invalid\n' >&2; return 1; }
    write_lease_state "$owner" "$token"
    export ORCH_FENCING_TOKEN="$token" ORCH_LEASE_OWNER="$owner"
    mission_cli status
  else
    printf 'SKIP state-db-absent path=%s\n' "$STATE_DB" >&2
  fi
  if [[ -x "$AUTH_PREFLIGHT" ]]; then
    if ! "$AUTH_PREFLIGHT" "$PROVIDER"; then
      release_current_lease
      return 2
    fi
  else
    printf 'auth preflight missing or not executable: %s\n' "$AUTH_PREFLIGHT" >&2
    return 2
  fi
  local command provider_bin singleton_command unit
  command="$(build_command)"
  provider_bin="${command#exec }"; provider_bin="${provider_bin%% *}"
  command -v "$provider_bin" >/dev/null 2>&1 || { printf 'provider not found: %s\n' "$provider_bin" >&2; release_current_lease; return 2; }
  printf -v singleton_command 'flock -n %q sh -c %q' "$SINGLETON_LOCK_FILE" "$command"
  unit="orch-${SESSION//[^a-zA-Z0-9_.-]/-}"
  # Do not leak the launch mutex into tmux/the provider process.
  exec 9>&-
  if ! systemd-run --user --scope --quiet --unit="$unit" \
    tmux new-session -d -s "$SESSION" -c "$WORK_DIR" "$singleton_command"; then
    release_current_lease
    return 1
  fi
  # tmux reports success before the pane command can reject a held flock.
  # Give that command a bounded window to exit, then fail the launch loudly.
  sleep 0.1
  if ! session_exists; then
    printf 'ERROR orchestrator-singleton-held lock=%s\n' "$SINGLETON_LOCK_FILE" >&2
    release_current_lease
    return 1
  fi
  mkdir -p "$(dirname "$HEARTBEAT_FILE")"
  printf '%s\n' "$(date +%s)" > "$HEARTBEAT_FILE"
  printf 'started: %s (%s)\n' "$SESSION" "$PROVIDER"
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  -h|--help|help) usage ;;
  *) usage >&2; exit 2 ;;
esac
