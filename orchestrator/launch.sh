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
# shellcheck disable=SC1091
source "$SCRIPT_DIR/proc-identity.sh"

SESSION="${ORCH_SESSION:-orchestrator}"
WORK_DIR="${ORCH_WORK_DIR:-$PWD}"
RUNTIME_DIR="${ORCH_RUNTIME_DIR:-$SCRIPT_DIR/runtime}"
PROVIDER="${ORCH_PROVIDER:-codex}"
MODEL="${ORCH_MODEL:-}"
LOCK_FILE="${ORCH_LOCK_FILE:-$RUNTIME_DIR/launch.lock}"
AUTH_PREFLIGHT="${ORCH_AUTH_PREFLIGHT:-$SCRIPT_DIR/preflight-cli-auth.sh}"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SINGLETON_LOCK_FILE="${ORCH_SINGLETON_LOCK_FILE:-$REPO_DIR/runtime/orchestrator.singleton.lock}"
SINGLETON_RECOVERY_LOCK_FILE="${ORCH_SINGLETON_RECOVERY_LOCK_FILE:-$SINGLETON_LOCK_FILE.recovery}"
SINGLETON_OWNER_FILE="${ORCH_SINGLETON_OWNER_FILE:-$SINGLETON_LOCK_FILE.owner}"
MISSION_CLI="${ORCH_MISSION_CLI:-$REPO_DIR/core/mission-cli.ts}"
STATE_DB="${ORCH_STATE_DB:-$REPO_DIR/runtime/state.db}"
TERMINAL_ALERT="${ORCH_TERMINAL_ALERT:-$REPO_DIR/daemon/terminal-alert.ts}"
TERMINAL_ALERT_READY_FILE="${ORCH_TERMINAL_ALERT_READY_FILE:-$RUNTIME_DIR/terminal-alert.ready}"
# One number, shared with watchdog.sh, which is the only renewer. 180000 is
# three ticks at the 60s default watchdog interval; watchdog.sh explains why two
# ticks EXACTLY is not enough. Keep the two defaults identical — cadence-knob.test.sh
# fails if they drift.
LEASE_TTL_MS="${ORCH_LEASE_TTL_MS:-180000}"
READINESS_WINDOW_MS="${ORCH_READINESS_WINDOW_MS:-3000}"
READINESS_POLL_SECONDS="${ORCH_READINESS_POLL_SECONDS:-0.15}"
LEASE_FILE="${ORCH_LEASE_FILE:-$RUNTIME_DIR/orchestrator.lease}"
HEARTBEAT_FILE="${ORCH_HEARTBEAT_FILE:-$RUNTIME_DIR/orchestrator.heartbeat}"
# Positive in-turn liveness (see orchestrator-liveness-pulse.sh): the pulse
# loop is started INSIDE the supervised pane, watching the provider PID, so
# the signal is owned by the supervised process tree and dies with it. The
# file path and interval are baked into the pane command rather than passed
# through the environment, because a pre-existing tmux server hands panes ITS
# environment, not this launcher's.
LIVENESS_FILE="${ORCH_LIVENESS_FILE:-$RUNTIME_DIR/orchestrator.liveness}"
LIVENESS_PULSE="${ORCH_LIVENESS_PULSE:-$SCRIPT_DIR/orchestrator-liveness-pulse.sh}"
LIVENESS_PULSE_INTERVAL="${ORCH_LIVENESS_PULSE_INTERVAL:-30}"
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
# ONE hook script rather than forking the loader per vendor. For codex it is
# declared inline via --config instead of a hooks.json file: a repo-local
# $CODEX_HOME would be written into by codex (tui.model_availability_nux
# counters), leaving the tree dirty and every session load reporting
# `startup: degraded`, and the real $CODEX_HOME is shared with every other codex
# process on the box. For claude it is declared in the settings JSON below,
# beside the Stop relay.
#
# The default is a TRACKED path inside this repository. It used to be
# $REPO_DIR/.claude/hooks/session-load.sh — a file in no commit and on no host,
# wired to codex only, and guarded by a `[[ -x ]]` test that skipped it in
# silence. The claude branch, which is what actually runs here, declared no
# SessionStart hook at all, so every boot came up with no standing context and
# said nothing about it. ORCH_CODEX_SESSION_HOOK is still read so an existing
# runtime.env keeps working, but it no longer selects a per-vendor script:
# there is one hook and both branches wire it.
SESSION_HOOK="${ORCH_SESSION_HOOK:-${ORCH_CODEX_SESSION_HOOK:-$SCRIPT_DIR/hooks/session-start.sh}}"
BOUND_CHAT_ID="${TELEGRAM_BOUND_CHAT_ID:-${TELEGRAM_CHAT_ID:-}}"
INSTANCE_LOCK_FILE="${ORCH_INSTANCE_LOCK_FILE:-${BOUND_CHAT_ID:+$HOME/.claude/orchestrator-chat-$BOUND_CHAT_ID.lock}}"

