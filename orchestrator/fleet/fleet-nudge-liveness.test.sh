#!/usr/bin/env bash
# Regression lock: timer silence alerts within the bound and restoration clears it.
set -euo pipefail

DIR=$(cd "$(dirname "$0")" && pwd)
WATCHDOG="$DIR/fleet-nudge.sh"
ALARM="$DIR/fleet-nudge-liveness.sh"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir "$TMP/bin"

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
printf '%s\n' '- <!-- status: open --> **W-1 — pending work**' >"$TMP/board.md"

export PATH="$TMP/bin:$PATH"
export FLEET_NUDGE_HEARTBEAT="$TMP/runtime/heartbeat"
export FLEET_NUDGE_ALERT_STATE="$TMP/runtime/alerted"
export FLEET_NUDGE_TEST_NOTIFY_LOG="$TMP/notify.log"
: >"$FLEET_NUDGE_TEST_NOTIFY_LOG"

# Red-before condition: with the old watchdog, both outcomes left no heartbeat.
set +e
FLEET_NUDGE_BOARD="$TMP/missing-board" "$WATCHDOG" >/dev/null 2>&1
watchdog_status=$?
set -e
test "$watchdog_status" -ne 0
grep -Fxq "status=$watchdog_status" "$FLEET_NUDGE_HEARTBEAT"
FLEET_NUDGE_BOARD="$TMP/board.md" "$WATCHDOG" >/dev/null 2>&1
grep -Fxq 'status=0' "$FLEET_NUDGE_HEARTBEAT"

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

if grep -Eq '(^|[[:space:]])(kill|pkill|systemctl[[:space:]]+(stop|restart|start)|tmux)([[:space:]]|$)' "$ALARM"; then
  echo 'FAIL: liveness alarm contains process-control behavior' >&2
  exit 1
fi
grep -Fq 'OnUnitActiveSec=1min' "$DIR/orch-fleet-nudge-liveness.timer"
grep -Fq 'AccuracySec=5s' "$DIR/orch-fleet-nudge-liveness.timer"
printf 'fleet-nudge liveness regression locks: PASS (detection <= 12m05s; recovery clears)\n'
