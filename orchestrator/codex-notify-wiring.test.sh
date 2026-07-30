#!/usr/bin/env bash
# Regression lock: everything a Codex top orchestrator needs to be more than a
# blind, unpinned CLI must be on the launch command line.
#
#   --model <pinned>                    a launch with no --model silently takes
#                                       whatever the account defaults to
#   --config model_reasoning_effort     codex defaults to `none` on this box
#   --config notify=[…relay]            the ONLY turn-end path codex has
#   --config hooks.SessionStart=[…]     standing-context load at session start
#   --dangerously-bypass-hook-trust     without it codex drops the hook, and a
#                                       headless tmux pane cannot answer the
#                                       trust prompt, so the load fails silently
#
# The launcher is exercised for real: a `codex` shim on PATH records its argv,
# and a `tmux` shim confines the session to a private tmux socket so the live
# orchestrator session is never touched.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SCRATCH="$(mktemp -d)"
TMUX_SOCKET="codex-notify-wiring-$$"
cleanup() {
  tmux -L "$TMUX_SOCKET" kill-server 2>/dev/null || true
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

mkdir -p "$SCRATCH/bin" "$SCRATCH/runtime"
cat > "$SCRATCH/bin/tmux" <<'EOF'
#!/usr/bin/env bash
exec /usr/bin/tmux -L "${ORCH_TEST_TMUX_SOCKET:?}" "$@"
EOF
cat > "$SCRATCH/bin/codex" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" > "${ORCH_TEST_CODEX_ARGS:?}"
exec sleep 1000
EOF
cat > "$SCRATCH/preflight.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$SCRATCH/bin/tmux" "$SCRATCH/bin/codex" "$SCRATCH/preflight.sh"

export PATH="$SCRATCH/bin:$PATH"
export ORCH_TEST_TMUX_SOCKET="$TMUX_SOCKET"
export ORCH_TEST_CODEX_ARGS="$SCRATCH/codex-args"
export ORCH_CONFIG_FILE="$SCRATCH/no-runtime.env"
export ORCH_RUNTIME_DIR="$SCRATCH/runtime"
export ORCH_SINGLETON_LOCK_FILE="$SCRATCH/orchestrator.singleton.lock"
export ORCH_STATE_DB="$SCRATCH/absent-state.db"
export ORCH_AUTH_PREFLIGHT="$SCRATCH/preflight.sh"
export ORCH_PROVIDER=codex
export ORCH_SESSION="codex-notify-wiring-test"
export ORCH_WORK_DIR="$REPO_DIR"

arg_after() { sed -n "/^$1\$/{n;p;q;}" "$ORCH_TEST_CODEX_ARGS"; }

# A $CODEX_HOME whose config.toml trusts the work dir. Without it the codex TUI
# stops on the directory-trust prompt in a pane nobody can answer.
export CODEX_HOME="$SCRATCH/codex-home"
mkdir -p "$CODEX_HOME"
printf '[projects."%s"]\ntrust_level = "trusted"\n' "$(cd "$REPO_DIR" && pwd -P)" \
  > "$CODEX_HOME/config.toml"

# ── Defaults: no runtime.env at all, which is how this box was found ────────
"$SCRIPT_DIR/launch.sh" start
"$SCRIPT_DIR/launch.sh" stop

grep -Fxq -- '--dangerously-bypass-approvals-and-sandbox' "$ORCH_TEST_CODEX_ARGS"
grep -Fxq -- '--dangerously-bypass-hook-trust' "$ORCH_TEST_CODEX_ARGS"

model="$(arg_after '--model')"
[[ "$model" == 'gpt-5.6-sol' ]] || {
  printf 'model not pinned: %s\n' "${model:-<absent>}" >&2
  exit 1
}

effort="$(grep -F 'model_reasoning_effort=' "$ORCH_TEST_CODEX_ARGS" || true)"
[[ "$effort" == 'model_reasoning_effort="high"' ]] || {
  printf 'reasoning effort not set to a value adequate for judgement: %s\n' \
    "${effort:-<absent>}" >&2
  exit 1
}

notify="$(grep -F 'notify=' "$ORCH_TEST_CODEX_ARGS" || true)"
[[ "$notify" == "notify=[\"$SCRIPT_DIR/orchestrator-turnend-relay.sh\"]" ]] || {
  printf 'turn-end relay not wired: %s\n' "${notify:-<absent>}" >&2
  exit 1
}

hooks="$(grep -F 'hooks.SessionStart=' "$ORCH_TEST_CODEX_ARGS" || true)"
[[ "$hooks" == "hooks.SessionStart=[{hooks=[{type=\"command\",command=\"$REPO_DIR/.claude/hooks/session-load.sh\"}]}]" ]] || {
  printf 'session-start context hook not wired: %s\n' "${hooks:-<absent>}" >&2
  exit 1
}
# The hook script the launcher names must exist and be runnable, or the whole
# argument is decoration.
[[ -x "$REPO_DIR/.claude/hooks/session-load.sh" ]]

# Every --config value must survive as ONE argv element: codex parses
# `key=value` per argument, so a value split by quoting is silently misread.
config_count="$(grep -Fxc -- '--config' "$ORCH_TEST_CODEX_ARGS")"
[[ "$config_count" == '3' ]] || {
  printf 'expected 3 --config arguments, got %s\n' "$config_count" >&2
  cat "$ORCH_TEST_CODEX_ARGS" >&2
  exit 1
}

# ── Host override still wins over the pin ───────────────────────────────────
printf 'ORCH_CODEX_MODEL=gpt-5.6-sol-override\nORCH_CODEX_REASONING_EFFORT=medium\n' \
  > "$SCRATCH/override.env"
ORCH_CONFIG_FILE="$SCRATCH/override.env" "$SCRIPT_DIR/launch.sh" start
ORCH_CONFIG_FILE="$SCRATCH/override.env" "$SCRIPT_DIR/launch.sh" stop
[[ "$(arg_after '--model')" == 'gpt-5.6-sol-override' ]]
grep -Fxq 'model_reasoning_effort="medium"' "$ORCH_TEST_CODEX_ARGS"

# ── An untrusted work dir must fail loudly, not stall in a detached pane ────
printf '[projects."/somewhere/else"]\ntrust_level = "trusted"\n' > "$CODEX_HOME/config.toml"
if err="$("$SCRIPT_DIR/launch.sh" start 2>&1 >/dev/null)"; then
  "$SCRIPT_DIR/launch.sh" stop >/dev/null 2>&1 || true
  printf 'launch succeeded with an untrusted work dir\n' >&2
  exit 1
fi
grep -q 'orchestrator-workdir-untrusted' <<<"$err" || {
  printf 'untrusted work dir did not report the expected error: %s\n' "$err" >&2
  exit 1
}
# The escape hatch stays usable.
ORCH_SKIP_TRUST_CHECK=1 "$SCRIPT_DIR/launch.sh" start >/dev/null
ORCH_SKIP_TRUST_CHECK=1 "$SCRIPT_DIR/launch.sh" stop >/dev/null
# An unreadable/absent config is "cannot tell", never a block.
rm -f "$CODEX_HOME/config.toml"
"$SCRIPT_DIR/launch.sh" start >/dev/null
"$SCRIPT_DIR/launch.sh" stop >/dev/null

printf 'codex notify/hook wiring regression: PASS\n'
