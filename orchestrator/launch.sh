#!/usr/bin/env bash
# Launch an isolated tmux-hosted orchestrator. A detached tmux server owns the
# CLI lifecycle independently of the Telegram daemon and needs no user D-Bus.
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
READINESS_WINDOW_MS="${ORCH_READINESS_WINDOW_MS:-3000}"
READINESS_POLL_SECONDS="${ORCH_READINESS_POLL_SECONDS:-0.15}"
LEASE_FILE="${ORCH_LEASE_FILE:-$RUNTIME_DIR/orchestrator.lease}"
HEARTBEAT_FILE="${ORCH_HEARTBEAT_FILE:-$RUNTIME_DIR/orchestrator.heartbeat}"
CLAUDE_RELAY_SETTINGS="${ORCH_CLAUDE_RELAY_SETTINGS:-$RUNTIME_DIR/claude-relay-settings.json}"
CLAUDE_MCP_CONFIG="${ORCH_CLAUDE_MCP_CONFIG:-$RUNTIME_DIR/claude-mcp-config.json}"
# Two-way Telegram channel: the daemon exposes a legacy-SSE MCP endpoint, so the
# orchestrator can call reply()/status_update() natively instead of depending on
# the one-way Stop-hook relay. Host-local URL only — never a token.
DAEMON_PORT="${TELEGRAM_DAEMON_PORT:-4822}"
CLAUDE_MCP_URL="${ORCH_CLAUDE_MCP_URL:-http://127.0.0.1:$DAEMON_PORT/sse}"
CLAUDE_MCP_SERVER_NAME="${ORCH_CLAUDE_MCP_SERVER_NAME:-telegram}"
BOUND_CHAT_ID="${TELEGRAM_BOUND_CHAT_ID:-${TELEGRAM_CHAT_ID:-}}"
INSTANCE_LOCK_FILE="${ORCH_INSTANCE_LOCK_FILE:-${BOUND_CHAT_ID:+$HOME/.claude/orchestrator-chat-$BOUND_CHAT_ID.lock}}"

usage() {
  printf '%s\n' 'Usage: launch.sh [start|stop|status|--help]'
}

session_exists() { tmux has-session -t "$SESSION" 2>/dev/null; }

now_ms() {
  local seconds nanos
  read -r seconds nanos < <(date '+%s %N')
  printf '%s\n' "$(( seconds * 1000 + 10#$nanos / 1000000 ))"
}

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
    printf 'stopped: %s\n' "$SESSION"
  else
    printf 'already stopped: %s\n' "$SESSION"
  fi
  # The provider can exit before the launcher is asked to stop. Its durable
  # lease must still be released or the next daemon-bound start is fenced out.
  if state_available && lease_state; then
    mission_cli lease release "$LEASE_OWNER" orchestrator "$LEASE_TOKEN" >/dev/null 2>&1 || true
  fi
  rm -f "$LEASE_FILE"
  [[ -z "$INSTANCE_LOCK_FILE" ]] || rm -f "$INSTANCE_LOCK_FILE"
}

build_command() {
  case "$PROVIDER" in
    claude)
      local relay="${ORCH_CLAUDE_STOP_RELAY:-$SCRIPT_DIR/orchestrator-claude-stop-relay.sh}"
      local settings=""
      if [[ -x "$relay" ]]; then
        local settings_tmp
        mkdir -p "$(dirname "$CLAUDE_RELAY_SETTINGS")"
        settings_tmp="$(mktemp "$(dirname "$CLAUDE_RELAY_SETTINGS")/.claude-relay-settings.XXXXXX")"
        "$BUN_BIN" -e '
const relay = process.argv[1];
process.stdout.write(JSON.stringify({
  hooks: {
    Stop: [{
      hooks: [{ type: "command", command: relay }],
    }],
  },
}, null, 2) + "\n");
' "$relay" > "$settings_tmp"
        mv -f "$settings_tmp" "$CLAUDE_RELAY_SETTINGS"
        printf -v settings ' --settings %q' "$CLAUDE_RELAY_SETTINGS"
      fi
      local mcp=""
      if [[ -n "$CLAUDE_MCP_URL" ]]; then
        local mcp_tmp
        mkdir -p "$(dirname "$CLAUDE_MCP_CONFIG")"
        mcp_tmp="$(mktemp "$(dirname "$CLAUDE_MCP_CONFIG")/.claude-mcp-config.XXXXXX")"
        "$BUN_BIN" -e '
