#!/usr/bin/env bash
# Regression lock: a watchdog that STOPS is alerted within the bound and clears
# on restoration, and a watchdog that keeps firing while FAILING is alerted too —
# the case that made 2026-08-04 invisible to this alarm.
set -euo pipefail

DIR=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$DIR/../.." && pwd)
WATCHDOG="$DIR/fleet-nudge.sh"
ALARM="$DIR/fleet-nudge-liveness.sh"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir "$TMP/bin"

# shellcheck source=orchestrator/fleet/awk-portability.sh
. "$DIR/awk-portability.sh"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

# Operator-facing strings are Ukrainian and reach the mock JSON-escaped, so
# assertions compare against the same escaping the alarm produces.
esc() { printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read())[1:-1])'; }

cat >"$TMP/bin/curl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$FLEET_NUDGE_TEST_NOTIFY_LOG"
EOF
cat >"$TMP/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat >"$TMP/bin/tmux" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
chmod +x "$TMP/bin/"*
printf '| id | row | acceptance | state |\n|---|---|---|---|\n| W-1 | pending work | acc | **open** |\n' >"$TMP/board.md"

export PATH="$TMP/bin:$PATH"
export FLEET_NUDGE_HEARTBEAT="$TMP/runtime/heartbeat"
export FLEET_NUDGE_ALERT_STATE="$TMP/runtime/alerted"
export FLEET_NUDGE_FAILING_ALERT_STATE="$TMP/runtime/failing-alerted"
export FLEET_NUDGE_ALERT_DIR="$TMP/runtime"
export FLEET_NUDGE_TEST_NOTIFY_LOG="$TMP/notify.log"
: >"$FLEET_NUDGE_TEST_NOTIFY_LOG"

notifies() { wc -l <"$FLEET_NUDGE_TEST_NOTIFY_LOG" | tr -d ' '; }

# Red-before condition: with the old watchdog, both outcomes left no heartbeat.
set +e
FLEET_NUDGE_BOARD="$TMP/missing-board" "$WATCHDOG" >/dev/null 2>&1
watchdog_status=$?
set -e
test "$watchdog_status" -ne 0
grep -Fxq "status=$watchdog_status" "$FLEET_NUDGE_HEARTBEAT"
FLEET_NUDGE_BOARD="$TMP/board.md" "$WATCHDOG" >/dev/null 2>&1
grep -Fxq 'status=0' "$FLEET_NUDGE_HEARTBEAT"

# The same pair under mawk. This suite's own round-2 failure was inherited — the
# watchdog exited 2 on the valid board above and `set -e` carried that code out
# as the suite's — but it is worth locking on its own terms, because the two
# heartbeat values this alarm reads are exactly what an awk-specific parse
# corrupts: a healthy board must write `status=0`, or every downstream assertion
# here is proving the wrong thing. This is the cheap end-to-end half; the parser
# itself is replayed exhaustively under mawk in fleet-nudge.test.sh.
mawk_shim=$(awk_portability_shim "$TMP")
if [ -n "$mawk_shim" ]; then
  awk_portability=mawk
  (
    PATH="$mawk_shim:$PATH"
    set +e
    FLEET_NUDGE_BOARD="$TMP/missing-board" "$WATCHDOG" >/dev/null 2>&1
    mawk_broken_status=$?
    set -e
    test "$mawk_broken_status" -ne 0 ||
      fail "under mawk an unreadable board was reported healthy"
    grep -Fxq "status=$mawk_broken_status" "$FLEET_NUDGE_HEARTBEAT" ||
      fail "under mawk a failed run did not record its status in the heartbeat"
    FLEET_NUDGE_BOARD="$TMP/board.md" "$WATCHDOG" >/dev/null 2>&1 ||
      fail "under mawk the watchdog refused a valid board"
    grep -Fxq 'status=0' "$FLEET_NUDGE_HEARTBEAT" ||
      fail "under mawk a valid board did not produce a successful heartbeat"
  )
else
  awk_portability=SKIPPED
  awk_portability_skip_notice 'fleet-nudge-liveness.test.sh'
fi

# The query flag must NOT refresh the heartbeat. `--count-open` is a diagnostic
# anyone may run at any time; if it counted as a heartbeat it would keep this
# alarm's own subject looking alive and the staleness check would never fire.
printf 'epoch=1000\nstatus=0\n' >"$FLEET_NUDGE_HEARTBEAT"
"$WATCHDOG" --count-open "$TMP/board.md" >/dev/null
grep -Fxq 'epoch=1000' "$FLEET_NUDGE_HEARTBEAT" ||
  fail "a query flag refreshed the heartbeat it is supposed to supervise"
: >"$FLEET_NUDGE_TEST_NOTIFY_LOG"

# Stop-timer proof: after the final tick, 720s threshold + <=60s check cadence
# + 5s timer accuracy means the operator is told within 12m05s.
printf 'epoch=1000\nstatus=0\n' >"$FLEET_NUDGE_HEARTBEAT"
set +e
FLEET_NUDGE_NOW_EPOCH=1721 "$ALARM"
alarm_status=$?
set -e
test "$alarm_status" -eq 1
test -e "$FLEET_NUDGE_ALERT_STATE"
grep -q 'Fleet watchdog' "$FLEET_NUDGE_TEST_NOTIFY_LOG"
first_count=$(wc -l <"$FLEET_NUDGE_TEST_NOTIFY_LOG")
set +e
FLEET_NUDGE_NOW_EPOCH=1780 "$ALARM"
set -e
test "$(wc -l <"$FLEET_NUDGE_TEST_NOTIFY_LOG")" -eq "$first_count"

