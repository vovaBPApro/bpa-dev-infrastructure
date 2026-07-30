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
# MUST match the reply-routing hint the daemon appends to every inbound message
# (daemon/server.ts: ` [reply via mcp__telegram-daemon__reply chat_id=...]`).
# The MCP server name becomes the mcp__<name>__<tool> prefix Claude resolves, so
# a mismatch here makes the hint point at a tool that does not exist and the
# channel silently degrades to the one-way Stop-hook relay.
# claude-mcp-channel.test.sh locks the two together.
CLAUDE_MCP_SERVER_NAME="${ORCH_CLAUDE_MCP_SERVER_NAME:-telegram-daemon}"
# ── Fallback (Codex) top orchestrator ───────────────────────────────────────
# The model is PINNED in source, not left to the account default. With no
# runtime.env on the box, ORCH_MODEL resolved empty and codex launched with no
# --model at all — whatever the account happened to default to would silently
# become the orchestrator. The instance fact lives in instance/params.yaml
# (orchestrator.fallback_model); this is the value that survives a fresh clone.
# Precedence: ORCH_CODEX_MODEL > ORCH_MODEL (legacy, provider-agnostic) > pin.
CODEX_MODEL="${ORCH_CODEX_MODEL:-${MODEL:-gpt-5.6-sol}}"
# ── Claude (primary) top orchestrator ───────────────────────────────────────
# Same shape, same reason: claude used to launch with no --model whenever
# ORCH_MODEL was empty, so the top orchestrator silently became whatever the
# account happened to default to — the identical bug that was fixed for codex
# above. The instance fact lives in instance/params.yaml (orchestrator.top_model);
# this is the value that survives a fresh clone with no runtime.env.
# Precedence: ORCH_CLAUDE_MODEL > ORCH_MODEL (legacy) > pin. The Telegram
# /model command writes ORCH_CLAUDE_MODEL — provider-scoped on purpose, so an
# escalation to Fable can never leak into a codex launch.
CLAUDE_MODEL="${ORCH_CLAUDE_MODEL:-${MODEL:-claude-opus-5}}"
# codex-cli defaults this box to `reasoning effort: none`, which is not adequate
# for the judgement this role does (routing, evidence verdicts, landing calls).
CODEX_REASONING_EFFORT="${ORCH_CODEX_REASONING_EFFORT:-high}"
# Standing-context load at session start. Codex fires SessionStart hooks with
# the same wire format as the Claude harness — same stdin envelope, same
# {"hookSpecificOutput":{"additionalContext":…}} reply — so both providers share
# ONE hook script rather than forking the loader per vendor. Declared inline via
# --config instead of a hooks.json file: a repo-local $CODEX_HOME would be
# written into by codex (tui.model_availability_nux counters), leaving the tree
# dirty and every session load reporting `startup: degraded`, and the real
# $CODEX_HOME is shared with every other codex process on the box.
CODEX_SESSION_HOOK="${ORCH_CODEX_SESSION_HOOK:-$REPO_DIR/.claude/hooks/session-load.sh}"
BOUND_CHAT_ID="${TELEGRAM_BOUND_CHAT_ID:-${TELEGRAM_CHAT_ID:-}}"
INSTANCE_LOCK_FILE="${ORCH_INSTANCE_LOCK_FILE:-${BOUND_CHAT_ID:+$HOME/.claude/orchestrator-chat-$BOUND_CHAT_ID.lock}}"

usage() {
  printf '%s\n' 'Usage: launch.sh [start|stop|status|model|--help]'
}

