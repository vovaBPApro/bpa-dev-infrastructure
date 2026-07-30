#!/usr/bin/env bash
# Regression lock for the watchdog's liveness verdicts (BLOCKER 1).
#
# The heartbeat has exactly one ongoing writer, the turn-end hook, so it proves
# "a turn ENDED" — never "a turn is running". tmux window_activity proves
# "bytes were printed". A legitimate long turn that prints nothing satisfies
# neither, and the old tick classified it as a zombie and killed the in-flight
# answer. The fix adds a POSITIVE signal: orchestrator-liveness-pulse.sh
# re-stamps orchestrator.liveness while the provider PID exists and stops when
# it dies. The verdict table this suite locks, in both directions:
#
#   pulse fresh                  -> alive (however silent): NEVER stop/start
#   output fresh                 -> alive: never stop/start
#   pulse present but stale      -> the renewer died with its owner: recover
#   pulse absent or unparseable  -> ambiguity: alert, never stop
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRATCH="$(mktemp -d)"
SHIM="$SCRATCH/bin"
RUNTIME_DIR="$SCRATCH/runtime"
LOG_FILE="$RUNTIME_DIR/watchdog.log"
ACTION_FILE="$SCRATCH/actions"

SILENT_PID=""
PULSE_PID=""
cleanup() {
  if [[ -n "$SILENT_PID" ]]; then kill "$SILENT_PID" 2>/dev/null || true; fi
  if [[ -n "$PULSE_PID" ]]; then kill "$PULSE_PID" 2>/dev/null || true; fi
  rm -rf "$SCRATCH"
}
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
assert_no_actions() { [[ ! -s "$ACTION_FILE" ]] || fail "unexpected recovery action: $(tr '\n' ' ' < "$ACTION_FILE")"; }

export ORCH_CONFIG_FILE="$SCRATCH/no-config"
export ORCH_RUNTIME_DIR="$RUNTIME_DIR"
export ORCH_WATCHDOG_LOG="$LOG_FILE"
export ORCH_STATE_DB="$SCRATCH/no-state.db"
export ORCH_TEST_ACTIONS="$ACTION_FILE"
export ORCH_LAUNCH_SCRIPT="$SCRATCH/launch.sh"
export ORCH_HEARTBEAT_MAX_AGE=10
# The verdict thresholds are driven with small synthetic clocks below, so the
# pulse staleness bound is pinned to its minimum. 15 is a VALID knob value —
# an invalid one would silently fall back to the default and skew every case.
export ORCH_LIVENESS_MAX_AGE=15
export PATH="$SHIM:$PATH"
# Live-state isolation. Both the turn-end hook and watchdog.sh resolve these
# from the environment, and each override wins over ORCH_RUNTIME_DIR, so a lane
# inheriting the orchestrator's environment would write the operator's real
# heartbeat (masking a dead orchestrator), delete the real lease file, and
# append to the real nudge outbox — which the daemon forwards to Telegram.
export ORCH_HEARTBEAT_FILE="$RUNTIME_DIR/orchestrator.heartbeat"
export ORCH_HEARTBEAT_MISSING_SINCE_FILE="$RUNTIME_DIR/heartbeat-missing-since"
export ORCH_LIVENESS_FILE="$RUNTIME_DIR/orchestrator.liveness"
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

HEARTBEAT_FILE="$RUNTIME_DIR/orchestrator.heartbeat"
LIVENESS_FILE="$RUNTIME_DIR/orchestrator.liveness"
NUDGE_OUTBOX="$RUNTIME_DIR/nudges.outbox"
# Zeroing the restart-state file (not the cooldown knob) lets each case recover
# independently: 0 is no longer a legal cooldown — the central knob parser
# rejects it, precisely because it used to disable the anti-thrash throttle.
reset_case() {
  : > "$ACTION_FILE"
  rm -f "$NUDGE_OUTBOX" "$RUNTIME_DIR/nudge-rate.tsv" "$ORCH_RESTART_STATE_FILE"
}

# This used to pass '{}', which daemon/relay.ts rejects as an unsupported hook
# payload; the hook exited non-zero and `set -e` killed the suite before its
# first assertion. Use the real Codex notify shape.
"$SCRIPT_DIR/orchestrator-turnend-relay.sh" \
  '{"type":"agent-turn-complete","thread-id":"thread-liveness","turn-id":"turn-liveness","cwd":"/work","last-assistant-message":"done"}'
