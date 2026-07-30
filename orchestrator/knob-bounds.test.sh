#!/usr/bin/env bash
# Bounded-knob lock (BLOCKER 2): one central parser, both surfaces.
#
# install-watchdog.sh used to interpolate ORCH_WATCHDOG_INTERVAL into a systemd
# unit file unvalidated: `0` shipped a zero-period timer, and a value with an
# embedded newline appended arbitrary unit directives ([Service]/ExecStartPre —
# code execution as the user). watchdog.sh accepted `0` for cadence, heartbeat
# age and restart cooldown ([0-9]+ only, no bounds), which turns the anti-thrash
# throttle off and makes every tick a restart. This suite locks:
#   * the installer REFUSES every invalid boundary value BEFORE any unit file
#     exists (0, below-min, above-max, non-numeric, empty, newline-injection);
#   * the tick falls back to the documented safe default on the same values —
#     specifically, a zero cooldown must NOT produce a restart storm.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRATCH="$(mktemp -d)"
SHIM="$SCRATCH/bin"
trap 'rm -rf "$SCRATCH"' EXIT
mkdir -p "$SHIM"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

# ── The parser itself, at every boundary ────────────────────────────────────
# shellcheck disable=SC1091
source "$SCRIPT_DIR/knobs.sh"
expect_reject() { # <value> <min> <max> <reason>
  local value="$1" min="$2" max="$3" reason="$4"
  if knob_check "$value" "$min" "$max"; then
    fail "knob_check accepted $(printf '%q' "$value") in [$min,$max]"
  fi
  [[ "$KNOB_REASON" == "$reason" ]] ||
    fail "knob_check rejected $(printf '%q' "$value") with reason=$KNOB_REASON, expected $reason"
}
knob_check 10 10 86400 || fail 'knob_check rejected the lower bound itself'
knob_check 86400 10 86400 || fail 'knob_check rejected the upper bound itself'
knob_check 0 0 10 || fail 'knob_check rejected 0 where the range allows it'
expect_reject '' 10 86400 empty
expect_reject 0 10 86400 below-min
expect_reject 9 10 86400 below-min
expect_reject 86401 10 86400 above-max
expect_reject 99999999999999999999 10 86400 above-max
expect_reject abc 10 86400 non-numeric
expect_reject ' 60' 10 86400 non-numeric
expect_reject -60 10 86400 non-numeric
expect_reject 6.5 10 86400 non-numeric
expect_reject $'60\nOnBootSec=0' 10 86400 non-numeric
expect_reject $'60\n[Service]\nExecStartPre=/tmp/evil' 10 86400 non-numeric

# ── Installer: an invalid cadence never reaches a unit file ─────────────────
cat > "$SHIM/systemctl" <<'EOF'
#!/usr/bin/env bash
printf 'systemctl %s\n' "$*" >> "${ORCH_TEST_SYSTEMCTL_CALLS:?}"
exit 0
EOF
chmod +x "$SHIM/systemctl"
export ORCH_TEST_SYSTEMCTL_CALLS="$SCRATCH/systemctl.calls"

CASE_INDEX=0
try_install() { # <interval-value>; sets UNITS + INSTALL_STATUS + INSTALL_ERR
  CASE_INDEX=$(( CASE_INDEX + 1 ))
  UNITS="$SCRATCH/units-$CASE_INDEX"
  INSTALL_ERR="$SCRATCH/install-$CASE_INDEX.err"
  mkdir -p "$UNITS"
  : > "$ORCH_TEST_SYSTEMCTL_CALLS"
  INSTALL_STATUS=0
  env PATH="$SHIM:$PATH" ORCH_SYSTEMD_USER_DIR="$UNITS" ORCH_WATCHDOG_UNIT=bounds-fixture \
    ORCH_WATCHDOG_INTERVAL="$1" "$SCRIPT_DIR/install-watchdog.sh" install \
    >/dev/null 2>"$INSTALL_ERR" || INSTALL_STATUS=$?
}