# Machine-readable resolved model state, for the Telegram /model command.
# Read-only by construction: it starts nothing, writes nothing, and takes no
# lock. The launcher is the single source of truth for the precedence chain
# (ORCH_<PROVIDER>_MODEL > ORCH_MODEL > pin); a second copy of it in the daemon
# would eventually report a model that is not the one actually starting.
model_report() {
  printf 'provider=%s\n' "$PROVIDER"
  printf 'config_file=%s\n' "$CONFIG_FILE"
  printf 'claude_model=%s\n' "$CLAUDE_MODEL"
  printf 'codex_model=%s\n' "$CODEX_MODEL"
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

# Claude blocks on an interactive "Is this a project you trust?" prompt before it
# connects any MCP server. In a detached tmux pane nobody answers it, so the
# launch looks healthy while the Telegram channel never comes up. Fail loudly on
# a positive "not trusted" determination; stay quiet when we cannot tell.
claude_trust_preflight() {
  local config="${CLAUDE_CONFIG_FILE:-$HOME/.claude.json}"
  [[ "${ORCH_SKIP_TRUST_CHECK:-0}" == "1" ]] && return 0
  [[ -r "$config" ]] || return 0
  # Claude keys trust by resolved cwd; WORK_DIR may arrive unnormalized
  # ("$SCRIPT_DIR/..") or symlinked. Accept a hit on any spelling — a false
  # "untrusted" would block launches that would actually have worked.
  local work_dir_real
  work_dir_real="$(cd "$WORK_DIR" 2>/dev/null && pwd -P)" || return 0
  local verdict
  verdict="$("$BUN_BIN" -e '
const [configPath, ...candidates] = process.argv.slice(1);
try {
  const config = JSON.parse(await Bun.file(configPath).text());
  if (!config || typeof config.projects !== "object" || config.projects === null) {
    process.stdout.write("unknown");
  } else {
    const trusted = candidates.some(
      (dir) => config.projects[dir]?.hasTrustDialogAccepted === true,
    );
    process.stdout.write(trusted ? "trusted" : "untrusted");
  }
} catch {
  process.stdout.write("unknown");
}
' "$config" "$WORK_DIR" "$work_dir_real" 2>/dev/null)" || return 0
  if [[ "$verdict" == "untrusted" ]]; then
    printf 'ERROR orchestrator-workdir-untrusted dir=%s config=%s\n' \
      "$WORK_DIR" "$config" >&2
    printf 'hint: claude would stall on the trust prompt and never connect MCP; run claude once in that directory and accept, or set ORCH_SKIP_TRUST_CHECK=1\n' >&2
    return 1
  fi
  return 0
}

# Codex has the same failure mode as Claude, keyed differently: an unaccepted
# work dir stops the TUI on "Do you trust the contents of this directory?" —
# observed live, and neither --dangerously-bypass-approvals-and-sandbox nor a
# `-c projects."<dir>".trust_level` override suppresses it (the check reads the
# persisted config, not overrides). In a detached pane nobody answers, so the
# session sits at a prompt while the launcher reports success. Same contract as
# claude_trust_preflight: fail only on a positive "untrusted" verdict.
codex_trust_preflight() {
  local config="${CODEX_HOME:-$HOME/.codex}/config.toml"
  [[ "${ORCH_SKIP_TRUST_CHECK:-0}" == "1" ]] && return 0
  [[ -r "$config" ]] || return 0
  local work_dir_real
  work_dir_real="$(cd "$WORK_DIR" 2>/dev/null && pwd -P)" || return 0
  local verdict
  verdict="$(awk -v a="$WORK_DIR" -v b="$work_dir_real" '
    /^[[:space:]]*\[/ {
      section = $0
      sub(/[[:space:]]+$/, "", section)
      target = (section == "[projects.\"" a "\"]" || section == "[projects.\"" b "\"]")
      next
    }
    target && /^[[:space:]]*trust_level[[:space:]]*=[[:space:]]*"trusted"[[:space:]]*$/ { found = 1 }
    END { print (found ? "trusted" : "untrusted") }
  ' "$config" 2>/dev/null)" || return 0
  if [[ "$verdict" == "untrusted" ]]; then
    printf 'ERROR orchestrator-workdir-untrusted dir=%s config=%s\n' \
      "$WORK_DIR" "$config" >&2
    printf 'hint: codex would stall on the directory trust prompt in a detached pane; run codex once in that directory and accept, or set ORCH_SKIP_TRUST_CHECK=1\n' >&2
    return 1
  fi
  return 0
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
      [[ -n "$CLAUDE_MODEL" ]] && printf 'exec claude --model %q --dangerously-skip-permissions%s%s' "$CLAUDE_MODEL" "$settings" "$mcp" || printf 'exec claude --dangerously-skip-permissions%s%s' "$settings" "$mcp"
      ;;
    codex)
      local relay="${ORCH_TURNEND_RELAY:-$SCRIPT_DIR/orchestrator-turnend-relay.sh}"
      local notify="" effort="" hooks=""
      if [[ -x "$relay" ]]; then
        printf -v notify ' --config notify=%q' "[\"$relay\"]"
      fi
      if [[ -n "$CODEX_REASONING_EFFORT" ]]; then
        printf -v effort ' --config model_reasoning_effort=%q' "\"$CODEX_REASONING_EFFORT\""
      fi
      if [[ -x "$CODEX_SESSION_HOOK" ]]; then
        # --dangerously-bypass-hook-trust is REQUIRED, not decorative: without
        # persisted trust codex drops the hook, and a headless tmux pane has no
        # way to answer the trust prompt, so the load fails silently and the
        # orchestrator boots blind. The hook source is this repository.
        printf -v hooks ' --dangerously-bypass-hook-trust --config hooks.SessionStart=%q' \
          "[{hooks=[{type=\"command\",command=\"$CODEX_SESSION_HOOK\"}]}]"
      fi
      printf 'exec codex --model %q --dangerously-bypass-approvals-and-sandbox%s%s%s' \
        "$CODEX_MODEL" "$effort" "$notify" "$hooks"
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
  if [[ "$PROVIDER" == claude ]] && ! claude_trust_preflight; then
    return 2
  fi
  if [[ "$PROVIDER" == codex ]] && ! codex_trust_preflight; then
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
  # These two renewals are liveness probes on a lease acquired seconds ago, and
  # they MUST carry the same TTL the acquire used. Without an explicit TTL the
  # CLI applies its 30s default, so a probe silently SHRANK a 120s lease to 30s
  # — measured live: session created at 1785424061, lease expires_at
  # 1785424095167, i.e. dead 34s after start with nothing left to renew it.
  if state_available && ! mission_cli lease renew "$owner" orchestrator "$token" "$LEASE_TTL_MS" >/dev/null 2>&1; then
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
  if state_available && ! mission_cli lease renew "$owner" orchestrator "$token" "$LEASE_TTL_MS" >/dev/null 2>&1; then
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
  model) model_report ;;
  -h|--help|help) usage ;;
  *) usage >&2; exit 2 ;;
esac