usage() {
  printf '%s\n' 'Usage: launch.sh [start|stop|status|model|identity|render-command|--help]'
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

identity_report() {
  printf 'session=%s\nruntime_dir=%s\nstate_db=%s\nlease_file=%s\nlauncher=%s\nconfig_file=%s\n' \
    "$SESSION" "$RUNTIME_DIR" "$STATE_DB" "$LEASE_FILE" "$SCRIPT_DIR/launch.sh" "$CONFIG_FILE"
}

# Renders exactly the command line `start` would exec into the pane, and
# refuses (exit 2) on exactly the same missing-mechanism conditions. This is
# the seam session-hook-wiring.test.sh asserts against: without it a drift test
# could only prove the hook is referenced in the SOURCE of launch.sh, which is
# the same class of "checked something adjacent to the real property" the
# audits keep finding. Starting nothing, it can assert what a start would wire.
#
# Not read-only: it materializes the same settings/MCP files build_command
# writes, so point ORCH_RUNTIME_DIR at a scratch dir when probing a live host.
command_report() {
  local rendered
  if ! rendered="$(build_command)"; then
    return 2
  fi
  printf '%s\n' "$rendered"
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

# ── Fail-closed wiring of the mechanisms declared to the provider ───────────
# The session hook used to sit behind `if [[ -x "$path" ]]` whose false branch
# wired nothing and printed nothing, so "the hook is missing" and "the session
# is healthy" rendered identically. Hard Floor 7: a missing mechanism is a
# refusal that names the path, never a silent omission.
#
# The two relay guards below are the same defect class and are NOT yet routed
# through this function — deliberately, and only until V3-5.6 lands. See the
# citation at each guard.
require_mechanism() {
  local kind="$1" path="$2" reason
  if [[ -x "$path" ]]; then
    return 0
  fi
  if [[ -e "$path" ]]; then reason="not executable"; else reason="missing"; fi
  printf 'ERROR orchestrator-%s-unavailable path=%s reason=%s provider=%s\n' \
    "$kind" "$path" "$reason" "$PROVIDER" >&2
  printf 'hint: refusing to start a session with %s silently unwired; restore the tracked file (git ls-files + executable bit).\n' \
    "$kind" >&2
  return 1
}

# Break-glass, mirroring dispatch-check.ts's DISPATCH_OVERRIDE: one explicit,
# greppable variable, refused when set-but-empty, and journaled to the same ops
# journal on every use — an escape hatch nobody can take quietly. It exists for
# a lane repairing this tooling, which would otherwise be unable to launch a
# session to repair it with.
OPS_JOURNAL="${ORCH_OPS_JOURNAL:-$REPO_DIR/orchestrator/runtime/ops-journal.log}"

journal_override() {
  local kind="$1" reason="$2" ts encoded
  mkdir -p "$(dirname "$OPS_JOURNAL")" || return 1
  ts="$(date --iso-8601=seconds)" || return 1
  # JSON-escape the reason so a newline in it cannot forge a second row.
  encoded="$(printf '%s' "$reason" | "$BUN_BIN" -e '
process.stdout.write(JSON.stringify(await Bun.stdin.text()));
')" || return 1
  [[ -n "$encoded" ]] || return 1
  printf '%s\tORCH_SKIP_SESSION_HOOK\tkind=%s\tprovider=%s\treason=%s\n' \
    "$ts" "$kind" "$PROVIDER" "$encoded" >> "$OPS_JOURNAL" || return 1
  return 0
}

# Sets SESSION_HOOK_WIRED to 1 (wire it) or 0 (break-glass skip). A non-zero
# return means the launch must refuse.
SESSION_HOOK_WIRED=0
resolve_session_hook() {
  SESSION_HOOK_WIRED=0
  if [[ -n "${ORCH_SKIP_SESSION_HOOK+set}" ]]; then
    local reason="$ORCH_SKIP_SESSION_HOOK"
    if [[ -z "${reason//[[:space:]]/}" ]]; then
      printf 'ERROR orchestrator-session-hook-override-empty\n' >&2
      printf 'hint: ORCH_SKIP_SESSION_HOOK is set but empty — a break-glass override MUST carry a reason ("1" is accepted).\n' >&2
      return 2
    fi
    if ! journal_override session-hook "$reason"; then
      printf 'ERROR orchestrator-session-hook-override-unjournalable journal=%s\n' "$OPS_JOURNAL" >&2
      printf 'hint: a break-glass use that cannot be recorded is refused, exactly as dispatch-check.ts refuses an unjournalable DISPATCH_OVERRIDE.\n' >&2
      return 2
    fi
    printf 'WARN orchestrator-session-hook-skipped reason=%s journal=%s; this session loads NO standing context — it is a fail-closed NO-GO for dispatch until the load is run by hand\n' \
      "$reason" "$OPS_JOURNAL" >&2
    return 0
  fi
  require_mechanism session-hook "$SESSION_HOOK" || return 2
  SESSION_HOOK_WIRED=1
  return 0
}

build_command() {
  resolve_session_hook || return 2
  case "$PROVIDER" in
    claude)
      local relay="${ORCH_CLAUDE_STOP_RELAY:-$SCRIPT_DIR/orchestrator-claude-stop-relay.sh}"
      local settings="" settings_tmp hook_arg="" relay_arg=""
      # DELIBERATELY FAIL-OPEN, AND ONLY UNTIL V3-5.6.
      # orchestrator-claude-stop-relay.sh exists in no commit and on no host, so
      # routing this through require_mechanism refuses every claude launch —
      # including the live orchestrator, the operator's only channel here. The
      # missing relays and the fourteen hours of dead heartbeat they caused are
      # measured in instance/incidents/2026-08-05-the-heartbeat-has-had-no-writer-since-yesterday.md;
      # workboard row V3-5.6 restores the tracked relays and closes this guard.
      # Restoring the status quo is what this comment exists to make expensive:
      # if V3-5.6 is closed and this guard is still here, this guard is the bug.
      if [[ -x "$relay" ]]; then relay_arg="$relay"; fi
      if (( SESSION_HOOK_WIRED )); then hook_arg="$SESSION_HOOK"; fi
      # The claude branch declared NO SessionStart hook at all — the whole
      # standing-context load was codex-only, on a path that did not exist. The
      # settings file this already writes for the Stop relay is the natural
      # carrier, so both hooks arrive through one artifact. The hook does NOT
      # depend on the relay: on this host the relay is absent today, and that
      # must not take the standing-context load down with it.
      if [[ -n "$relay_arg" || -n "$hook_arg" ]]; then
        mkdir -p "$(dirname "$CLAUDE_RELAY_SETTINGS")"
        settings_tmp="$(mktemp "$(dirname "$CLAUDE_RELAY_SETTINGS")/.claude-relay-settings.XXXXXX")"
        "$BUN_BIN" -e '
const [, relay, hook] = process.argv;
const settings = { hooks: {} };
if (relay) {
  settings.hooks.Stop = [{
    hooks: [{ type: "command", command: relay }],
  }];
}
if (hook) {
  settings.hooks.SessionStart = [{
    hooks: [{ type: "command", command: hook }],
  }];
}
process.stdout.write(JSON.stringify(settings, null, 2) + "\n");
' "$relay_arg" "$hook_arg" > "$settings_tmp"
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
      # Claude refuses --dangerously-skip-permissions under root unless the
      # caller explicitly declares this already-isolated control-plane host.
      # Keep the declaration inside the Claude command: it must not bleed into
      # codex or the daemon.
      [[ -n "$CLAUDE_MODEL" ]] && printf 'export IS_SANDBOX=1; exec claude --model %q --dangerously-skip-permissions%s%s' "$CLAUDE_MODEL" "$settings" "$mcp" || printf 'export IS_SANDBOX=1; exec claude --dangerously-skip-permissions%s%s' "$settings" "$mcp"
      ;;
    codex)
      local relay="${ORCH_TURNEND_RELAY:-$SCRIPT_DIR/orchestrator-turnend-relay.sh}"
      local notify="" effort="" hooks=""
      # DELIBERATELY FAIL-OPEN, AND ONLY UNTIL V3-5.6.
      # orchestrator-turnend-relay.sh exists in no commit and on no host. It is
      # also the single ongoing writer of the heartbeat file (watchdog.sh:348-350),
      # so its absence has left that signal dead since 2026-08-04 18:13, masked by
      # the tmux pane-activity fallback:
      # instance/incidents/2026-08-05-the-heartbeat-has-had-no-writer-since-yesterday.md.
      # Workboard row V3-5.6 owns the relay's contract — heartbeat write included —
      # and closes this guard. Authoring that contract from a session-hook lane is
      # how a plausible wrong thing ships, so the guard stays open one more day
      # instead. If V3-5.6 is closed and this guard is still here, this guard is
      # the bug.
      if [[ -x "$relay" ]]; then
        printf -v notify ' --config notify=%q' "[\"$relay\"]"
      fi
      if [[ -n "$CODEX_REASONING_EFFORT" ]]; then
        printf -v effort ' --config model_reasoning_effort=%q' "\"$CODEX_REASONING_EFFORT\""
      fi
      if (( SESSION_HOOK_WIRED )); then
        # --dangerously-bypass-hook-trust is REQUIRED, not decorative: without
        # persisted trust codex drops the hook, and a headless tmux pane has no
        # way to answer the trust prompt, so the load fails silently and the
        # orchestrator boots blind. The hook source is this repository — the
        # same tracked file the claude branch declares in its settings JSON.
        printf -v hooks ' --dangerously-bypass-hook-trust --config hooks.SessionStart=%q' \
          "[{hooks=[{type=\"command\",command=\"$SESSION_HOOK\"}]}]"
      fi
      printf 'exec codex --model %q --dangerously-bypass-approvals-and-sandbox%s%s%s' \
        "$CODEX_MODEL" "$effort" "$notify" "$hooks"
      ;;
    *) printf 'unsupported provider: %s\n' "$PROVIDER" >&2; return 2 ;;
  esac
}