INJECTION=$'60\nOnBootSec=0\n[Service]\nExecStartPre=/tmp/evil'
# '' deliberately LAST: the post-loop assertion reads the final case's stderr.
for bad in 0 9 86401 abc "$INJECTION" ''; do
  try_install "$bad"
  (( INSTALL_STATUS == 2 )) ||
    fail "installer accepted invalid cadence $(printf '%q' "$bad") (exit $INSTALL_STATUS)"
  # The whole point: nothing was written. Not the timer, not the service, no
  # temp staging files a later step could resurrect — and systemd was never
  # touched (no daemon-reload, no enable).
  [[ -z "$(ls -A "$UNITS")" ]] ||
    fail "installer wrote unit material for $(printf '%q' "$bad"): $(find "$UNITS" -mindepth 1 -printf '%f ')"
  [[ ! -s "$ORCH_TEST_SYSTEMCTL_CALLS" ]] ||
    fail "installer touched systemctl for invalid cadence $(printf '%q' "$bad")"
  # The refusal names the reason and never echoes the hostile value back.
  grep -q 'invalid-watchdog-cadence reason=' "$INSTALL_ERR" ||
    fail "installer refusal for $(printf '%q' "$bad") did not name a reason"
  if grep -q 'ExecStartPre' "$INSTALL_ERR"; then
    fail 'the installer echoed hostile input back to the terminal'
  fi
done
# The empty case must be the EMPTY refusal, not a silent fall-through to the
# alias or the default — a knob set to '' is a misconfiguration, not a choice.
grep -q 'reason=empty' "$INSTALL_ERR" ||
  fail 'a set-but-empty cadence fell through instead of refusing as empty'

try_install 123
(( INSTALL_STATUS == 0 )) || fail "installer refused a valid cadence (exit $INSTALL_STATUS)"
grep -qx 'OnUnitActiveSec=123' "$UNITS/bounds-fixture.timer" ||
  fail 'valid cadence was not rendered into the timer'

# ── Tick path: invalid knobs mean the documented default, never a storm ─────
cat > "$SHIM/tmux" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  has-session) [[ "${ORCH_TEST_SESSION_ALIVE:-1}" == 1 ]] ;;
  list-panes) ps -o ppid= -p "$PPID" | tr -d ' ' ;;
  *) exit 0 ;;
esac
EOF
cat > "$SCRATCH/launch.sh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$1" >> "${ORCH_TEST_ACTIONS:?}"
EOF
chmod +x "$SHIM/tmux" "$SCRATCH/launch.sh"

TICK_INDEX=0
new_tick_case() { # fresh isolated runtime; RUNTIME/LOG/ACTIONS point into it
  TICK_INDEX=$(( TICK_INDEX + 1 ))
  RUNTIME="$SCRATCH/tick-$TICK_INDEX"
  LOG="$RUNTIME/watchdog.log"
  ACTIONS="$RUNTIME/actions"
  mkdir -p "$RUNTIME"
  : > "$ACTIONS"
}
tick() { # <env assignments…> — runs one watchdog tick in the current case
  env PATH="$SHIM:$PATH" ORCH_CONFIG_FILE="$SCRATCH/no-config" ORCH_STATE_DB="$SCRATCH/no-state.db" \
    ORCH_RUNTIME_DIR="$RUNTIME" ORCH_WATCHDOG_LOG="$LOG" \
    ORCH_HEARTBEAT_FILE="$RUNTIME/orchestrator.heartbeat" \
    ORCH_HEARTBEAT_MISSING_SINCE_FILE="$RUNTIME/heartbeat-missing-since" \
    ORCH_LIVENESS_FILE="$RUNTIME/orchestrator.liveness" \
    ORCH_LEASE_FILE="$RUNTIME/orchestrator.lease" \
    ORCH_RESTART_STATE_FILE="$RUNTIME/watchdog-restart-state" \
    NUDGE_OUTBOX_FILE="$RUNTIME/nudges.outbox" NUDGE_RATE_FILE="$RUNTIME/nudge-rate.tsv" \
    ORCH_INSTANCE_LOCK_FILE="$RUNTIME/instance.lock" \
    ORCH_DONE_SENTINEL="$SCRATCH/no-done-sentinel" ORCH_DAEMON_HEALTH_URL="" \
    ORCH_LAUNCH_SCRIPT="$SCRATCH/launch.sh" ORCH_TEST_ACTIONS="$ACTIONS" \
    ORCH_INSTALL_ROOT="$SCRATCH" DOCKER_PRUNE_ENABLED=0 \
    "$@" "$SCRIPT_DIR/watchdog.sh"
}
log_has() { grep -qF "$1" "$LOG" || fail "missing log line: $1"; }
start_count() { grep -cx start "$ACTIONS" || true; }