[[ -f "$HEARTBEAT_FILE" ]] || fail "turn-end relay did not write default heartbeat"

reset_case
ORCH_WATCHDOG_NOW="$(date +%s)" "$SCRIPT_DIR/watchdog.sh"
assert_no_actions

# ── Positive death evidence still recovers ──────────────────────────────────
# Stale heartbeat AND a pulse stamp that stopped renewing: the in-pane loop
# only stops when the provider PID is gone, so this is a corpse.
reset_case
printf '%s\n' 100 > "$HEARTBEAT_FILE"
printf '%s\n' 90 > "$LIVENESS_FILE"       # age 21 > ORCH_LIVENESS_MAX_AGE=15
ORCH_WATCHDOG_NOW=111 "$SCRIPT_DIR/watchdog.sh"
assert_action stop
assert_action start
grep -q 'zombie session=.*action=kill-relaunch' "$LOG_FILE" || fail "stale heartbeat was not logged"
grep -q 'zombie session=.*pulse_age_s=21' "$LOG_FILE" || fail "the kill verdict did not record the stale pulse evidence"

# Same corpse, heartbeat file missing entirely: the missing-since grace ticks
# first, then the stale pulse still authorizes recovery.
reset_case
rm -f "$HEARTBEAT_FILE" "$RUNTIME_DIR/heartbeat-missing-since"
printf '%s\n' 90 > "$LIVENESS_FILE"
ORCH_WATCHDOG_NOW=100 "$SCRIPT_DIR/watchdog.sh"
assert_no_actions
ORCH_WATCHDOG_NOW=111 "$SCRIPT_DIR/watchdog.sh"
assert_action stop
assert_action start
grep -q 'heartbeat-missing session=.*action=kill-relaunch' "$LOG_FILE" || fail "missing heartbeat was not logged"

# ── A busy session must never read as dead ──────────────────────────────────
# Heartbeat 11s old against a 10s maximum: stale. Pane output 1s old: alive.
# No pulse file at all — output alone must still protect the session.
reset_case
rm -f "$LIVENESS_FILE"
printf '%s\n' 100 > "$HEARTBEAT_FILE"
FLEET_NUDGE_REPEAT_MS=0 ORCH_TEST_WINDOW_ACTIVITY=110 ORCH_WATCHDOG_NOW=111 "$SCRIPT_DIR/watchdog.sh"
assert_no_actions
grep -q 'NO-GO reason=heartbeat-stale-session-active .*activity_age_s=1' "$LOG_FILE" ||
  fail 'a session still producing output was not recognised as alive'
# Alive is not the same as healthy: the likeliest reason a live session stopped
# heartbeating is that the turn-end relay broke, and a silently tolerated broken
# relay is how the orchestrator's only liveness signal dies unnoticed.
grep -q 'NUDGE heartbeat-stale-session-active' "$NUDGE_OUTBOX" ||
  fail 'a stale heartbeat on a live session was swallowed instead of surfaced'

# Same stale heartbeat, pane silent just as long, pulse stale too: nothing is
# alive here, and the kill path must still fire.
reset_case
printf '%s\n' 100 > "$HEARTBEAT_FILE"
printf '%s\n' 90 > "$LIVENESS_FILE"
FLEET_NUDGE_REPEAT_MS=0 ORCH_TEST_WINDOW_ACTIVITY=90 ORCH_WATCHDOG_NOW=111 "$SCRIPT_DIR/watchdog.sh"
assert_action stop
assert_action start

# Never-written heartbeat plus a busy pane. This is a fresh session whose first
# turn is simply long — the exact start-up shape that must not be killed.
reset_case
rm -f "$HEARTBEAT_FILE" "$RUNTIME_DIR/heartbeat-missing-since" "$LIVENESS_FILE"
ORCH_WATCHDOG_NOW=100 "$SCRIPT_DIR/watchdog.sh"
assert_no_actions
FLEET_NUDGE_REPEAT_MS=0 ORCH_TEST_WINDOW_ACTIVITY=110 ORCH_WATCHDOG_NOW=111 "$SCRIPT_DIR/watchdog.sh"
assert_no_actions