# Restore proof: a fresh positive heartbeat tells the operator and clears state.
printf 'epoch=1800\nstatus=0\n' >"$FLEET_NUDGE_HEARTBEAT"
FLEET_NUDGE_NOW_EPOCH=1801 "$ALARM"
test ! -e "$FLEET_NUDGE_ALERT_STATE"
grep -q 'Alert cleared' "$FLEET_NUDGE_TEST_NOTIFY_LOG"

# ── A FRESH heartbeat that reports failure ──────────────────────────────────
# This is the 2026-08-04 shape and the reason the incident was invisible here.
# The watchdog fired every ten minutes and failed every time, so `epoch=` stayed
# perfectly current while `status=` said 2 — and the alarm, which read only
# `epoch=`, reported a healthy watchdog through 36 consecutive failures. The only
# thing that told anyone was the watchdog paging the operator six times an hour:
# the harm channel WAS the detection channel. Deduplicating those messages
# (fleet-nudge.test.sh) without this lock would close detection entirely.
: >"$FLEET_NUDGE_TEST_NOTIFY_LOG"
rm -f "$FLEET_NUDGE_ALERT_STATE" "$FLEET_NUDGE_FAILING_ALERT_STATE"
printf 'epoch=2000\nstatus=2\n' >"$FLEET_NUDGE_HEARTBEAT"
set +e
FLEET_NUDGE_NOW_EPOCH=2001 "$ALARM"
failing_status=$?
set -e
test "$failing_status" -ne 0 ||
  fail "a watchdog failing on every firing was reported healthy"
test -e "$FLEET_NUDGE_FAILING_ALERT_STATE" || fail "a failing watchdog raised no alert state"
test "$(notifies)" -eq 1 ||
  fail "a failing watchdog sent $(notifies) messages, expected exactly 1"
grep -Fq "$(esc 'кодом 2')" "$FLEET_NUDGE_TEST_NOTIFY_LOG" ||
  fail "the failing-watchdog alert did not name the exit status it read"

# Six hours of a one-minute timer against the same failing watchdog: still one
# message. The alert cannot become the storm it exists to replace.
for epoch in $(seq 2002 2361); do
  set +e
  FLEET_NUDGE_NOW_EPOCH=$epoch "$ALARM" >/dev/null 2>&1
  set -e
done
test "$(notifies)" -eq 1 ||
  fail "360 firings against a failing watchdog sent $(notifies) messages, expected 1"

# A run that succeeds clears it, once.
printf 'epoch=2400\nstatus=0\n' >"$FLEET_NUDGE_HEARTBEAT"
FLEET_NUDGE_NOW_EPOCH=2401 "$ALARM"
test ! -e "$FLEET_NUDGE_FAILING_ALERT_STATE" || fail "a recovered watchdog left the alert raised"
test "$(notifies)" -eq 2 || fail "recovery did not tell the operator exactly once"
FLEET_NUDGE_NOW_EPOCH=2402 "$ALARM"
test "$(notifies)" -eq 2 || fail "the cleared failing alert kept talking"

# A heartbeat this alarm cannot read is not a healthy one. Fail closed.
: >"$FLEET_NUDGE_TEST_NOTIFY_LOG"
rm -f "$FLEET_NUDGE_FAILING_ALERT_STATE"
printf 'epoch=2400\n' >"$FLEET_NUDGE_HEARTBEAT"
set +e
FLEET_NUDGE_NOW_EPOCH=2401 "$ALARM"
unreadable_status=$?
set -e
test "$unreadable_status" -ne 0 || fail "a heartbeat with no status= was accepted as healthy"
test "$(notifies)" -eq 1 || fail "a statusless heartbeat sent $(notifies) messages, expected 1"

# A STALE heartbeat carrying a failure reports the silence, not both: two
# messages about one dead watchdog is the volume defect in miniature.
: >"$FLEET_NUDGE_TEST_NOTIFY_LOG"
rm -f "$FLEET_NUDGE_ALERT_STATE" "$FLEET_NUDGE_FAILING_ALERT_STATE"
printf 'epoch=2400\nstatus=2\n' >"$FLEET_NUDGE_HEARTBEAT"
set +e
FLEET_NUDGE_NOW_EPOCH=4000 "$ALARM"
both_status=$?
set -e
test "$both_status" -eq 1 || fail "a stale failing heartbeat exited $both_status, expected 1"
test "$(notifies)" -eq 1 ||
  fail "a stale failing heartbeat sent $(notifies) messages, expected 1"
grep -Fq "$(esc 'замовк')" "$FLEET_NUDGE_TEST_NOTIFY_LOG" ||
  fail "a stale heartbeat was reported as something other than silence"

if grep -Eq '(^|[[:space:]])(kill|pkill|systemctl[[:space:]]+(stop|restart|start)|tmux)([[:space:]]|$)' "$ALARM"; then
  echo 'FAIL: liveness alarm contains process-control behavior' >&2
  exit 1
fi

# ── Reproducible from git ───────────────────────────────────────────────────
# The units are tracked templates that run the alarm out of the checkout, so a
# clone plus the deploy step is the whole mechanism. There is no deployed copy to
# drift from, which is why this file no longer carries a drift channel.
TIMER="$REPO/bootstrap/units/orch-fleet-nudge-liveness.timer.in"
grep -Fq 'OnUnitActiveSec=1min' "$TIMER"
grep -Fq 'AccuracySec=5s' "$TIMER"
grep -q '^ExecStart=\$INSTALL_ROOT/orchestrator/fleet/fleet-nudge-liveness.sh$' \
  "$REPO/bootstrap/units/orch-fleet-nudge-liveness.service.in" ||
  fail "the liveness unit does not run the alarm from the checkout"
printf 'fleet-nudge liveness regression locks: PASS (detection <= 12m05s; recovery clears; a failing watchdog is detected; awk-portability=%s)\n' \
  "$awk_portability"
