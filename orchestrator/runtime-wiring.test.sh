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
[[ "${1:-}" == -- ]] && shift
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
# The acquisition TTL must exceed launch.sh's readiness window: renewals now
# carry this same TTL (they used to be silently inflated to the CLI's 30s
# default), so a TTL under the readiness wait means the launcher's own lease
# expires while it is still waiting on the provider.
export ORCH_STATE_DB="$STATE_DB" ORCH_LEASE_TTL_MS=6000 ORCH_PROVIDER=codex
export ORCH_AUTH_PREFLIGHT="$SCRATCH/preflight.sh" ORCH_WATCHDOG_LOG="$LOG_FILE"
# Not covered by ORCH_RUNTIME_DIR: the `/done` rest sentinel lives under the
# daemon's state dir and the health probe defaults to the live daemon's URL.
export ORCH_DONE_SENTINEL="$SCRATCH/no-done-sentinel" ORCH_DAEMON_HEALTH_URL=""
# This suite runs the tick against the REAL df, so on a host that happens to sit
# above DISK_ALERT_PCT it would reclaim that host's Docker cache as a side effect
# of an unrelated assertion. Reclamation is covered by docker-remediation.test.sh
# with a shimmed docker; here it is simply off.
export DOCKER_PRUNE_ENABLED=0

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

# A watchdog tick renews with ORCH_LEASE_TTL_MS, so the lease stays live past
# the point where the acquisition would otherwise have lapsed. (This used to
# read "renew changes the deadline to 30 seconds" and depended on that
# accidental inflation — which is precisely the bug that let the real lease die
# ~34s after launch. The renewal now carries the configured TTL and nothing
# else.)
assert "$SCRIPT_DIR/watchdog.sh"
sleep 1.2
third_output="$SCRATCH/third-launch.out"
export ORCH_SESSION=lease-third
assert_not launch_start >"$third_output" 2>&1
grep -q '^ERROR orchestrator-lease-held ' "$third_output" || fail 'watchdog renewal did not keep lease live'

# Release then acquire from a new owner. The stored token is now fenced and a
# watchdog tick must stop, rather than relaunch, the supervised session.
#
# The replacement owner is spelled "<host>:<live pid>", the shape launch.sh
# actually writes, because the fence now fires only on a holder it can VERIFY is
# alive. Displacement by a verifiable live owner is the one case that still
# kills; an expired-but-uncontested lease, a corpse still holding a row, or an
# unreadable store are all no-kill (watchdog-lease-guard.test.sh). The old
# fixture used the bare string "replacement-owner", which no longer names
# anything the watchdog can check.
sleep 1000 & replacement_pid=$!
current_owner="$(owner)"
current_token="$(token)"
assert env INFRA_STATE_DB="$STATE_DB" bun "$SCRIPT_DIR/../core/mission-cli.ts" lease release "$current_owner" orchestrator "$current_token"
assert env INFRA_STATE_DB="$STATE_DB" bun "$SCRIPT_DIR/../core/mission-cli.ts" lease acquire "$(hostname):$replacement_pid" orchestrator 30000
export ORCH_SESSION=lease-second
assert "$SCRIPT_DIR/watchdog.sh"
assert_not tmux -L "$TMUX_SOCKET" has-session -t lease-second
grep -q "WATCHDOG lease-displaced .*holder=$(hostname):$replacement_pid" "$LOG_FILE" ||
  fail 'displacement by a live owner did not log lease-displaced'
kill "$replacement_pid" 2>/dev/null || true

printf 'runtime wiring tests: PASS\n'
