#!/usr/bin/env bash
# Regression lock: if the launcher dies after singleton handoff but before it
# publishes startup state, the pane must exit on its bounded marker deadline.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRATCH="$(mktemp -d)"
TMUX_SOCKET="launch-handshake-bounded-$$"
cleanup() {
  [[ -z "${launcher_pid:-}" ]] || kill "$launcher_pid" 2>/dev/null || true
  tmux -L "$TMUX_SOCKET" kill-server 2>/dev/null || true
  rm -rf "$SCRATCH"
}
trap cleanup EXIT
mkdir -p "$SCRATCH/bin" "$SCRATCH/runtime" "$SCRATCH/home"

cat > "$SCRATCH/bin/tmux" <<'EOF'
#!/usr/bin/env bash
exec /usr/bin/tmux -L "${ORCH_TEST_TMUX_SOCKET:?}" "$@"
EOF
cat > "$SCRATCH/bin/codex" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$$" > "${ORCH_TEST_PROVIDER_PID:?}"
exec sleep 1000
EOF
cat > "$SCRATCH/preflight.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat > "$SCRATCH/mission-cli.ts" <<'EOF'
const args = Bun.argv.slice(2);
if (args[0] === "reap") process.exit(0);
if (args[0] === "status") {
  console.log('{"missions":[],"lanes":[],"leases":[]}');
  process.exit(0);
}
if (args[0] === "lease" && args[1] === "acquire") {
  await Bun.sleep(60_000);
  process.exit(1);
}
process.exit(0);
EOF
chmod +x "$SCRATCH/bin/tmux" "$SCRATCH/bin/codex" "$SCRATCH/preflight.sh"

export PATH="$SCRATCH/bin:$PATH"
export HOME="$SCRATCH/home"
export ORCH_TEST_TMUX_SOCKET="$TMUX_SOCKET"
export ORCH_TEST_PROVIDER_PID="$SCRATCH/provider.pid"
export ORCH_CONFIG_FILE="$SCRATCH/no-runtime.env"
export ORCH_RUNTIME_DIR="$SCRATCH/runtime"
export ORCH_SINGLETON_LOCK_FILE="$SCRATCH/orchestrator.singleton.lock"
export ORCH_STATE_DB="$SCRATCH/state.db"
export ORCH_MISSION_CLI="$SCRATCH/mission-cli.ts"
export ORCH_INSTANCE_LOCK_FILE="$SCRATCH/instance.lock"
export ORCH_AUTH_PREFLIGHT="$SCRATCH/preflight.sh"
export ORCH_PROVIDER=codex
export ORCH_SESSION=handshake-bounded
export ORCH_WORK_DIR="$SCRIPT_DIR/.."
: > "$ORCH_STATE_DB"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

"$SCRIPT_DIR/launch.sh" start >"$SCRATCH/launch.out" 2>&1 &
launcher_pid=$!
acquired="$ORCH_RUNTIME_DIR/orchestrator.singleton.acquired"
for _ in $(seq 1 100); do
  [[ -f "$acquired" ]] && break
  kill -0 "$launcher_pid" 2>/dev/null || break
  sleep 0.05
done
[[ -f "$acquired" ]] || fail 'launcher never reached singleton acquired stage'
kill "$launcher_pid"
wait "$launcher_pid" 2>/dev/null || true
launcher_pid=""

# The pane-side startup wait is 1000 x 10ms. Give scheduler overhead, but never
# permit the old forever-wait behavior.
for _ in $(seq 1 140); do
  tmux -L "$TMUX_SOCKET" has-session -t "$ORCH_SESSION" 2>/dev/null || break
  sleep 0.1
done
if tmux -L "$TMUX_SOCKET" has-session -t "$ORCH_SESSION" 2>/dev/null; then
  fail 'pane survived launcher death past its startup-marker deadline'
fi
[[ ! -e "$ORCH_TEST_PROVIDER_PID" ]] ||
  fail 'provider executed without launcher-published startup state'
flock -n "$ORCH_SINGLETON_LOCK_FILE" true ||
  fail 'bounded pane exit did not release the singleton lock'

printf 'launch bounded-handshake regression: PASS\n'
