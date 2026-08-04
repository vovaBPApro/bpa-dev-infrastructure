#!/usr/bin/env bash
# Regression lock: timer silence alerts within the bound and restoration clears
# it, and a hand-edited deployed copy is reported rather than assumed identical.
set -euo pipefail

DIR=$(cd "$(dirname "$0")" && pwd)
WATCHDOG="$DIR/fleet-nudge.sh"
ALARM="$DIR/fleet-nudge-liveness.sh"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir "$TMP/bin"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

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
export FLEET_NUDGE_DRIFT_ALERT_STATE="$TMP/runtime/drift-alerted"
export FLEET_NUDGE_TEST_NOTIFY_LOG="$TMP/notify.log"
: >"$FLEET_NUDGE_TEST_NOTIFY_LOG"

# The heartbeat section pins the deployed pair to a matching copy so that the
# drift channel stays silent and cannot be confused with the timer channel.
cp "$WATCHDOG" "$TMP/deployed.sh"
export FLEET_NUDGE_TRACKED="$WATCHDOG"
export FLEET_NUDGE_DEPLOYED="$TMP/deployed.sh"

# Red-before condition: with the old watchdog, both outcomes left no heartbeat.
set +e
FLEET_NUDGE_BOARD="$TMP/missing-board" "$WATCHDOG" >/dev/null 2>&1
watchdog_status=$?
set -e
test "$watchdog_status" -ne 0
grep -Fxq "status=$watchdog_status" "$FLEET_NUDGE_HEARTBEAT"
FLEET_NUDGE_BOARD="$TMP/board.md" "$WATCHDOG" >/dev/null 2>&1
grep -Fxq 'status=0' "$FLEET_NUDGE_HEARTBEAT"

# The query flags must NOT refresh the heartbeat. This alarm calls
# `--verify-deployed` every minute; if that counted as a heartbeat, the alarm
# would keep its own subject looking alive and never fire.
printf 'epoch=1000\nstatus=0\n' >"$FLEET_NUDGE_HEARTBEAT"
"$WATCHDOG" --verify-deployed "$TMP/deployed.sh"
"$WATCHDOG" --count-open "$TMP/board.md" >/dev/null
grep -Fxq 'epoch=1000' "$FLEET_NUDGE_HEARTBEAT" ||
  fail "a query flag refreshed the heartbeat it is supposed to supervise"

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

# ── Deployed-copy drift, the 2026-08-04 condition ───────────────────────────
# The host script was 120 lines against the tracked 141: hand-edited, diverged,
# and silent because `--verify-deployed` had no caller. This alarm is the caller.
: >"$FLEET_NUDGE_TEST_NOTIFY_LOG"
printf 'epoch=1800\nstatus=0\n' >"$FLEET_NUDGE_HEARTBEAT"
FLEET_NUDGE_NOW_EPOCH=1801 "$ALARM"
test ! -e "$FLEET_NUDGE_DRIFT_ALERT_STATE" ||
  fail "an identical deployed copy raised a drift alert"
test ! -s "$FLEET_NUDGE_TEST_NOTIFY_LOG" ||
  fail "an identical deployed copy notified the operator"

head -n 20 "$WATCHDOG" >"$TMP/deployed.sh"
set +e
FLEET_NUDGE_NOW_EPOCH=1801 "$ALARM"
drift_status=$?
set -e
test "$drift_status" -eq 1 ||
  fail "a hand-edited deployed copy exited $drift_status, expected 1"
test -e "$FLEET_NUDGE_DRIFT_ALERT_STATE" || fail "drift raised no alert state"
grep -q 'deployed' "$FLEET_NUDGE_TEST_NOTIFY_LOG" || fail "drift did not reach the operator"
drift_count=$(wc -l <"$FLEET_NUDGE_TEST_NOTIFY_LOG")
set +e
FLEET_NUDGE_NOW_EPOCH=1802 "$ALARM"
set -e
test "$(wc -l <"$FLEET_NUDGE_TEST_NOTIFY_LOG")" -eq "$drift_count" ||
  fail "the drift alert repeated instead of deduplicating"

# A deployed copy that is not there at all is drift, not a pass.
rm -f "$TMP/deployed.sh"
rm -f "$FLEET_NUDGE_DRIFT_ALERT_STATE"
set +e
FLEET_NUDGE_NOW_EPOCH=1803 "$ALARM"
missing_status=$?
set -e
test "$missing_status" -eq 1 || fail "a missing deployed copy exited $missing_status, expected 1"
test -e "$FLEET_NUDGE_DRIFT_ALERT_STATE" || fail "a missing deployed copy raised no alert"

# Redeploying clears the alert, so the operator learns the drift is closed.
cp "$WATCHDOG" "$TMP/deployed.sh"
FLEET_NUDGE_NOW_EPOCH=1804 "$ALARM"
test ! -e "$FLEET_NUDGE_DRIFT_ALERT_STATE" || fail "a restored deployed copy left the alert raised"
grep -q 'Alert cleared' "$FLEET_NUDGE_TEST_NOTIFY_LOG"

# An unreadable tracked path is unconfigured, not drift: loud on stderr, no ping.
: >"$FLEET_NUDGE_TEST_NOTIFY_LOG"
rm -f "$FLEET_NUDGE_DRIFT_ALERT_STATE"
FLEET_NUDGE_TRACKED="$TMP/no-such-tracked.sh" FLEET_NUDGE_NOW_EPOCH=1805 "$ALARM" 2>"$TMP/err"
grep -q 'drift unchecked' "$TMP/err" || fail "an unreadable tracked path was silent"
test ! -s "$FLEET_NUDGE_TEST_NOTIFY_LOG" || fail "an unreadable tracked path pinged the operator"

if grep -Eq '(^|[[:space:]])(kill|pkill|systemctl[[:space:]]+(stop|restart|start)|tmux)([[:space:]]|$)' "$ALARM"; then
  echo 'FAIL: liveness alarm contains process-control behavior' >&2
  exit 1
fi
grep -Fq 'OnUnitActiveSec=1min' "$DIR/orch-fleet-nudge-liveness.timer"
grep -Fq 'AccuracySec=5s' "$DIR/orch-fleet-nudge-liveness.timer"
printf 'fleet-nudge liveness regression locks: PASS (detection <= 12m05s; recovery clears; deployed drift reported)\n'
