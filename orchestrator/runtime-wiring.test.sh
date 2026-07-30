#!/usr/bin/env bash
# Integration coverage for durable orchestrator ownership. It uses real Bun,
# SQLite, tmux, and sleeping provider processes; only systemd is bypassed.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRATCH="$(mktemp -d)"
TMUX_SOCKET="runtime-wiring-$$"
SHIM="$SCRATCH/bin"
STATE_DB="$SCRATCH/state.db"
RUNTIME_DIR="$SCRATCH/runtime"
LOG_FILE="$RUNTIME_DIR/watchdog.log"

cleanup() {
  tmux -L "$TMUX_SOCKET" kill-server 2>/dev/null || true
  rm -rf "$SCRATCH"
}
trap cleanup EXIT
mkdir -p "$SHIM" "$RUNTIME_DIR"

cat > "$SHIM/tmux" <<'EOF'
#!/usr/bin/env bash
exec /usr/bin/tmux -L "${ORCH_TEST_TMUX_SOCKET:?}" "$@"
EOF
cat > "$SHIM/systemd-run" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
while [[ "$1" == -* ]]; do shift; done
exec "$@"
EOF
cat > "$SHIM/codex" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "${ORCH_FENCING_TOKEN:?}" >> "${ORCH_TEST_TOKENS:?}"
exec sleep 1000
EOF
cat > "$SCRATCH/preflight.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$SHIM/tmux" "$SHIM/systemd-run" "$SHIM/codex" "$SCRATCH/preflight.sh"

export PATH="$SHIM:$PATH"
export ORCH_TEST_TMUX_SOCKET="$TMUX_SOCKET" ORCH_TEST_TOKENS="$SCRATCH/provider-tokens"
export ORCH_CONFIG_FILE="$SCRATCH/no-runtime.env" ORCH_RUNTIME_DIR="$RUNTIME_DIR"
export ORCH_SINGLETON_LOCK_FILE="$SCRATCH/orchestrator.singleton.lock"
export ORCH_INSTANCE_LOCK_FILE="$SCRATCH/orchestrator-instance.lock"
export ORCH_STATE_DB="$STATE_DB" ORCH_LEASE_TTL_MS=1000 ORCH_PROVIDER=codex
export ORCH_AUTH_PREFLIGHT="$SCRATCH/preflight.sh" ORCH_WATCHDOG_LOG="$LOG_FILE"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
assert() { "$@" || fail "$*"; }
assert_not() {
  local status
  set +e
  "$@"
  status=$?
  set -e
  (( status != 0 )) || fail "unexpected success: $*"
}
launch_start() { "$SCRIPT_DIR/launch.sh" start; }
token() { sed -n 's/^token=//p' "$RUNTIME_DIR/orchestrator.lease"; }
owner() { sed -n 's/^owner=//p' "$RUNTIME_DIR/orchestrator.lease"; }

assert env INFRA_STATE_DB="$STATE_DB" bun "$SCRIPT_DIR/../core/mission-cli.ts" status

export ORCH_SESSION=lease-first
assert "$SCRIPT_DIR/launch.sh" start
first_token="$(token)"
[[ "$first_token" == 1 ]] || fail "first token was $first_token"
sleep 0.1
grep -qx "$first_token" "$ORCH_TEST_TOKENS" || fail 'provider did not receive fencing token'
grep -Eq '^\{"pid":[1-9][0-9]*,"pid_started_at":"[^"]+"\}$' "$ORCH_INSTANCE_LOCK_FILE" ||
  fail 'launch did not write a valid live-instance lock'

export ORCH_SESSION=lease-second
second_output="$SCRATCH/second-launch.out"
set +e
launch_start >"$second_output" 2>&1
second_status=$?
set -e
(( second_status != 0 )) || fail 'second launch unexpectedly succeeded'
grep -Eq '^ERROR orchestrator-lease-held owner=.+:[0-9]+$' "$second_output" || { cat "$second_output" >&2; fail 'live lease did not refuse second launch'; }

tmux -L "$TMUX_SOCKET" kill-session -t lease-first
# REGRESSION: a provider that exited before stop must not strand its lease.
assert "$SCRIPT_DIR/launch.sh" stop
mission_status="$(env INFRA_STATE_DB="$STATE_DB" bun "$SCRIPT_DIR/../core/mission-cli.ts" status)"
[[ "$mission_status" == *'"leases":[]'* ]] || fail 'stop left a lease after provider exit'
assert "$SCRIPT_DIR/launch.sh" start
second_token="$(token)"
(( second_token > first_token )) || fail 'relaunch token did not increase'

# Renew changes the CLI's lease deadline to 30 seconds, so it remains live
# past the short acquisition TTL used by this fixture.
assert "$SCRIPT_DIR/watchdog.sh"
sleep 1.2
third_output="$SCRATCH/third-launch.out"
export ORCH_SESSION=lease-third
assert_not launch_start >"$third_output" 2>&1
grep -q '^ERROR orchestrator-lease-held ' "$third_output" || fail 'watchdog renewal did not keep lease live'

# Release then acquire from a new owner. The stored token is now fenced and a
# watchdog tick must stop, rather than relaunch, the supervised session.
current_owner="$(owner)"
current_token="$(token)"
assert env INFRA_STATE_DB="$STATE_DB" bun "$SCRIPT_DIR/../core/mission-cli.ts" lease release "$current_owner" orchestrator "$current_token"
assert env INFRA_STATE_DB="$STATE_DB" bun "$SCRIPT_DIR/../core/mission-cli.ts" lease acquire replacement-owner orchestrator 30000
export ORCH_SESSION=lease-second
assert "$SCRIPT_DIR/watchdog.sh"
assert_not tmux -L "$TMUX_SOCKET" has-session -t lease-second
grep -q 'WATCHDOG lease-lost' "$LOG_FILE" || fail 'stale token did not log lease-lost'

printf 'runtime wiring tests: PASS\n'
