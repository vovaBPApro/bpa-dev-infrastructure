#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if command -v shellcheck >/dev/null 2>&1; then
  shellcheck "$SCRIPT_DIR"/*.sh
elif command -v npx >/dev/null 2>&1; then
  npx --yes shellcheck "$SCRIPT_DIR"/*.sh
else
  printf 'FAIL: shellcheck (or npx fallback) is required for runtime tests\n' >&2
  exit 127
fi
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT
SHIM="$SCRATCH/bin"
STATE="$SCRATCH/state"
mkdir -p "$SHIM" "$STATE"

cat > "$SHIM/tmux" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
state="${MOCK_STATE:?}"
case "$1" in
  has-session) [[ -f "$state/session" ]] ;;
  new-session)
    touch "$state/session"
    printf '%s\n' "${MOCK_PANE_PID:-$$}" > "$state/pid"
    printf 'tmux new-session %s\n' "$*" >> "$state/calls"
    ;;
  pipe-pane)
    printf 'tmux pipe-pane %s\n' "$*" >> "$state/calls"
    if [[ "${MOCK_PIPE_DETACH:-0}" != 1 ]]; then
      touch "$state/pipe"
      [[ "${MOCK_CLASSIFIER_NOT_READY:-0}" == 1 ]] || touch "${ORCH_TERMINAL_ALERT_READY_FILE:?}"
    fi
    ;;
  kill-session) rm -f "$state/session"; printf 'tmux kill-session %s\n' "$*" >> "$state/calls" ;;
  list-panes)
    if [[ "$*" == *'#{pane_pipe}'* ]]; then
      [[ -f "$state/pipe" ]] && printf '1\n' || printf '0\n'
    else
      cat "$state/pid"
    fi
    ;;
  *) printf 'unexpected tmux: %s\n' "$*" >&2; exit 2 ;;
esac
EOF
cat > "$SHIM/systemd-run" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'systemd-run %s\n' "$*" >> "${MOCK_STATE:?}/calls"
while [[ "$1" == -* ]]; do shift; done
[[ "${1:-}" == -- ]] && shift
exec "$@"
EOF
cat > "$SHIM/codex" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$SHIM/tmux" "$SHIM/systemd-run" "$SHIM/codex"

export PATH="$SHIM:$PATH" MOCK_STATE="$STATE" MOCK_PANE_PID="$$"
export ORCH_RUNTIME_DIR="$STATE/runtime" ORCH_SESSION="test-orch" ORCH_PROVIDER=codex
export ORCH_AUTH_PREFLIGHT="$SCRIPT_DIR/preflight-cli-auth.sh"
# The REAL preflight runs here, and it now requires affirmative subscription
# evidence rather than merely the absence of a key — so the suite must not
# depend on whether THIS box happens to be logged in. Hermetic fixture, shaped
# like a real ChatGPT-login auth.json.
printf '%s\n' '{"OPENAI_API_KEY":null,"tokens":{"access_token":"fixture-access"}}' > "$STATE/codex-auth.json"
export ORCH_CODEX_AUTH_FILE="$STATE/codex-auth.json"
# Hermetic state. tmux/systemd-run/codex are already shimmed, but the durable
# paths were not: ORCH_STATE_DB fell back to the caller's env or the repo's real
# runtime/state.db, so this suite reaped and acquired leases under the shared
# `orchestrator` key and overwrote the live instance lock with a mock pane pid.
# Pointing at absent scratch paths reproduces the clean-checkout condition these
# assertions were written against (state_available=false -> lease logic skipped).
export ORCH_STATE_DB="$STATE/state.db"
export ORCH_INSTANCE_LOCK_FILE="$STATE/instance.lock"
export ORCH_SINGLETON_LOCK_FILE="$STATE/singleton.lock"
export ORCH_LEASE_FILE="$STATE/orchestrator.lease"
# Same class of leak, two paths ORCH_RUNTIME_DIR does not cover: the `/done`
# rest sentinel lives under the DAEMON's state dir (an operator who had typed
# /done would make the watchdog rest and every relaunch assertion below would
# read as a pass with nothing happening), and the daemon health probe defaults
# to the live daemon's URL.
export ORCH_DONE_SENTINEL="$STATE/no-done-sentinel"
export ORCH_DAEMON_HEALTH_URL=""
# Same class again, for the disk guard: this suite runs the tick against the
# REAL df, so on a host above DISK_ALERT_PCT it would reclaim that host's Docker
# build cache and dangling images while asserting relaunch behaviour.
export DOCKER_PRUNE_ENABLED=0
export ORCH_RESTART_STATE_FILE="$STATE/watchdog-restart-state"
export ORCH_TERMINAL_ALERT_READY_FILE="$STATE/terminal-alert.ready"
# This suite asserts the recovery ACTIONS (relaunch, kill-relaunch) back to
# back, which the production restart cooldown would legitimately suppress on
# the second one. A zero cooldown is no longer a legal knob (knob-bounds.test.sh
# — it used to disable the anti-thrash throttle), so each recovery case zeroes
# the restart STATE instead. Throttling is covered by watchdog-supervision.test.sh.
export ORCH_LIVENESS_FILE="$STATE/liveness"
unset DBUS_SESSION_BUS_ADDRESS XDG_RUNTIME_DIR

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
assert() { "$@" || fail "$*"; }
assert_not() { if "$@"; then fail "unexpected success: $*"; fi; }
calls() { grep -c "^$1" "$STATE/calls" 2>/dev/null || true; }

assert "$SCRIPT_DIR/launch.sh" --help
assert_not "$SCRIPT_DIR/launch.sh" status
[[ ! -e "$STATE/calls" ]] || fail 'help/status had side effects'

assert "$SCRIPT_DIR/launch.sh" start
[[ "$(calls 'systemd-run')" == 1 ]] || fail 'launch did not use one systemd transient scope'
grep -q '^systemd-run .*--collect .*--scope .*--unit=bpa-orchestrator-test-orch -- tmux new-session ' "$STATE/calls" ||
  fail 'tmux launch was not constructed inside the named collected scope'
[[ "$(calls 'tmux pipe-pane')" == 1 ]] || fail 'launch did not wire terminal alerts'
grep -q 'terminal-alert.ts --session test-orch' "$STATE/calls" ||
  fail 'terminal alert pipe did not carry its classifier and session'
grep -q -- '--ready-file' "$STATE/calls" ||
  fail 'terminal alert pipe did not carry its readiness handshake path'
assert_not "$SCRIPT_DIR/launch.sh" start
[[ "$(calls 'tmux new-session')" == 1 ]] || fail 'double launch created another session'

rm -f "$STATE/session"
assert "$SCRIPT_DIR/watchdog.sh"
[[ "$(calls 'tmux new-session')" == 2 ]] || fail 'dead session did not relaunch'

heartbeat="$STATE/heartbeat"
touch "$heartbeat"
export ORCH_HEARTBEAT_FILE="$heartbeat" ORCH_HEARTBEAT_MAX_AGE=10 ORCH_WATCHDOG_NOW=1000
touch -d '@1' "$heartbeat"
# Positive death evidence: a liveness pulse that WAS renewing and went stale,
# PLUS a recorded provider identity that is verifiably gone. A stale stamp
# alone only proves the pulse HELPER stopped (heartbeat-liveness.test.sh owns
# that verdict table), so this corpse fixture kills its provider first and
# checks the corpse before expecting recovery.
printf '%s\n' 1 > "$STATE/liveness"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/proc-identity.sh"
sleep 300 & corpse_pid=$!
corpse_starttime="$(proc_starttime "$corpse_pid")"
[[ -n "$corpse_starttime" ]] || fail 'could not read a fixture starttime from /proc'
kill "$corpse_pid" 2>/dev/null || true
wait "$corpse_pid" 2>/dev/null || true
! kill -0 "$corpse_pid" 2>/dev/null || fail 'fixture corpse refused to die'
printf 'pid=%s\nstarttime=%s\n' "$corpse_pid" "$corpse_starttime" > "$STATE/liveness.identity"
rm -f "$ORCH_RESTART_STATE_FILE"
assert "$SCRIPT_DIR/watchdog.sh"
[[ "$(calls 'tmux kill-session')" == 1 ]] || fail 'stale heartbeat did not kill zombie'
[[ "$(calls 'tmux new-session')" == 3 ]] || fail 'stale heartbeat did not relaunch zombie'

touch -d '@995' "$heartbeat"
assert "$SCRIPT_DIR/watchdog.sh"
[[ "$(calls 'tmux kill-session')" == 1 ]] || fail 'healthy session was killed'
[[ "$(calls 'tmux new-session')" == 3 ]] || fail 'healthy session was relaunched'

rm -f "$STATE/session" "$STATE/pipe"
export MOCK_PIPE_DETACH=1
assert_not "$SCRIPT_DIR/launch.sh" start
[[ ! -f "$STATE/session" ]] || fail 'detached terminal alert pipe left session running'
unset MOCK_PIPE_DETACH

rm -f "$STATE/session" "$STATE/pipe" "$ORCH_TERMINAL_ALERT_READY_FILE"
export MOCK_CLASSIFIER_NOT_READY=1
assert_not "$SCRIPT_DIR/launch.sh" start
[[ ! -f "$STATE/session" ]] || fail 'unready terminal classifier left session running'
unset MOCK_CLASSIFIER_NOT_READY

printf 'runtime tests: PASS\n'