# ── Ambiguity is an alert, never a kill ─────────────────────────────────────
# Stale heartbeat, tmux answering nothing, and NO pulse file: the wrapper never
# ran or the knob points elsewhere. Stale-heartbeat + stale-output alone cannot
# distinguish a silent live turn from a corpse — the old tick killed here and
# shot live sessions. The operator is told the liveness signal is broken; a
# genuinely dead PROCESS still recovers via the dead-session path (its pane
# dies with it), and via the stale-pulse cases above once the pulse exists.
reset_case
rm -f "$LIVENESS_FILE"
printf '%s\n' 100 > "$HEARTBEAT_FILE"
FLEET_NUDGE_REPEAT_MS=0 ORCH_WATCHDOG_NOW=111 "$SCRIPT_DIR/watchdog.sh"
assert_no_actions
grep -q 'NO-GO reason=liveness-signal-absent .*action=no-kill' "$LOG_FILE" ||
  fail 'an absent liveness signal was not reported as ambiguity'
grep -q 'NUDGE liveness-signal-absent' "$NUDGE_OUTBOX" ||
  fail 'a broken liveness signal was swallowed instead of surfaced'

# An unparseable pulse file is the same ambiguity, not evidence either way.
reset_case
printf 'garbage\n' > "$LIVENESS_FILE"
printf '%s\n' 100 > "$HEARTBEAT_FILE"
FLEET_NUDGE_REPEAT_MS=0 ORCH_WATCHDOG_NOW=111 "$SCRIPT_DIR/watchdog.sh"
assert_no_actions
grep -c 'NO-GO reason=liveness-signal-absent' "$LOG_FILE" | grep -qx 2 ||
  fail 'an unparseable pulse file was not treated as ambiguity'

# ── BLOCKER-1 lock (a): a LIVE silent foreground process is never killed ────
# A real process, alive right now, that has produced no bytes and ended no turn
# for far longer than every threshold. The REAL pulse loop watches it, exactly
# as launch.sh wires it inside the pane. No stop/start may happen.
reset_case
rm -f "$LIVENESS_FILE"
sleep 300 & SILENT_PID=$!
"$SCRIPT_DIR/orchestrator-liveness-pulse.sh" "$SILENT_PID" "$LIVENESS_FILE" 5 & PULSE_PID=$!
for _ in $(seq 50); do [[ -f "$LIVENESS_FILE" ]] && break; sleep 0.1; done
[[ -f "$LIVENESS_FILE" ]] || fail 'the pulse loop never stamped the liveness file'
real_now="$(date +%s)"
printf '%s\n' "$(( real_now - 2000 ))" > "$HEARTBEAT_FILE"
FLEET_NUDGE_REPEAT_MS=0 ORCH_TEST_WINDOW_ACTIVITY="$(( real_now - 2000 ))" \
  ORCH_WATCHDOG_NOW="$real_now" "$SCRIPT_DIR/watchdog.sh"
assert_no_actions
grep -q 'NO-GO reason=heartbeat-stale-process-live .*action=no-kill' "$LOG_FILE" ||
  fail 'a live silent process was not recognised as alive by the pulse'
grep -q 'NUDGE heartbeat-stale-process-live' "$NUDGE_OUTBOX" ||
  fail 'the stale heartbeat on a pulse-alive session was not surfaced'

# ── BLOCKER-1 lock (b): the SAME process, genuinely dead, is recovered ──────
# Kill the watched process; the pulse loop exits with it and its last stamp
# ages out. The identical fixture must now recover — the no-kill rule above is
# evidence-driven, not "never restart anything".
kill "$SILENT_PID" 2>/dev/null || true
wait "$SILENT_PID" 2>/dev/null || true
SILENT_PID=""
for _ in $(seq 100); do kill -0 "$PULSE_PID" 2>/dev/null || break; sleep 0.1; done
if kill -0 "$PULSE_PID" 2>/dev/null; then
  fail 'the pulse loop outlived the process it watches'
fi
PULSE_PID=""
reset_case
FLEET_NUDGE_REPEAT_MS=0 ORCH_TEST_WINDOW_ACTIVITY="$(( real_now - 2000 ))" \
  ORCH_WATCHDOG_NOW="$(( real_now + 200 ))" "$SCRIPT_DIR/watchdog.sh"
assert_action stop
assert_action start
grep -q 'zombie session=.*action=kill-relaunch' "$LOG_FILE" ||
  fail 'a genuinely dead process was not detected through its stale pulse'

printf 'heartbeat liveness tests: PASS\n'
