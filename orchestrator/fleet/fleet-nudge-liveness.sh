#!/usr/bin/env bash
# Independent, alert-only supervision for the fleet watchdog heartbeat.
# It never signals, stops, starts, or kills the orchestrator or its lanes.
#
# It also answers the second way a watchdog goes quietly wrong: the deployed copy
# stops being the tracked copy. On 2026-08-04 the host script was 120 lines
# against the tracked 141 — hand-edited, diverged, and nothing noticed, because
# `--verify-deployed` existed and nothing invoked it. It is invoked from here.
set -uo pipefail

HEARTBEAT=${FLEET_NUDGE_HEARTBEAT:-/run/bpa-orchestrator/fleet-nudge.heartbeat}
ALERT_STATE=${FLEET_NUDGE_ALERT_STATE:-/run/bpa-orchestrator/fleet-nudge-liveness.alerted}
DRIFT_ALERT_STATE=${FLEET_NUDGE_DRIFT_ALERT_STATE:-/run/bpa-orchestrator/fleet-nudge-drift.alerted}
TRACKED=${FLEET_NUDGE_TRACKED:-/root/bpa-dev-infrastructure/orchestrator/fleet/fleet-nudge.sh}
DEPLOYED=${FLEET_NUDGE_DEPLOYED:-/root/.local/bin/orch-fleet-nudge.sh}
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
mkdir -p "$(dirname "$DRIFT_ALERT_STATE")" || exit 2
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

# ── Deployed-copy drift ─────────────────────────────────────────────────────
# A fresh heartbeat only proves SOMETHING ran. It says nothing about whether what
# ran is what the repository tracks, which is Hard Floor 5: a mechanism living
# only on the host is already a regression.
drift=
if [[ ! -r "$TRACKED" || ! -x "$TRACKED" ]]; then
  # Unconfigured rather than drifted: this alarm can be installed where the
  # repository is not. Loud on stderr, but not an operator ping.
  echo "fleet-nudge-liveness: tracked watchdog not readable, drift unchecked: $TRACKED" >&2
elif [[ ! -e "$DEPLOYED" ]]; then
  drift="deployed копія відсутня: $DEPLOYED"
elif ! "$TRACKED" --verify-deployed "$DEPLOYED" 2>/dev/null; then
  drift="deployed копія розійшлася з репозиторієм: $DEPLOYED"
fi

if [[ -n "$drift" ]]; then
  if [[ ! -e "$DRIFT_ALERT_STATE" ]]; then
    notify "⚠️ Fleet watchdog: $drift. Хтось правив скрипт на хості; треба перевикласти з репозиторію. Це лише alert." || exit 3
    : >"$DRIFT_ALERT_STATE" || exit 2
  fi
  status=1
elif [[ -e "$DRIFT_ALERT_STATE" ]]; then
  notify "✅ Fleet watchdog: deployed копія знову збігається з репозиторієм. Alert cleared." || exit 3
  rm -f "$DRIFT_ALERT_STATE"
fi

exit "$status"
