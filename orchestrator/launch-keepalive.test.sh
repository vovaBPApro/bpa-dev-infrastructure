#!/usr/bin/env bash
# Regression lock: the tmux provider owns both the singleton and durable lease.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRATCH="$(mktemp -d)"
TMUX_SOCKET="launch-keepalive-$$"
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
cat > "$SCRATCH/bin/claude" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$$" > "${ORCH_TEST_PROVIDER_PID:?}"
exec sleep 1000
EOF
cat > "$SCRATCH/preflight.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$SCRATCH/bin/tmux" "$SCRATCH/bin/claude" "$SCRATCH/preflight.sh"

export PATH="$SCRATCH/bin:$PATH"
export ORCH_TEST_TMUX_SOCKET="$TMUX_SOCKET"
export ORCH_TEST_PROVIDER_PID="$SCRATCH/provider.pid"
export ORCH_CONFIG_FILE="$SCRATCH/no-runtime.env"
export ORCH_RUNTIME_DIR="$SCRATCH/runtime"
export ORCH_SINGLETON_LOCK_FILE="$SCRATCH/orchestrator.singleton.lock"
export ORCH_STATE_DB="$SCRATCH/state.db"
export ORCH_AUTH_PREFLIGHT="$SCRATCH/preflight.sh"
export ORCH_PROVIDER=claude
export ORCH_SESSION=claude-keepalive
export ORCH_WORK_DIR="$SCRIPT_DIR/.."

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

env INFRA_STATE_DB="$ORCH_STATE_DB" bun "$SCRIPT_DIR/../core/mission-cli.ts" status >/dev/null
"$SCRIPT_DIR/launch.sh" start
sleep 2
tmux -L "$TMUX_SOCKET" has-session -t "$ORCH_SESSION" ||
  fail 'lease written but no live tmux session'
[[ -s "$ORCH_TEST_PROVIDER_PID" ]] || fail 'Claude stub did not remain running'
provider_pid="$(cat "$ORCH_TEST_PROVIDER_PID")"
kill -0 "$provider_pid" 2>/dev/null || fail "Claude stub pid $provider_pid is not live"
lease_owner="$(sed -n 's/^owner=//p' "$ORCH_RUNTIME_DIR/orchestrator.lease")"
lease_pid="${lease_owner##*:}"
[[ "$lease_pid" =~ ^[1-9][0-9]*$ ]] || fail "invalid lease owner: $lease_owner"
kill -0 "$lease_pid" 2>/dev/null || fail "lease owner pid $lease_pid is not live"

printf 'launch keepalive regression: PASS\n'
