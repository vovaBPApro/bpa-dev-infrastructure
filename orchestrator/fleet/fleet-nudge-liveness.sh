#!/usr/bin/env bash
# Independent, alert-only supervision for the fleet watchdog heartbeat.
# It never signals, stops, starts, or kills the orchestrator or its lanes.
set -uo pipefail

HEARTBEAT=${FLEET_NUDGE_HEARTBEAT:-/run/bpa-orchestrator/fleet-nudge.heartbeat}
ALERT_STATE=${FLEET_NUDGE_ALERT_STATE:-/run/bpa-orchestrator/fleet-nudge-liveness.alerted}
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
heartbeat_epoch=
if [[ -r "$HEARTBEAT" ]]; then
  heartbeat_epoch=$(sed -n 's/^epoch=//p' "$HEARTBEAT" | head -n 1)
fi

stale=true
age=unknown
if [[ "$heartbeat_epoch" =~ ^[0-9]+$ ]] && (( heartbeat_epoch <= NOW )); then
  age=$((NOW - heartbeat_epoch))
  (( age <= MAX_AGE )) && stale=false
fi

if [[ "$stale" == true ]]; then
  if [[ ! -e "$ALERT_STATE" ]]; then
    notify "⚠️ Fleet watchdog замовк: heartbeat відсутній або старший за ${MAX_AGE}с (age=${age}). Перевір orch-fleet-nudge.timer; це лише alert, оркестратор не зупиняється." || exit 3
    : >"$ALERT_STATE" || exit 2
  fi
  exit 1
fi

if [[ -e "$ALERT_STATE" ]]; then
  notify "✅ Fleet watchdog знову подає heartbeat (age=${age}с). Alert cleared." || exit 3
  rm -f "$ALERT_STATE"
fi
