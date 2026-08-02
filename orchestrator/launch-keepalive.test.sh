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
mkdir -p "$SCRATCH/bin" "$SCRATCH/runtime" "$SCRATCH/home"

cat > "$SCRATCH/bin/tmux" <<'EOF'
#!/usr/bin/env bash
exec /usr/bin/tmux -L "${ORCH_TEST_TMUX_SOCKET:?}" "$@"
EOF
cat > "$SCRATCH/bin/claude" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$$" > "${ORCH_TEST_PROVIDER_PID:?}"
printf '%s\n' "${IS_SANDBOX:-}" > "${ORCH_TEST_SANDBOX:?}"
exec sleep 1000
EOF
cat > "$SCRATCH/preflight.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$SCRATCH/bin/tmux" "$SCRATCH/bin/claude" "$SCRATCH/preflight.sh"

export PATH="$SCRATCH/bin:$PATH"
export HOME="$SCRATCH/home"
export ORCH_TEST_TMUX_SOCKET="$TMUX_SOCKET"
export ORCH_TEST_PROVIDER_PID="$SCRATCH/provider.pid"
export ORCH_TEST_SANDBOX="$SCRATCH/provider.sandbox"
export ORCH_CONFIG_FILE="$SCRATCH/no-runtime.env"
export ORCH_RUNTIME_DIR="$SCRATCH/runtime"
export ORCH_SINGLETON_LOCK_FILE="$SCRATCH/orchestrator.singleton.lock"
export ORCH_STATE_DB="$SCRATCH/state.db"
# launch.sh derives the live-instance lock from the ambient chat id and
# deletes it on `stop`. Unisolated, this suite removes the operator's real
# orchestrator lock whenever it runs inside an orchestrator-spawned shell.
export ORCH_INSTANCE_LOCK_FILE="$SCRATCH/instance.lock"
export ORCH_AUTH_PREFLIGHT="$SCRATCH/preflight.sh"
export ORCH_PROVIDER=claude
export ORCH_SESSION=claude-keepalive
export ORCH_WORK_DIR="$SCRIPT_DIR/.."

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

env INFRA_STATE_DB="$ORCH_STATE_DB" bun "$SCRIPT_DIR/../core/mission-cli.ts" status >/dev/null
# Exercise the harder boundary: launch into an already-running tmux server. The
# server must not inherit either launcher lock descriptor.
tmux -L "$TMUX_SOCKET" new-session -d -s preexisting 'sleep 1000'
tmux_server_pid="$(tmux -L "$TMUX_SOCKET" display-message -p '#{pid}')"
"$SCRIPT_DIR/launch.sh" start
sleep 2
tmux -L "$TMUX_SOCKET" has-session -t "$ORCH_SESSION" ||
  fail 'lease written but no live tmux session'
[[ -s "$ORCH_TEST_PROVIDER_PID" ]] || fail 'Claude stub did not remain running'
provider_pid="$(cat "$ORCH_TEST_PROVIDER_PID")"
kill -0 "$provider_pid" 2>/dev/null || fail "Claude stub pid $provider_pid is not live"
[[ "$(cat "$ORCH_TEST_SANDBOX")" == 1 ]] ||
  fail 'Claude provider did not receive IS_SANDBOX=1'
singleton_inode="$(stat -Lc '%d:%i' "$ORCH_SINGLETON_LOCK_FILE")"
[[ -e "/proc/$provider_pid/fd/8" ]] ||
  fail 'provider does not own singleton descriptor 8'
[[ "$(stat -Lc '%d:%i' "/proc/$provider_pid/fd/8")" == "$singleton_inode" ]] ||
  fail 'provider descriptor 8 does not name the singleton lock'
for fd in /proc/"$tmux_server_pid"/fd/*; do
  [[ -e "$fd" ]] || continue
  [[ "$(stat -Lc '%d:%i' "$fd" 2>/dev/null || true)" != "$singleton_inode" ]] ||
    fail 'pre-existing tmux server inherited the singleton lock descriptor'
done
pulse_pid="$(pgrep -f -- "$SCRIPT_DIR/orchestrator-liveness-pulse.sh $provider_pid $ORCH_RUNTIME_DIR/orchestrator.liveness" | head -n 1)"
[[ "$pulse_pid" =~ ^[1-9][0-9]*$ ]] || fail 'liveness pulse process was not started'
[[ ! -e "/proc/$pulse_pid/fd/8" ]] ||
  fail 'liveness pulse inherited singleton descriptor 8'
lease_owner="$(sed -n 's/^owner=//p' "$ORCH_RUNTIME_DIR/orchestrator.lease")"
lease_pid="${lease_owner##*:}"
[[ "$lease_pid" =~ ^[1-9][0-9]*$ ]] || fail "invalid lease owner: $lease_owner"
kill -0 "$lease_pid" 2>/dev/null || fail "lease owner pid $lease_pid is not live"

printf 'launch keepalive regression: PASS\n'
