#!/usr/bin/env bash
# Regression lock: a provider that exits during startup must not publish success.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRATCH="$(mktemp -d)"
TMUX_SOCKET="launch-fastexit-$$"
cleanup() {
  tmux -L "$TMUX_SOCKET" kill-server 2>/dev/null || true
  rm -rf "$SCRATCH"
}
trap cleanup EXIT
mkdir -p "$SCRATCH/bin" "$SCRATCH/runtime" "$SCRATCH/home/.claude"

cat > "$SCRATCH/bin/tmux" <<'EOF'
#!/usr/bin/env bash
exec /usr/bin/tmux -L "${ORCH_TEST_TMUX_SOCKET:?}" "$@"
EOF
cat > "$SCRATCH/bin/claude" <<'EOF'
#!/usr/bin/env bash
exit 42
EOF
cat > "$SCRATCH/preflight.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$SCRATCH/bin/tmux" "$SCRATCH/bin/claude" "$SCRATCH/preflight.sh"

export PATH="$SCRATCH/bin:$PATH"
export HOME="$SCRATCH/home"
export ORCH_TEST_TMUX_SOCKET="$TMUX_SOCKET"
export ORCH_CONFIG_FILE="$SCRATCH/no-runtime.env"
export ORCH_RUNTIME_DIR="$SCRATCH/runtime"
export ORCH_SINGLETON_LOCK_FILE="$SCRATCH/orchestrator.singleton.lock"
export ORCH_STATE_DB="$SCRATCH/state.db"
export ORCH_AUTH_PREFLIGHT="$SCRATCH/preflight.sh"
export ORCH_PROVIDER=claude
export ORCH_SESSION=claude-fastexit
export ORCH_WORK_DIR="$SCRIPT_DIR/.."
export TELEGRAM_BOUND_CHAT_ID=12345
INSTANCE_LOCK="$HOME/.claude/orchestrator-chat-$TELEGRAM_BOUND_CHAT_ID.lock"
printf 'existing-binding\n' > "$INSTANCE_LOCK"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

env INFRA_STATE_DB="$ORCH_STATE_DB" bun "$SCRIPT_DIR/../core/mission-cli.ts" status >/dev/null
set +e
launch_output="$("$SCRIPT_DIR/launch.sh" start 2>&1)"
launch_rc=$?
set -e
[[ "$launch_rc" -ne 0 ]] || fail "fast-exit provider launch returned rc=0: $launch_output"
[[ ! -e "$ORCH_RUNTIME_DIR/orchestrator.heartbeat" ]] ||
  fail 'fast-exit provider wrote heartbeat'
[[ "$(cat "$INSTANCE_LOCK")" == existing-binding ]] ||
  fail 'fast-exit provider replaced instance binding'
tmux -L "$TMUX_SOCKET" has-session -t "$ORCH_SESSION" 2>/dev/null &&
  fail 'fast-exit provider left a live tmux session'
[[ ! -e "$ORCH_RUNTIME_DIR/orchestrator.lease" ]] ||
  fail 'fast-exit provider left a lease file'
status_output="$(env INFRA_STATE_DB="$ORCH_STATE_DB" bun "$SCRIPT_DIR/../core/mission-cli.ts" status)"
[[ "$status_output" != *'"key":"orchestrator"'* ]] ||
  fail "fast-exit provider left a durable lease: $status_output"

printf 'launch immediate-exit regression: PASS\n'

cat > "$SCRATCH/bin/claude" <<'EOF'
#!/usr/bin/env bash
sleep 2.9
exit 42
EOF
chmod +x "$SCRATCH/bin/claude"

export ORCH_SESSION=claude-boundary-exit
export ORCH_READINESS_WINDOW_MS=3000
export ORCH_READINESS_POLL_SECONDS=1
printf 'existing-binding\n' > "$INSTANCE_LOCK"

set +e
launch_output="$("$SCRIPT_DIR/launch.sh" start 2>&1)"
launch_rc=$?
set -e
[[ "$launch_rc" -ne 0 ]] || fail "boundary-exit provider launch returned rc=0: $launch_output"
[[ ! -e "$ORCH_RUNTIME_DIR/orchestrator.heartbeat" ]] ||
  fail 'boundary-exit provider wrote heartbeat'
[[ "$(cat "$INSTANCE_LOCK")" == existing-binding ]] ||
  fail 'boundary-exit provider replaced instance binding'
tmux -L "$TMUX_SOCKET" has-session -t "$ORCH_SESSION" 2>/dev/null &&
  fail 'boundary-exit provider left a live tmux session'
[[ ! -e "$ORCH_RUNTIME_DIR/orchestrator.lease" ]] ||
  fail 'boundary-exit provider left a lease file'
status_output="$(env INFRA_STATE_DB="$ORCH_STATE_DB" bun "$SCRIPT_DIR/../core/mission-cli.ts" status)"
[[ "$status_output" != *'"key":"orchestrator"'* ]] ||
  fail "boundary-exit provider left a durable lease: $status_output"

printf 'launch boundary-exit regression: PASS\n'