const [, name, url] = process.argv;
process.stdout.write(JSON.stringify({
  mcpServers: {
    [name]: { type: "sse", url },
  },
}, null, 2) + "\n");
' "$CLAUDE_MCP_SERVER_NAME" "$CLAUDE_MCP_URL" > "$mcp_tmp"
        mv -f "$mcp_tmp" "$CLAUDE_MCP_CONFIG"
        printf -v mcp ' --mcp-config %q' "$CLAUDE_MCP_CONFIG"
      fi
      [[ -n "$MODEL" ]] && printf 'exec claude --model %q --dangerously-skip-permissions%s%s' "$MODEL" "$settings" "$mcp" || printf 'exec claude --dangerously-skip-permissions%s%s' "$settings" "$mcp"
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
  local status_output="" held_owner=""
  if state_available; then
    mission_cli reap
    status_output="$(mission_cli status)"
    held_owner="$(printf '%s\n' "$status_output" | lease_owner_from_status)"
    if [[ -n "$held_owner" ]]; then
      printf 'ERROR orchestrator-lease-held owner=%s\n' "$held_owner" >&2
      return 1
    fi
  fi
  if [[ -x "$AUTH_PREFLIGHT" ]]; then
    if ! "$AUTH_PREFLIGHT" "$PROVIDER"; then
      return 2
    fi
  else
    printf 'auth preflight missing or not executable: %s\n' "$AUTH_PREFLIGHT" >&2
    return 2
  fi
  local command provider_bin singleton_command startup_file pane_pid
  command="$(build_command)"
  provider_bin="${command#exec }"; provider_bin="${provider_bin%% *}"
  command -v "$provider_bin" >/dev/null 2>&1 || { printf 'provider not found: %s\n' "$provider_bin" >&2; return 2; }
  startup_file="$RUNTIME_DIR/orchestrator.startup"
  rm -f "$startup_file"
  printf -v singleton_command \
    'exec 8>%q; flock -n 8 || exit 73; while [ ! -f %q ]; do sleep 0.01; done; . %q; %s' \
    "$SINGLETON_LOCK_FILE" "$startup_file" "$startup_file" "$command"
  # Do not leak the launch mutex into tmux/the provider process.
  exec 9>&-
  tmux new-session -d -s "$SESSION" -c "$WORK_DIR" "sh -c $(printf '%q' "$singleton_command")" || return 1
  # tmux reports success before the pane command can reject a held flock.
  # Give that command a bounded window to exit, then fail the launch loudly.
  sleep 0.1
  if ! session_exists; then
    printf 'ERROR orchestrator-singleton-held lock=%s\n' "$SINGLETON_LOCK_FILE" >&2
    return 1
  fi
  pane_pid="$(tmux list-panes -t "$SESSION" -F '#{pane_pid}' | head -n 1)"
  [[ "$pane_pid" =~ ^[1-9][0-9]*$ ]] || {
    printf 'ERROR orchestrator-instance-pid-invalid\n' >&2
    tmux kill-session -t "$SESSION" 2>/dev/null || true
    return 1
  }
  if state_available; then
    local lease_output owner token
    owner="$(hostname):$pane_pid"
    if ! lease_output="$(mission_cli lease acquire "$owner" orchestrator "$LEASE_TTL_MS" 2>&1)"; then
      tmux kill-session -t "$SESSION" 2>/dev/null || true
      if [[ -n "$held_owner" ]]; then
        printf 'ERROR orchestrator-lease-held owner=%s\n' "$held_owner" >&2
        return 1
      fi
      printf '%s\n' "$lease_output" >&2
      return 1
    fi
    token="$(sed -nE 's/^LEASE key=orchestrator owner=.* token=([1-9][0-9]*)$/\1/p' <<<"$lease_output")"
    [[ -n "$token" ]] || {
      printf 'ERROR orchestrator-lease-invalid\n' >&2
      tmux kill-session -t "$SESSION" 2>/dev/null || true
      return 1
    }
    write_lease_state "$owner" "$token"
    printf 'export ORCH_FENCING_TOKEN=%q ORCH_LEASE_OWNER=%q\n' "$token" "$owner" > "$startup_file"
    mission_cli status
  else
    printf 'SKIP state-db-absent path=%s\n' "$STATE_DB" >&2
    : > "$startup_file"
  fi
  if state_available && ! mission_cli lease renew "$owner" orchestrator "$token" >/dev/null 2>&1; then
    tmux kill-session -t "$SESSION" 2>/dev/null || true
    release_current_lease
    printf 'ERROR orchestrator-lease-renew-failed owner=%s\n' "$owner" >&2
    return 1
  fi
  local readiness_deadline
  readiness_deadline="$(( $(now_ms) + READINESS_WINDOW_MS ))"
  while (( $(now_ms) < readiness_deadline )); do
    if ! session_exists || ! kill -0 "$pane_pid" 2>/dev/null; then
      tmux kill-session -t "$SESSION" 2>/dev/null || true
      if state_available; then
        release_current_lease
      else
        rm -f "$LEASE_FILE"
      fi
      printf 'ERROR orchestrator-provider-exited provider=%s session=%s\n' "$PROVIDER" "$SESSION" >&2
      return 1
    fi
    sleep "$READINESS_POLL_SECONDS"
  done
  if ! session_exists || ! kill -0 "$pane_pid" 2>/dev/null; then
    tmux kill-session -t "$SESSION" 2>/dev/null || true
    if state_available; then
      release_current_lease
    else
      rm -f "$LEASE_FILE"
    fi
    printf 'ERROR orchestrator-provider-exited provider=%s session=%s\n' "$PROVIDER" "$SESSION" >&2
    return 1
  fi
  if state_available && ! mission_cli lease renew "$owner" orchestrator "$token" >/dev/null 2>&1; then
    tmux kill-session -t "$SESSION" 2>/dev/null || true
    release_current_lease
    printf 'ERROR orchestrator-lease-renew-failed owner=%s\n' "$owner" >&2
    return 1
  fi
  mkdir -p "$(dirname "$HEARTBEAT_FILE")"
  printf '%s\n' "$(date +%s)" > "$HEARTBEAT_FILE"
  if [[ -n "$INSTANCE_LOCK_FILE" ]]; then
    local lock_tmp
    mkdir -p "$(dirname "$INSTANCE_LOCK_FILE")"
    lock_tmp="$(mktemp "$(dirname "$INSTANCE_LOCK_FILE")/.orchestrator-lock.XXXXXX")"
    printf '{"pid":%s,"pid_started_at":"%s"}\n' \
      "$pane_pid" "$(date --iso-8601=seconds)" > "$lock_tmp"
    mv -f "$lock_tmp" "$INSTANCE_LOCK_FILE"
  fi
  printf 'started: %s (%s)\n' "$SESSION" "$PROVIDER"
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  -h|--help|help) usage ;;
  *) usage >&2; exit 2 ;;
esac
