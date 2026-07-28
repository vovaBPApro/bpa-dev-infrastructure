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

SESSION="${ORCH_SESSION:-orchestrator}"
WORK_DIR="${ORCH_WORK_DIR:-$PWD}"
RUNTIME_DIR="${ORCH_RUNTIME_DIR:-$SCRIPT_DIR/runtime}"
PROVIDER="${ORCH_PROVIDER:-codex}"
MODEL="${ORCH_MODEL:-}"
LOCK_FILE="${ORCH_LOCK_FILE:-$RUNTIME_DIR/launch.lock}"
AUTH_PREFLIGHT="${ORCH_AUTH_PREFLIGHT:-$SCRIPT_DIR/preflight-cli-auth.sh}"

usage() {
  printf '%s\n' 'Usage: launch.sh [start|stop|status|--help]'
}

session_exists() { tmux has-session -t "$SESSION" 2>/dev/null; }

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
  mkdir -p "$RUNTIME_DIR"
  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    printf 'launch already in progress\n' >&2
    return 1
  fi
  if session_exists; then
    printf 'session already exists: %s\n' "$SESSION" >&2
    return 1
  fi
  if [[ -x "$AUTH_PREFLIGHT" ]]; then
    "$AUTH_PREFLIGHT" "$PROVIDER"
  else
    printf 'auth preflight missing or not executable: %s\n' "$AUTH_PREFLIGHT" >&2
    return 2
  fi
  local command provider_bin unit
  command="$(build_command)"
  provider_bin="${command#exec }"; provider_bin="${provider_bin%% *}"
  command -v "$provider_bin" >/dev/null 2>&1 || { printf 'provider not found: %s\n' "$provider_bin" >&2; return 2; }
  unit="orch-${SESSION//[^a-zA-Z0-9_.-]/-}"
  systemd-run --user --scope --quiet --unit="$unit" \
    tmux new-session -d -s "$SESSION" -c "$WORK_DIR" "$command"
  printf 'started: %s (%s)\n' "$SESSION" "$PROVIDER"
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  -h|--help|help) usage ;;
  *) usage >&2; exit 2 ;;
esac
