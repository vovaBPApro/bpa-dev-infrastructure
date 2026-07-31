#!/usr/bin/env bash
# TEMPORARY stopgap until ML-2 (ag-ml2-autonomy-keepalive) lands and replaces it
# inside the daemon.
#
# Runs from a systemd TIMER as root on this host — deliberately NOT from the
# orchestrator session. It keeps working if the orchestrator is relaunched, wedged
# or dead, which is the whole point: the Human must not be the thing that notices.
#
# Three outcomes, per the operator's instruction (2026-07-31, Telegram 299):
#   lanes < FLOOR, work REMAINS   -> wake the ORCHESTRATOR (tmux), no Human ping
#   lanes < FLOOR, NO work left   -> ask the HUMAN what to do next (Telegram)
#   orchestrator not running      -> tell the HUMAN it needs starting
set -uo pipefail

SESSION=${FLEET_NUDGE_SESSION:-bpa-orchestrator}
FLOOR=${FLEET_NUDGE_FLOOR:-10}
BOARD=${FLEET_NUDGE_BOARD:-/root/bpa-dev-infrastructure/instance/workboard.md}
DAEMON=${FLEET_NUDGE_DAEMON:-http://127.0.0.1:4822}
LOGFILE=${FLEET_NUDGE_LOGFILE:-/root/.cache/infra-lanes/fleet-nudge.log}
HEARTBEAT=${FLEET_NUDGE_HEARTBEAT:-/run/bpa-orchestrator/fleet-nudge.heartbeat}

write_heartbeat() { # exit_status
  local heartbeat_dir heartbeat_tmp
  heartbeat_dir=$(dirname "$HEARTBEAT")
  mkdir -p "$heartbeat_dir" || return 1
  heartbeat_tmp="$HEARTBEAT.$$"
  printf 'epoch=%s\nstatus=%s\n' "$(date +%s)" "$1" >"$heartbeat_tmp" &&
    mv -f "$heartbeat_tmp" "$HEARTBEAT"
}

finish_with_heartbeat() {
  local watchdog_status=$?
  trap - EXIT
  if ! write_heartbeat "$watchdog_status"; then
    echo "fleet-nudge: cannot write heartbeat: $HEARTBEAT" >&2
    exit 4
  fi
  exit "$watchdog_status"
}
trap finish_with_heartbeat EXIT

count_open_rows() { # board
  awk '
    BEGIN { open = 0; rows = 0; bad = 0 }
    # A row-like bullet may not disappear merely because its ID or marker is
    # malformed. The broad recognizer deliberately includes lowercase IDs.
    /^- / && /\*\*[^*[:space:]]+-[^*[:space:]]+[[:space:]]+—/ {
      rows++
      line = $0
      if (line !~ /^- <!-- status: (open|done|blocked|superseded) --> \*\*[A-Z]+-([0-9]+|GOV)[[:space:]]+—/) {
        printf "fleet-nudge: malformed workboard row at line %d: %s\n", NR, $0 > "/dev/stderr"
        bad = 1
        next
      }
      id = line
      sub(/^- <!-- status: (open|done|blocked|superseded) --> \*\*/, "", id)
      sub(/[[:space:]]+—.*/, "", id)
      if (seen[id]++) {
        printf "fleet-nudge: duplicate workboard id at line %d: %s\n", NR, id > "/dev/stderr"
        bad = 1
      }
      if (line ~ /^- <!-- status: open -->/) open++
    }
    END {
      if (rows == 0) {
        print "fleet-nudge: no parseable workboard rows" > "/dev/stderr"
        exit 2
      }
      if (bad) exit 2
      print open
    }
  ' "$1"
}

if [ "${1:-}" = "--count-open" ]; then
  [ "$#" -eq 2 ] || { echo "usage: $0 --count-open WORKBOARD" >&2; exit 2; }
  count_open_rows "$2"
  exit $?
fi

if [ "${1:-}" = "--verify-deployed" ]; then
  [ "$#" -eq 2 ] || { echo "usage: $0 --verify-deployed DEPLOYED_SCRIPT" >&2; exit 2; }
  if ! cmp -s "$0" "$2"; then
    echo "fleet-nudge: deployed script differs from tracked script: $2" >&2
    exit 1
  fi
  exit 0
fi

notify() { # text
  if ! curl -fsS -m 10 -X POST "$DAEMON/notify" -H 'Content-Type: application/json' \
    --data "$(printf '{"text":%s}' "$(printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')")" \
    >/dev/null; then
    echo "fleet-nudge: operator notification failed" >&2
    return 1
  fi
}

if ! open=$(count_open_rows "$BOARD"); then
  echo "fleet-nudge: refusing to run with an unparseable workboard: $BOARD" >&2
  notify "⚠️ Fleet watchdog не може прочитати workboard. Підрахунок зупинено; перевір $BOARD." || exit 3
  exit 2
fi

running=$(systemctl list-units --type=service --state=running --no-legend 'lane-*' 2>/dev/null | wc -l)
[ "$running" -ge "$FLOOR" ] && exit 0

# Every firing is recorded. This log is the honest metric of whether the
# orchestrator holds the fleet by ITSELF: a nudge that fires often means the
# orchestrator keeps ending its turn with the fleet idle, which is an
# orchestrator defect, not a watchdog success. Vova asked for a number he can
# demand at any time instead of taking the orchestrator's word (Telegram 314).
# Query it with: tail /root/.cache/infra-lanes/fleet-nudge.log
mkdir -p "$(dirname "$LOGFILE")" 2>/dev/null || true
printf '%s fired running=%s floor=%s open_rows=%s\n' \
  "$(date -Is)" "$running" "$FLOOR" "$open" >>"$LOGFILE" 2>/dev/null || true

if [ "$open" -eq 0 ]; then
  # Nothing left to dispatch. This is the ONE case that legitimately goes to the
  # Human, because only he can say what comes next.
  notify "Дошка порожня, активних лейнів $running. Роботи для флоту не лишилось — скажи, що робимо далі." || exit 3
  exit 0
fi

if ! tmux has-session -t "$SESSION" 2>/dev/null; then
  notify "Оркестратор не запущений, а на дошці $open відкритих рядків. Потрібен /start_codex або /start_claude." || exit 3
  exit 0
fi

# Work remains but the fleet is idle => something on the orchestrator side is
# wrong. Wake IT, not the Human.
if [ "$running" -lt 3 ]; then
  notify "⚠️ Лейнів лише $running (потрібно 10). На дошці $open відкритих рядків. Піднімаю." || exit 3
fi

msg="[fleet-nudge] running lanes=$running (floor $FLOOR), workboard open rows=$open. Collect finished lane reports, land what is ACCEPTed, dispatch the next wave. Per HR-281 report the lane count to Vova unprompted."
buf="nudge$$"
tmux set-buffer -b "$buf" -- "$msg" 2>/dev/null || exit 0
tmux paste-buffer -t "$SESSION" -b "$buf" -d 2>/dev/null || exit 0
sleep 1
tmux send-keys -t "$SESSION" Enter 2>/dev/null || true