process_identity_state() {
  local recorded_pid="$1" recorded_starttime="$2" current_starttime
  if ! [[ "$recorded_pid" =~ ^[1-9][0-9]*$ && "$recorded_starttime" =~ ^[0-9]+$ ]]; then
    printf 'unknown\n'
    return 0
  fi
  if [[ ! -d "/proc/$recorded_pid" ]]; then
    printf 'gone\n'
    return 0
  fi
  current_starttime="$(proc_starttime "$recorded_pid")"
  if [[ -z "$current_starttime" ]]; then
    printf 'unknown\n'
  elif [[ "$current_starttime" == "$recorded_starttime" ]]; then
    printf 'live\n'
  else
    # The PID was recycled. The process recorded by the launcher is gone even
    # though an unrelated process now has its numeric PID.
    printf 'gone\n'
  fi
}

singleton_lock_key() {
  local path="$1" major_minor inode
  major_minor="$(findmnt -T "$path" -n -o MAJ:MIN 2>/dev/null | tr -d '[:space:]')"
  inode="$(stat -Lc '%i' "$path" 2>/dev/null || true)"
  [[ "$major_minor" =~ ^[0-9]+:[0-9]+$ && "$inode" =~ ^[0-9]+$ ]] ||
    return 1
  printf '%s:%s\n' "$major_minor" "$inode"
}

