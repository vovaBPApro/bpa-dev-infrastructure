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
  list-windows)
    # Second liveness signal. Unset ORCH_TEST_WINDOW_ACTIVITY reproduces a tmux
    # that answers nothing at all, which must not be read as proof of death.
    [[ -n "${ORCH_TEST_WINDOW_ACTIVITY:-}" ]] && printf '%s\n' "$ORCH_TEST_WINDOW_ACTIVITY"
    exit 0
    ;;
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
# Live-state isolation. Both the turn-end hook and watchdog.sh resolve these
# from the environment, and each override wins over ORCH_RUNTIME_DIR, so a lane
# inheriting the orchestrator's environment would write the operator's real
# heartbeat (masking a dead orchestrator), delete the real lease file, and
# append to the real nudge outbox — which the daemon forwards to Telegram.
export ORCH_HEARTBEAT_FILE="$RUNTIME_DIR/orchestrator.heartbeat"
export ORCH_HEARTBEAT_MISSING_SINCE_FILE="$RUNTIME_DIR/heartbeat-missing-since"
export ORCH_LEASE_FILE="$RUNTIME_DIR/orchestrator.lease"
export ORCH_INSTANCE_LOCK_FILE="$SCRATCH/instance.lock"
export NUDGE_OUTBOX_FILE="$RUNTIME_DIR/nudges.outbox"
export NUDGE_RATE_FILE="$RUNTIME_DIR/nudge-rate.tsv"
# The `/done` rest sentinel lives under the DAEMON's state dir, not the runtime
# dir, so it is not covered by ORCH_RUNTIME_DIR. Left ambient, an operator who
# had typed /done would make every assertion below vacuous: the tick would rest
# and take no recovery action at all.
export ORCH_DONE_SENTINEL="$SCRATCH/no-done-sentinel"
# Real df: on a host above DISK_ALERT_PCT the tick would reclaim that host's
# Docker cache while this suite asserts heartbeat semantics. Reclamation has its
# own coverage in docker-remediation.test.sh, with docker shimmed.
export DOCKER_PRUNE_ENABLED=0
# Keep the tick off the network: the default probe URL is the live daemon.
export ORCH_DAEMON_HEALTH_URL=""
# This suite is about heartbeat semantics, not restart throttling: it drives two
# recoveries in one run, which the production cooldown would (correctly)
# suppress. Throttling has its own coverage in watchdog-supervision.test.sh.
export ORCH_RESTART_COOLDOWN=0
export ORCH_RESTART_COOLDOWN_NIGHT=0
export ORCH_RESTART_STATE_FILE="$RUNTIME_DIR/watchdog-restart-state"
# Standalone-runtime branch: with no relay entry and no ORCH_RELAY_URL the hook
# delivers nothing and only advances liveness, which is all this suite is about.
# It also keeps the suite hermetic — a real delivery would POST to whatever
# daemon happens to be listening on this box and relay a fabricated turn to
# Telegram. (The payload contract itself is locked by turnend-relay.test.sh.)
export ORCH_RELAY_ENTRY="$SCRATCH/absent-relay.ts"
# An inherited ORCH_RELAY_URL would take the curl branch instead, so the suite
# would both leave this box and fail on an unrelated network error.
unset ORCH_RELAY_URL

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

# ── A busy session must never read as dead ──────────────────────────────────
# The heartbeat has exactly one ongoing writer, the turn-end hook, so it says "a
# turn ENDED" and never "a turn is running". Every assertion above therefore
# describes a session that is BOTH silent and idle. This is the other case, and
# it is the one that cost real work: a single turn longer than
# HEARTBEAT_MAX_AGE — a long dispatch, a slow build, a big review — with the
# session alive and producing output the whole time. Before the second signal
# existed the tick went straight to kill-and-relaunch and shot it mid-turn.
NUDGE_OUTBOX="$RUNTIME_DIR/nudges.outbox"
reset_case() { : > "$ACTION_FILE"; rm -f "$NUDGE_OUTBOX" "$RUNTIME_DIR/nudge-rate.tsv"; }

reset_case
printf '%s\n' 100 > "$HEARTBEAT_FILE"
# Heartbeat 11s old against a 10s maximum: stale. Pane output 1s old: alive.
FLEET_NUDGE_REPEAT_MS=0 ORCH_TEST_WINDOW_ACTIVITY=110 ORCH_WATCHDOG_NOW=111 "$SCRIPT_DIR/watchdog.sh"
assert_no_actions
grep -q 'NO-GO reason=heartbeat-stale-session-active .*activity_age_s=1' "$LOG_FILE" ||
  fail 'a session still producing output was not recognised as alive'
# Alive is not the same as healthy: the likeliest reason a live session stopped
# heartbeating is that the turn-end relay broke, and a silently tolerated broken
# relay is how the orchestrator's only liveness signal dies unnoticed.
grep -q 'NUDGE heartbeat-stale-session-active' "$NUDGE_OUTBOX" ||
  fail 'a stale heartbeat on a live session was swallowed instead of surfaced'

# Same stale heartbeat, but the pane has been silent just as long: nothing is
# alive here, and the kill path must still fire.
reset_case
FLEET_NUDGE_REPEAT_MS=0 ORCH_TEST_WINDOW_ACTIVITY=90 ORCH_WATCHDOG_NOW=111 "$SCRIPT_DIR/watchdog.sh"
assert_action stop
assert_action start

# Never-written heartbeat plus a busy pane. This is a fresh session whose first
# turn is simply long — the exact start-up shape that must not be killed.
reset_case
rm -f "$HEARTBEAT_FILE" "$RUNTIME_DIR/heartbeat-missing-since"
ORCH_WATCHDOG_NOW=100 "$SCRIPT_DIR/watchdog.sh"
assert_no_actions
FLEET_NUDGE_REPEAT_MS=0 ORCH_TEST_WINDOW_ACTIVITY=110 ORCH_WATCHDOG_NOW=111 "$SCRIPT_DIR/watchdog.sh"
assert_no_actions

# tmux answering nothing is an ABSENT signal, not a live one: with no evidence
# of activity the stale heartbeat stands and recovery proceeds. This keeps the
# guard from degrading into "never restart anything".
reset_case
printf '%s\n' 100 > "$HEARTBEAT_FILE"
ORCH_WATCHDOG_NOW=111 "$SCRIPT_DIR/watchdog.sh"
assert_action stop
assert_action start
grep -q 'zombie session=.*activity_age_s=unavailable' "$LOG_FILE" ||
  fail 'an unavailable activity signal was not recorded as unavailable'

printf 'heartbeat liveness tests: PASS\n'
