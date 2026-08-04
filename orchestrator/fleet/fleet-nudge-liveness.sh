#!/usr/bin/env bash
# Independent, alert-only supervision for the fleet watchdog.
# It never signals, stops, starts, or kills the orchestrator or its lanes.
#
# It answers two questions, because a watchdog has two ways of going quietly
# wrong and only the first one is obvious:
#
#   1. Has it STOPPED? -> the heartbeat's `epoch=` goes stale.
#   2. Is it FAILING?  -> the heartbeat's `status=` is non-zero.
#
# The second one is not a refinement. On 2026-08-04 the watchdog fired every ten
# minutes and failed every time (`refusing to run with an unparseable
# workboard`), which wrote a perfectly fresh heartbeat carrying `status=2` — so
# an alarm that reads only `epoch=` reports a healthy watchdog through an
# unbroken run of failures. The only thing that told anyone was the watchdog
# paging the operator six times an hour: the harm channel WAS the detection
# channel. Deduplicating those messages without reading `status=` here would have
# closed the detection channel and left the harm one silent.
#
# There is deliberately no deployed-copy drift check. The units run the tracked
# script straight out of ${INSTALL_ROOT}, so there is no second copy to diverge
# from — `git pull` is the deploy. The drift channel this file used to carry
# existed only to detect damage caused by copying the script to
# /root/.local/bin in the first place.
set -uo pipefail

HEARTBEAT=${FLEET_NUDGE_HEARTBEAT:-/run/bpa-orchestrator/fleet-nudge.heartbeat}
ALERT_STATE=${FLEET_NUDGE_ALERT_STATE:-/run/bpa-orchestrator/fleet-nudge-liveness.alerted}
FAILING_ALERT_STATE=${FLEET_NUDGE_FAILING_ALERT_STATE:-/run/bpa-orchestrator/fleet-nudge-failing.alerted}
MAX_AGE=${FLEET_NUDGE_HEARTBEAT_MAX_AGE_SECONDS:-720}
DAEMON=${FLEET_NUDGE_DAEMON:-http://127.0.0.1:4822}
NOW=${FLEET_NUDGE_NOW_EPOCH:-$(date +%s)}

notify() {
  curl -fsS -m 10 -X POST "$DAEMON/notify" -H 'Content-Type: application/json' \
    --data "$(printf '{\"text\":%s}' "$(printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')")" \
    >/dev/null
}

if ! [[ "$MAX_AGE" =~ ^[0-9]+$ && "$NOW" =~ ^[0-9]+$ ]]; then
  echo 'fleet-nudge-liveness: invalid numeric configuration' >&2
  exit 2
fi

mkdir -p "$(dirname "$ALERT_STATE")" || exit 2
mkdir -p "$(dirname "$FAILING_ALERT_STATE")" || exit 2
heartbeat_epoch=
heartbeat_status=
if [[ -r "$HEARTBEAT" ]]; then
  heartbeat_epoch=$(sed -n 's/^epoch=//p' "$HEARTBEAT" | head -n 1)
  heartbeat_status=$(sed -n 's/^status=//p' "$HEARTBEAT" | head -n 1)
fi

stale=true
age=unknown
if [[ "$heartbeat_epoch" =~ ^[0-9]+$ ]] && (( heartbeat_epoch <= NOW )); then
  age=$((NOW - heartbeat_epoch))
  (( age <= MAX_AGE )) && stale=false
fi

status=0

if [[ "$stale" == true ]]; then
  if [[ ! -e "$ALERT_STATE" ]]; then
    notify "⚠️ Fleet watchdog замовк: heartbeat відсутній або старший за ${MAX_AGE}с (age=${age}). Перевір orch-fleet-nudge.timer; це лише alert, оркестратор не зупиняється." || exit 3
    : >"$ALERT_STATE" || exit 2
  fi
  status=1
elif [[ -e "$ALERT_STATE" ]]; then
  notify "✅ Fleet watchdog знову подає heartbeat (age=${age}с). Alert cleared." || exit 3
  rm -f "$ALERT_STATE"
fi

# ── A fresh heartbeat that reports failure ──────────────────────────────────
# A fresh heartbeat proves only that the watchdog RAN. `status=` is what it says
# about how the run ended, and reading `epoch=` while ignoring `status=` is how a
# watchdog failing on every single firing keeps a green supervisor.
#
# Evaluated only when the heartbeat is fresh. A stale heartbeat already has its
# own alert above and its `status=` describes a run that may be hours old; two
# messages about one dead watchdog is the volume problem in miniature. The
# failing alert is therefore neither raised nor cleared while stale — it clears
# when a run actually succeeds.
failing=
if [[ "$stale" == false ]]; then
  if [[ ! "$heartbeat_status" =~ ^[0-9]+$ ]]; then
    # Fail closed: a heartbeat this alarm cannot read is not a healthy one.
    failing="heartbeat без читабельного status= (${heartbeat_status:-порожньо})"
  elif ((heartbeat_status != 0)); then
    failing="останній прогін завершився з кодом ${heartbeat_status}"
  fi
fi

if [[ -n "$failing" ]]; then
  if [[ ! -e "$FAILING_ALERT_STATE" ]]; then
    notify "⚠️ Fleet watchdog працює, але падає: ${failing}. Heartbeat свіжий (age=${age}с), тому «замовк» не спрацює — флот не підіймається. Перевір journalctl -u orch-fleet-nudge.service; це лише alert." || exit 3
    : >"$FAILING_ALERT_STATE" || exit 2
  fi
  status=1
elif [[ "$stale" == false && -e "$FAILING_ALERT_STATE" ]]; then
  notify "✅ Fleet watchdog знову завершується успішно (status=0, age=${age}с). Alert cleared." || exit 3
  rm -f "$FAILING_ALERT_STATE"
fi

exit "$status"
