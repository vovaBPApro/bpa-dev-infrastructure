#!/usr/bin/env bash
# Regression lock: absent state DB must not permit parallel orchestrators.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRATCH="$(mktemp -d)"
TMUX_SOCKET="singleton-failclosed-$$"
SHIM="$SCRATCH/bin"
SINGLETON_LOCK="$SCRATCH/orchestrator.singleton.lock"

cleanup() {
  tmux -L "$TMUX_SOCKET" kill-server 2>/dev/null || true
  rm -rf "$SCRATCH"
}
trap cleanup EXIT
mkdir -p "$SHIM"

cat > "$SHIM/tmux" <<'EOF'
#!/usr/bin/env bash
exec /usr/bin/tmux -L "${ORCH_TEST_TMUX_SOCKET:?}" "$@"
EOF
cat > "$SHIM/systemd-run" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' 'Failed to connect to user scope bus via local transport' >&2
exit 1
EOF
cat > "$SHIM/codex" <<'EOF'
#!/usr/bin/env bash
exec sleep 1000
EOF
cat > "$SCRATCH/preflight.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$SHIM/tmux" "$SHIM/systemd-run" "$SHIM/codex" "$SCRATCH/preflight.sh"

export PATH="$SHIM:$PATH"
export ORCH_TEST_TMUX_SOCKET="$TMUX_SOCKET"
export ORCH_CONFIG_FILE="$SCRATCH/no-runtime.env"
export ORCH_STATE_DB="$SCRATCH/absent/state.db"
export ORCH_SINGLETON_LOCK_FILE="$SINGLETON_LOCK"
export ORCH_PROVIDER=codex
export ORCH_AUTH_PREFLIGHT="$SCRATCH/preflight.sh"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

export ORCH_SESSION=singleton-first ORCH_RUNTIME_DIR="$SCRATCH/runtime-first"
env -u DBUS_SESSION_BUS_ADDRESS -u XDG_RUNTIME_DIR "$SCRIPT_DIR/launch.sh" start
tmux -L "$TMUX_SOCKET" has-session -t singleton-first ||
  fail 'headless launch did not spawn a detached tmux session'

export ORCH_SESSION=singleton-second ORCH_RUNTIME_DIR="$SCRATCH/runtime-second"
set +e
second_output="$("$SCRIPT_DIR/launch.sh" start 2>&1)"
second_status=$?
set -e
(( second_status != 0 )) || fail 'second launch succeeded without a state DB'
grep -q '^ERROR orchestrator-singleton-held ' <<<"$second_output" ||
  fail "second launch did not report singleton refusal: $second_output"
if tmux -L "$TMUX_SOCKET" has-session -t singleton-second 2>/dev/null; then
  fail 'refused second session remained running'
fi

tmux -L "$TMUX_SOCKET" kill-session -t singleton-first
for _ in 1 2 3 4 5; do
  flock -n "$SINGLETON_LOCK" true 2>/dev/null && break
  sleep 0.1
done
flock -n "$SINGLETON_LOCK" true 2>/dev/null ||
  fail 'singleton lock was not reclaimed after its process died'

# Stale lockfile contents are harmless: ownership is the kernel lock, not a PID.
printf 'stale-owner=999999\n' > "$SINGLETON_LOCK"
export ORCH_SESSION=singleton-reclaimed ORCH_RUNTIME_DIR="$SCRATCH/runtime-reclaimed"
"$SCRIPT_DIR/launch.sh" start
tmux -L "$TMUX_SOCKET" has-session -t singleton-reclaimed ||
  fail 'fresh launch did not reclaim a stale lockfile'

printf 'singleton fail-closed tests: PASS\n'
