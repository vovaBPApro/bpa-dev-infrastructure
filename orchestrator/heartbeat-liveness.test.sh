#!/usr/bin/env bash
# Regression lock: completed turns advance liveness, while missing/stale
# heartbeats fail closed even when the supervised pane PID remains alive.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRATCH="$(mktemp -d)"
SHIM="$SCRATCH/bin"
RUNTIME_DIR="$SCRATCH/runtime"
LOG_FILE="$RUNTIME_DIR/watchdog.log"
ACTION_FILE="$SCRATCH/actions"

cleanup() { rm -rf "$SCRATCH"; }
trap cleanup EXIT
mkdir -p "$SHIM" "$RUNTIME_DIR"

cat > "$SHIM/tmux" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  has-session) exit 0 ;;
  list-panes) ps -o ppid= -p "$PPID" | tr -d ' ' ;;
  *) exit 0 ;;
esac
EOF
cat > "$SCRATCH/launch.sh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$1" >> "${ORCH_TEST_ACTIONS:?}"
EOF
chmod +x "$SHIM/tmux" "$SCRATCH/launch.sh"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
assert_action() { grep -qx "$1" "$ACTION_FILE" || fail "missing recovery action: $1"; }
assert_no_actions() { [[ ! -s "$ACTION_FILE" ]] || fail "fresh heartbeat triggered recovery"; }

export ORCH_CONFIG_FILE="$SCRATCH/no-config"
export ORCH_RUNTIME_DIR="$RUNTIME_DIR"
export ORCH_WATCHDOG_LOG="$LOG_FILE"
export ORCH_STATE_DB="$SCRATCH/no-state.db"
export ORCH_TEST_ACTIONS="$ACTION_FILE"
export ORCH_LAUNCH_SCRIPT="$SCRATCH/launch.sh"
export ORCH_HEARTBEAT_MAX_AGE=10
export PATH="$SHIM:$PATH"
# Standalone-runtime branch: with no relay entry and no ORCH_RELAY_URL the hook
# delivers nothing and only advances liveness, which is all this suite is about.
# It also keeps the suite hermetic — a real delivery would POST to whatever
# daemon happens to be listening on this box and relay a fabricated turn to
# Telegram. (The payload contract itself is locked by turnend-relay.test.sh.)
export ORCH_RELAY_ENTRY="$SCRATCH/absent-relay.ts"

# This used to pass '{}', which daemon/relay.ts rejects as an unsupported hook
# payload; the hook exited non-zero and `set -e` killed the suite before its
# first assertion. Use the real Codex notify shape.
"$SCRIPT_DIR/orchestrator-turnend-relay.sh" \
  '{"type":"agent-turn-complete","thread-id":"thread-liveness","turn-id":"turn-liveness","cwd":"/work","last-assistant-message":"done"}'
HEARTBEAT_FILE="$RUNTIME_DIR/orchestrator.heartbeat"
[[ -f "$HEARTBEAT_FILE" ]] || fail "turn-end relay did not write default heartbeat"

ORCH_WATCHDOG_NOW="$(date +%s)" "$SCRIPT_DIR/watchdog.sh"
assert_no_actions

printf '%s\n' 100 > "$HEARTBEAT_FILE"
ORCH_WATCHDOG_NOW=111 "$SCRIPT_DIR/watchdog.sh"
assert_action stop
assert_action start
grep -q 'zombie session=.*action=kill-relaunch' "$LOG_FILE" || fail "stale heartbeat was not logged"

: > "$ACTION_FILE"
rm -f "$HEARTBEAT_FILE"
ORCH_WATCHDOG_NOW=100 "$SCRIPT_DIR/watchdog.sh"
assert_no_actions
ORCH_WATCHDOG_NOW=111 "$SCRIPT_DIR/watchdog.sh"
assert_action stop
assert_action start
grep -q 'heartbeat-missing session=.*action=kill-relaunch' "$LOG_FILE" || fail "missing heartbeat was not logged"

printf 'heartbeat liveness tests: PASS\n'
