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
# HR-2342 (2026-08-04) caps parallel lanes at three, so three is the floor the
# fleet is expected to hold. The old default of 10 predates that ruling.
FLOOR=${FLEET_NUDGE_FLOOR:-3}
# The orchestrator is nudged at ANY sub-floor reading; the Human is told only at
# the severe tier. That tier was written as a bare "3" against a floor of 10 —
# two constants that could drift apart independently, and did. It is now derived
# from the floor at the same ratio (floor 10 -> 3, floor 3 -> 1), so the floor is
# the single knob and the operator-facing string below quotes it rather than a
# literal.
CRITICAL=${FLEET_NUDGE_CRITICAL:-$((FLOOR / 3))}
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

# The v3 workboard is a markdown TABLE, not the v2 status-comment bullet list.
# The counter answers exactly one question — "is there work the fleet could be
# doing" — so the classification is deliberately asymmetric:
#
#   CLOSED (not counted): **done**, **superseded**. Those are the only two states
#     that mean the row will never need a lane again.
#   OPEN (counted): everything else — open, partial, in progress, in review,
#     blocked, parked, RECUT REQUIRED, REOPENED, round-N REJECTed, stage-N done,
#     AND any row whose state cell is missing or unrecognized.
#
# Unknown counts as OPEN on purpose. Under-counting silences the watchdog and
# tells the operator "nothing left" while work is outstanding; over-counting at
# worst nudges the orchestrator, which is cheap. An unrecognized state is still
# reported on stderr — quiet is not the same as invisible.
#
# Structural damage is a different class and stays fail-closed (exit 2): no
# parseable rows, no table declaring a `state` column, a malformed id, or a
# duplicate id. A board that cannot be read must never read as "no work".
count_open_rows() { # board
  awk '
    function trim(s) { gsub(/^[[:space:]]+|[[:space:]]+$/, "", s); return s }

    # "closed", "open", or "" when the cell carries no recognizable state.
    function classify(cell,   head, low) {
      if (cell !~ /^\*\*/) return ""
      head = cell
      if (match(head, /^\*\*[^*]+\*\*/)) head = substr(head, 3, RLENGTH - 4)
      else head = substr(head, 3)
      low = tolower(head)
      if (low ~ /^(open|partial|in progress|in review|blocked|parked|recut required|reopened|rejected|round|stage|fix )/) return "open"
      # "done (PARTIAL)" says partial in its own words; it is not a finished row.
      if (low ~ /^done/ && low ~ /\(partial\)/) return "open"
      if (low ~ /^(done|superseded)/) return "closed"
      return ""
    }

    BEGIN { rows = 0; open = 0; bad = 0; intable = 0; hasstate = 0; statetables = 0; unstated = "" }

    # Any non-table line closes the current table, so a stray pipe in prose
    # cannot be read as a row.
    !/^[[:space:]]*\|/ { intable = 0; next }

    {
      line = $0
      gsub(/\\\|/, "\034", line)          # an escaped pipe is cell text, not a delimiter
      sub(/^[[:space:]]*\|/, "", line)
      sub(/\|[[:space:]]*$/, "", line)
      n = split(line, cell, "|")
      for (i = 1; i <= n; i++) { cell[i] = trim(cell[i]); gsub(/\034/, "|", cell[i]) }

      if (tolower(cell[1]) == "id") {
        intable = 1
        hasstate = (tolower(cell[n]) == "state")
        if (hasstate) statetables++
        next
      }
      if (cell[1] ~ /^:?-{2,}:?$/) next
      if (!intable) next

      rows++
      id = cell[1]
      # The recognizer above is deliberately broad — it matches any table row,
      # including one whose id is malformed. A row must not disappear from the
      # count merely because its id is wrong; it must make the board loud.
      if (id !~ /^[A-Z][A-Z0-9]*-([0-9]+(\.[0-9]+)?[a-z]?|GOV)$/) {
        printf "fleet-nudge: malformed workboard row at line %d: %s\n", NR, $0 > "/dev/stderr"
        bad = 1
        next
      }
      if (seen[id]++) {
        printf "fleet-nudge: duplicate workboard id at line %d: %s\n", NR, id > "/dev/stderr"
        bad = 1
      }

      # Rows carry appended state cells beyond the declared column count; the
      # rightmost recognizable state is the current one. Scan from the right and
      # never as far as the id cell.
      state = ""
      for (i = n; i >= 2; i--) { state = classify(cell[i]); if (state != "") break }
      if (state == "") {
        # Reported once as a summary at the end rather than a line per row: this
        # runs every ten minutes, and a warning nobody can read is a warning
        # nobody acts on.
        if (hasstate) unstated = unstated (unstated == "" ? "" : " ") id
        state = "open"
      }
      if (state == "open") open++
    }

    END {
      if (unstated != "")
        printf "fleet-nudge: workboard rows carry no recognized state, counted OPEN: %s\n", unstated > "/dev/stderr"
      if (rows == 0) {
        print "fleet-nudge: no parseable workboard rows" > "/dev/stderr"
        exit 2
      }
      if (statetables == 0) {
        print "fleet-nudge: no workboard table declares a state column" > "/dev/stderr"
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

# Armed only for the timer path, deliberately AFTER the query flags. The liveness
# alarm calls `--verify-deployed` every minute; if that wrote a heartbeat, the
# watchdog-for-the-watchdog would keep its own subject looking alive and the
# staleness detection it exists for would never fire.
trap finish_with_heartbeat EXIT

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
if [ "$running" -lt "$CRITICAL" ]; then
  notify "⚠️ Лейнів лише $running (потрібно $FLOOR). На дошці $open відкритих рядків. Піднімаю." || exit 3
fi

msg="[fleet-nudge] running lanes=$running (floor $FLOOR), workboard open rows=$open. Collect finished lane reports, land what is ACCEPTed, dispatch the next wave. Per HR-281 report the lane count to Vova unprompted."
buf="nudge$$"
tmux set-buffer -b "$buf" -- "$msg" 2>/dev/null || exit 0
tmux paste-buffer -t "$SESSION" -b "$buf" -d 2>/dev/null || exit 0
sleep 1
tmux send-keys -t "$SESSION" Enter 2>/dev/null || true