# A zero cooldown used to disable the anti-thrash throttle outright. Now it is
# rejected, the documented default (1800s day) applies, and a second dead tick
# 120s later is SUPPRESSED — the restart-storm lock.
new_tick_case
tick ORCH_TEST_SESSION_ALIVE=0 ORCH_RESTART_COOLDOWN=0 ORCH_WATCHDOG_HOUR=12 ORCH_WATCHDOG_NOW=1000000
log_has 'invalid-knob name=RESTART_COOLDOWN_S value=0 using-default=1800 reason=below-min'
[[ "$(start_count)" == 1 ]] || fail 'first recovery did not restart'
tick ORCH_TEST_SESSION_ALIVE=0 ORCH_RESTART_COOLDOWN=0 ORCH_WATCHDOG_HOUR=12 ORCH_WATCHDOG_NOW=1000120
[[ "$(start_count)" == 1 ]] ||
  fail 'RESTART STORM: a zero cooldown let a second restart through 120s later'
log_has 'restart-suppressed'

# A zero heartbeat age would turn a just-written heartbeat stale on the same
# tick. With the default restored, a 100s-old heartbeat stays comfortably live.
new_tick_case
printf '%s\n' 999900 > "$RUNTIME/orchestrator.heartbeat"
tick ORCH_HEARTBEAT_MAX_AGE=0 ORCH_WATCHDOG_NOW=1000000
log_has 'invalid-knob name=HEARTBEAT_MAX_AGE value=0 using-default=1200 reason=below-min'
[[ ! -s "$ACTIONS" ]] || fail 'a zero heartbeat age killed a live session'
# Decisively: the heartbeat was never even judged stale — had 0 been honoured,
# the tick would have entered the stale-heartbeat verdict table.
if grep -Eq 'liveness-signal-absent|zombie session=|heartbeat-stale' "$LOG"; then
  fail 'a zero heartbeat age was honoured instead of replaced by the default'
fi

# Every remaining boundary class falls back and says so.
new_tick_case; tick ORCH_WATCHDOG_INTERVAL=0
log_has 'invalid-knob name=WATCHDOG_INTERVAL_S value=0 using-default=60 reason=below-min'
new_tick_case; tick ORCH_WATCHDOG_INTERVAL=999999
log_has 'invalid-knob name=WATCHDOG_INTERVAL_S value=999999 using-default=60 reason=above-max'
new_tick_case; tick ORCH_RESTART_COOLDOWN=99999999 ORCH_WATCHDOG_HOUR=12
log_has 'invalid-knob name=RESTART_COOLDOWN_S value=99999999 using-default=1800 reason=above-max'
new_tick_case; tick ORCH_HEARTBEAT_MAX_AGE=abc
log_has 'invalid-knob name=HEARTBEAT_MAX_AGE value=abc using-default=1200 reason=non-numeric'
new_tick_case; tick ORCH_LIVENESS_MAX_AGE=0
log_has 'invalid-knob name=LIVENESS_MAX_AGE value=0 using-default=120 reason=below-min'

# A newline-carrying value is rejected AND cannot forge log lines: the logged
# copy is stripped of control characters before it reaches the log.
new_tick_case; tick ORCH_RESTART_COOLDOWN=$'60\nFORGED-LOG-LINE' ORCH_WATCHDOG_HOUR=12
log_has 'invalid-knob name=RESTART_COOLDOWN_S value=60FORGED-LOG-LINE using-default=1800 reason=non-numeric'
if grep -qx 'FORGED-LOG-LINE' "$LOG"; then
  fail 'a hostile knob value injected a log line'
fi

# Ordering: a cooldown shorter than the tick interval cannot throttle anything,
# so it is clamped up to the interval.
new_tick_case; tick ORCH_WATCHDOG_INTERVAL=600 ORCH_RESTART_COOLDOWN=60 ORCH_WATCHDOG_HOUR=12 ORCH_LEASE_TTL_MS=1300000
log_has 'invalid-knob-ordering name=RESTART_COOLDOWN_S value=60 floor=WATCHDOG_INTERVAL_S clamped=600'

printf 'knob bounds tests: PASS\n'