singleton_kernel_owner_pid() {
  local target_key="$1"
  local lock_type pid kernel_key
  local major_hex minor_hex inode normalized_key
  local -a owners=() fields=()
  while read -ra fields; do
    lock_type="${fields[1]:-}"
    pid="${fields[4]:-}"
    kernel_key="${fields[5]:-}"
    [[ "$lock_type" == FLOCK ]] || continue
    IFS=: read -r major_hex minor_hex inode <<<"$kernel_key"
    [[ "$major_hex" =~ ^[0-9A-Fa-f]+$ && "$minor_hex" =~ ^[0-9A-Fa-f]+$ &&
       "$inode" =~ ^[0-9]+$ ]] || continue
    normalized_key="$((16#$major_hex)):$((16#$minor_hex)):$inode"
    [[ "$normalized_key" == "$target_key" ]] || continue
    [[ " ${owners[*]} " == *" $pid "* ]] || owners+=("$pid")
  done < /proc/locks
  ((${#owners[@]} == 1)) && [[ "${owners[0]}" =~ ^[1-9][0-9]*$ ]] &&
    printf '%s\n' "${owners[0]}"
}

stale_singleton_recovery_proven() {
  local current_key="$1"
  local recorded_pid="" recorded_starttime="" recorded_key="" recorded_lock_owner=""
  local source="shared-owner" kernel_owner state
  if [[ -r "$SINGLETON_OWNER_FILE" ]]; then
    recorded_pid="$(sed -n 's/^provider_pid=//p' "$SINGLETON_OWNER_FILE")"
    recorded_starttime="$(sed -n 's/^provider_starttime=//p' "$SINGLETON_OWNER_FILE")"
    recorded_lock_owner="$(sed -n 's/^lock_owner_pid=//p' "$SINGLETON_OWNER_FILE")"
    recorded_key="$(sed -n 's/^lock_key=//p' "$SINGLETON_OWNER_FILE")"
    [[ "$recorded_key" == "$current_key" ]] || return 1
  else
    # One-time compatibility for a lock leaked by the pre-owner-record
    # launcher. The per-runtime identity is not authority by itself: it is
    # accepted only when /proc/locks ties that exact original PID to the
    # currently locked inode.
    source="legacy-liveness"
    [[ -r "$LIVENESS_FILE.identity" ]] || return 1
    recorded_pid="$(sed -n 's/^pid=//p' "$LIVENESS_FILE.identity")"
    recorded_starttime="$(sed -n 's/^starttime=//p' "$LIVENESS_FILE.identity")"
    recorded_lock_owner="$recorded_pid"
  fi
  [[ "$recorded_lock_owner" =~ ^[1-9][0-9]*$ ]] || return 1
  state="$(process_identity_state "$recorded_pid" "$recorded_starttime")"
  [[ "$state" == gone ]] || return 1
  kernel_owner="$(singleton_kernel_owner_pid "$current_key")"
  [[ -n "$kernel_owner" && "$kernel_owner" == "$recorded_lock_owner" ]] || return 1
  printf '%s\n' "$source"
}

start() {
  local singleton_guard_fd singleton_recovery_fd
  local stale_lock_key recovery_source
  mkdir -p "$RUNTIME_DIR" "$(dirname "$SINGLETON_LOCK_FILE")" \
    "$(dirname "$SINGLETON_RECOVERY_LOCK_FILE")"
  umask 077
  : >> "$SINGLETON_LOCK_FILE"
  chmod 0600 "$SINGLETON_LOCK_FILE"
  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    printf 'launch already in progress\n' >&2
    return 1
  fi
  # Serialize acquisition and stale-inode recovery independently of
  # ORCH_RUNTIME_DIR. A per-runtime launch mutex cannot protect two differently
  # named sessions that share this process singleton.
  exec {singleton_recovery_fd}>"$SINGLETON_RECOVERY_LOCK_FILE"
  if ! flock -n "$singleton_recovery_fd"; then
    exec {singleton_recovery_fd}>&-
    printf 'ERROR orchestrator-singleton-recovery-in-progress lock=%s\n' \
      "$SINGLETON_RECOVERY_LOCK_FILE" >&2
    return 1
  fi
  # Reserve the process singleton in the caller before creating tmux.  The
  # previous design let the pane race pipe-pane/readiness: when another
  # orchestrator held the lock, tmux removed the dead pane first and the caller
  # leaked the incidental "can't find pane" error instead of the refusal.
  # Keep this descriptor until the terminal-alert consumer is ready.  The pane
  # blocks on the same lock, then takes ownership as soon as we close it.
  exec {singleton_guard_fd}>"$SINGLETON_LOCK_FILE"
  if ! flock -n "$singleton_guard_fd"; then
    exec {singleton_guard_fd}>&-
    # Never rotate merely because a lock is held: that would let a second
    # provider start on a new inode while the first remains live on the old
    # one. Recovery requires BOTH no target tmux session and affirmative,
    # reuse-safe proof that the provider recorded beside liveness is gone.
    stale_lock_key="$(singleton_lock_key "$SINGLETON_LOCK_FILE" || true)"
    recovery_source=""
    if [[ -n "$stale_lock_key" ]] && ! session_exists; then
      recovery_source="$(stale_singleton_recovery_proven "$stale_lock_key" || true)"
    fi
    if [[ -z "$recovery_source" ]]; then
      printf 'ERROR orchestrator-singleton-held lock=%s recovery=unproven\n' \
        "$SINGLETON_LOCK_FILE" >&2
      return 1
    fi
    rm -f "$SINGLETON_LOCK_FILE"
    : > "$SINGLETON_LOCK_FILE"
    chmod 0600 "$SINGLETON_LOCK_FILE"
    exec {singleton_guard_fd}>"$SINGLETON_LOCK_FILE"
    if ! flock -n "$singleton_guard_fd"; then
      exec {singleton_guard_fd}>&-
      printf 'ERROR orchestrator-singleton-recovery-raced lock=%s stale_key=%s\n' \
        "$SINGLETON_LOCK_FILE" "$stale_lock_key" >&2
      return 1
    fi
    printf 'WARN orchestrator-singleton-stale-recovered lock=%s stale_key=%s source=%s\n' \
      "$SINGLETON_LOCK_FILE" "$stale_lock_key" "$recovery_source" >&2
  fi
  if session_exists; then
    exec {singleton_guard_fd}>&-
    printf 'session already exists: %s\n' "$SESSION" >&2
    return 1
  fi
  local status_output="" held_owner=""
  if state_available; then
    mission_cli reap {singleton_guard_fd}>&- {singleton_recovery_fd}>&-
    status_output="$(mission_cli status {singleton_guard_fd}>&- {singleton_recovery_fd}>&-)"
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
  local command provider_bin singleton_command startup_file handoff_file acquired_file provider_stage_file pane_pid provider_pid pane_pipe terminal_alert_bun terminal_alert_command terminal_alert_ready
  # build_command is fail-closed: a missing session hook or relay refuses here
  # rather than starting a session with the mechanism silently unwired.
  if ! command="$(build_command)"; then
    return 2
  fi
  provider_bin="$PROVIDER"
  command -v "$provider_bin" >/dev/null 2>&1 || { printf 'provider not found: %s\n' "$provider_bin" >&2; return 2; }
  startup_file="$RUNTIME_DIR/orchestrator.startup"
  handoff_file="$RUNTIME_DIR/orchestrator.singleton.handoff"
  acquired_file="$RUNTIME_DIR/orchestrator.singleton.acquired"
  provider_stage_file="$RUNTIME_DIR/orchestrator.provider-stage"
  rm -f "$startup_file" "$handoff_file" "$acquired_file" "$provider_stage_file"
  # The pulse is backgrounded from the pane shell just before it exec's into
  # the provider, watching "$$" — which after the exec IS the provider PID. A
  # missing pulse script degrades to alert-only liveness in the watchdog
  # (never a kill), but say so loudly at launch time.
  local pulse_command=""
  if [[ -x "$LIVENESS_PULSE" ]]; then
    printf -v pulse_command '( exec 8>&-; %q "$$" %q %q ) & ' \
      "$LIVENESS_PULSE" "$LIVENESS_FILE" "$LIVENESS_PULSE_INTERVAL"
  else
    printf 'WARN liveness-pulse-missing path=%s; the watchdog cannot distinguish a silent turn from a corpse and will only alert\n' \
      "$LIVENESS_PULSE" >&2
  fi
  # shellcheck disable=SC2016 # This is a command template evaluated by pane sh.
  printf -v singleton_command \
    'i=0; while [ ! -f %q ]; do i=$((i+1)); [ "$i" -lt 500 ] || { printf "ERROR orchestrator-singleton-handoff-timeout\\n" >&2; exit 74; }; sleep 0.01; done; exec 8>%q; flock -n 8 || { printf "ERROR orchestrator-singleton-held lock=%%s\\n" %q >&2; exit 73; }; printf "%%s\\n" "$$" > %q; i=0; while [ ! -f %q ]; do i=$((i+1)); [ "$i" -lt 1000 ] || { printf "ERROR orchestrator-startup-marker-timeout\\n" >&2; exit 75; }; sleep 0.01; done; . %q; %s: > %q; %s' \
    "$handoff_file" "$SINGLETON_LOCK_FILE" "$SINGLETON_LOCK_FILE" \
    "$acquired_file" "$startup_file" "$startup_file" "$pulse_command" \
    "$provider_stage_file" "$command"
  # Do not leak the launch mutex into tmux/the provider process.
  exec 9>&-
  # The singleton and recovery descriptors belong only to this launcher. The
  # tmux client/server and pane command must never inherit either descriptor.
  if ! tmux new-session -d -s "$SESSION" -c "$WORK_DIR" \
    "sh -c $(printf '%q' "$singleton_command")" \
    {singleton_guard_fd}>&- {singleton_recovery_fd}>&-; then
    exec {singleton_guard_fd}>&-
    return 1
  fi
  terminal_alert_bun="$(command -v bun)"
  terminal_alert_ready="$TERMINAL_ALERT_READY_FILE"
  rm -f "$terminal_alert_ready"
  if [[ -f "$TERMINAL_ALERT" ]]; then
    printf -v terminal_alert_command 'exec %q %q --session %q --ready-file %q' \
      "$terminal_alert_bun" "$TERMINAL_ALERT" "$SESSION" "$terminal_alert_ready"
  else
    # The v3 bootstrap allowlist deliberately excludes daemon/terminal-alert.ts.
    # Keep pipe ownership/readiness bounded without importing that daemon seam;
    # supervisor.ts owns durable recovery escalation through the outbox.
    printf 'WARN terminal-alert-missing path=%s; using drain-only bootstrap pipe\n' "$TERMINAL_ALERT" >&2
    printf -v terminal_alert_command 'touch %q; exec cat >/dev/null' "$terminal_alert_ready"
  fi
  if ! tmux pipe-pane -o -t "$SESSION" "$terminal_alert_command"; then
    printf 'ERROR terminal-alert-pipe-failed session=%s\n' "$SESSION" >&2
    tmux kill-session -t "$SESSION" 2>/dev/null || true
    exec {singleton_guard_fd}>&-
    return 1
  fi
  # pipe-pane reports only that its child was spawned. Require an affirmative
  # readiness handshake from the classifier, not merely a briefly live pipe.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 0.1
    pane_pipe="$(tmux list-panes -t "$SESSION" -F '#{pane_pipe}' | head -n 1)"
    [[ "$pane_pipe" == 1 && -f "$terminal_alert_ready" ]] && break
  done
  if [[ "$pane_pipe" != 1 || ! -f "$terminal_alert_ready" ]]; then
    printf 'ERROR terminal-alert-not-ready session=%s\n' "$SESSION" >&2
    tmux kill-session -t "$SESSION" 2>/dev/null || true
    rm -f "$terminal_alert_ready"
    exec {singleton_guard_fd}>&-
    return 1
  fi
  # Hand singleton ownership to the already-observable pane.
  exec {singleton_guard_fd}>&-
  : > "$handoff_file"
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    [[ -f "$acquired_file" ]] && break
    session_exists || break
    sleep 0.05
  done
  if ! session_exists || [[ ! -f "$acquired_file" ]]; then
    printf 'ERROR orchestrator-singleton-acquire-timeout lock=%s\n' "$SINGLETON_LOCK_FILE" >&2
    tmux kill-session -t "$SESSION" 2>/dev/null || true
    return 1
  fi
  pane_pid="$(tmux list-panes -t "$SESSION" -F '#{pane_pid}' | head -n 1)"
  [[ "$pane_pid" =~ ^[1-9][0-9]*$ ]] || {
    printf 'ERROR orchestrator-instance-pid-invalid\n' >&2
    tmux kill-session -t "$SESSION" 2>/dev/null || true
    return 1
  }
  provider_pid="$(cat "$acquired_file" 2>/dev/null || true)"
  if ! [[ "$provider_pid" =~ ^[1-9][0-9]*$ ]] ||
     ! kill -0 "$provider_pid" 2>/dev/null; then
    printf 'ERROR orchestrator-provider-pid-invalid pane_pid=%s provider_pid=%s\n' \
      "$pane_pid" "${provider_pid:-missing}" >&2
    tmux kill-session -t "$SESSION" 2>/dev/null || true
    return 1
  fi
  local singleton_lock_identity singleton_kernel_owner singleton_owner_tmp
  singleton_lock_identity="$(singleton_lock_key "$SINGLETON_LOCK_FILE" || true)"
  singleton_kernel_owner="$(singleton_kernel_owner_pid "$singleton_lock_identity")"
  if [[ -z "$singleton_lock_identity" || ! "$singleton_kernel_owner" =~ ^[1-9][0-9]*$ ]]; then
    printf 'ERROR orchestrator-singleton-owner-unverified provider_pid=%s kernel_owner=%s\n' \
      "$provider_pid" "${singleton_kernel_owner:-unknown}" >&2
    tmux kill-session -t "$SESSION" 2>/dev/null || true
    return 1
  fi
  singleton_owner_tmp="$(mktemp "$(dirname "$SINGLETON_OWNER_FILE")/.orchestrator-singleton-owner.XXXXXX")"
  printf 'provider_pid=%s\nprovider_starttime=%s\nlock_owner_pid=%s\nlock_key=%s\n' \
    "$provider_pid" "$(proc_starttime "$provider_pid")" "$singleton_kernel_owner" \
    "$singleton_lock_identity" > "$singleton_owner_tmp"
  mv -f "$singleton_owner_tmp" "$SINGLETON_OWNER_FILE"
  if state_available; then
    local lease_output owner token
    owner="$(hostname):$provider_pid"
    if ! lease_output="$(mission_cli lease acquire "$owner" orchestrator "$LEASE_TTL_MS" \
      {singleton_recovery_fd}>&- 2>&1)"; then
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
    mission_cli status {singleton_recovery_fd}>&-
  else
    printf 'SKIP state-db-absent path=%s\n' "$STATE_DB" >&2
    : > "$startup_file"
  fi
  # These two renewals are liveness probes on a lease acquired seconds ago, and
  # they MUST carry the same TTL the acquire used. Without an explicit TTL the
  # CLI applies its 30s default, so a probe silently SHRANK a 120s lease to 30s
  # — measured live: session created at 1785424061, lease expires_at
  # 1785424095167, i.e. dead 34s after start with nothing left to renew it.
  if state_available && ! mission_cli lease renew "$owner" orchestrator "$token" \
    "$LEASE_TTL_MS" {singleton_recovery_fd}>&- >/dev/null 2>&1; then
    tmux kill-session -t "$SESSION" 2>/dev/null || true
    release_current_lease
    printf 'ERROR orchestrator-lease-renew-failed owner=%s\n' "$owner" >&2
    return 1
  fi
  local readiness_deadline
  readiness_deadline="$(( $(now_ms) + READINESS_WINDOW_MS ))"
  while (( $(now_ms) < readiness_deadline )); do
    if ! session_exists || ! kill -0 "$provider_pid" 2>/dev/null; then
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
  if ! session_exists || ! kill -0 "$provider_pid" 2>/dev/null ||
     [[ ! -f "$provider_stage_file" ]]; then
    tmux kill-session -t "$SESSION" 2>/dev/null || true
    if state_available; then
      release_current_lease
    else
      rm -f "$LEASE_FILE"
    fi
    printf 'ERROR orchestrator-provider-start-failed provider=%s session=%s stage=%s\n' \
      "$PROVIDER" "$SESSION" "$([[ -f "$provider_stage_file" ]] && printf reached || printf missing)" >&2
    return 1
  fi
  if state_available && ! mission_cli lease renew "$owner" orchestrator "$token" \
    "$LEASE_TTL_MS" {singleton_recovery_fd}>&- >/dev/null 2>&1; then
    tmux kill-session -t "$SESSION" 2>/dev/null || true
    release_current_lease
    printf 'ERROR orchestrator-lease-renew-failed owner=%s\n' "$owner" >&2
    return 1
  fi
  mkdir -p "$(dirname "$HEARTBEAT_FILE")" "$(dirname "$LIVENESS_FILE")"
  printf '%s\n' "$(date +%s)" > "$HEARTBEAT_FILE"
  # Seed the liveness stamp so the very first pulse interval is covered even if
  # the in-pane loop is slow to start; from here on the pulse owns renewal.
  printf '%s\n' "$(date +%s)" > "$LIVENESS_FILE"
  # Seed the provider identity beside the stamp: pid= plus the reuse-safe
  # starttime= (/proc/<pid>/stat field 22; fixed at fork, survives the pane
  # shell's exec into the provider). The watchdog may kill on a stale stamp
  # ONLY against affirmative proof that THIS identity is gone — so the fence
  # holds even if the in-pane pulse crashes before writing its own record.
  printf 'pid=%s\nstarttime=%s\n' "$provider_pid" "$(proc_starttime "$provider_pid")" > "$LIVENESS_FILE.identity"
  if [[ -n "$INSTANCE_LOCK_FILE" ]]; then
    local lock_tmp
    mkdir -p "$(dirname "$INSTANCE_LOCK_FILE")"
    lock_tmp="$(mktemp "$(dirname "$INSTANCE_LOCK_FILE")/.orchestrator-lock.XXXXXX")"
    printf '{"pid":%s,"pid_started_at":"%s"}\n' \
      "$provider_pid" "$(date --iso-8601=seconds)" > "$lock_tmp"
    mv -f "$lock_tmp" "$INSTANCE_LOCK_FILE"
  fi
  exec {singleton_recovery_fd}>&-
  rm -f "$handoff_file" "$acquired_file" "$provider_stage_file"
  printf 'started: %s (%s)\n' "$SESSION" "$PROVIDER"
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  model) model_report ;;
  identity) identity_report ;;
  render-command) command_report ;;
  -h|--help|help) usage ;;
  *) usage >&2; exit 2 ;;
esac
