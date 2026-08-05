#!/usr/bin/env bash
# TEMPORARY stopgap until ML-2 (ag-ml2-autonomy-keepalive) lands and replaces it
# inside the daemon.
#
# Runs from a systemd TIMER as root on this host — deliberately NOT from the
# orchestrator session. It keeps working if the orchestrator is relaunched, wedged
# or dead, which is the whole point: the Human must not be the thing that notices.
#
# Three outcomes, per the operator's instruction (2026-07-31, Telegram 299):
#   fleet IDLE, work REMAINS      -> wake the ORCHESTRATOR (tmux), tell the Human once
#   fleet IDLE, NO work left      -> ask the HUMAN what to do next (Telegram)
#   orchestrator not running      -> tell the HUMAN it needs starting
#
# "Idle" replaces Telegram 299's "below the floor" because HR-2342 later capped
# the fleet at three lanes; see the CRITICAL/TARGET block below for why a cap
# cannot also be a floor. Every operator-facing outcome is deduplicated: this
# fires every ten minutes, so an unguarded notify is a night of messages, not a
# message.
set -uo pipefail

SESSION=${FLEET_NUDGE_SESSION:-bpa-orchestrator}

# ── What counts as a fault ──────────────────────────────────────────────────
# This watchdog measures IDLENESS, not shortfall. HR-2538 caps parallel lanes at
# five (raising HR-2342's three, whose framing it leaves standing): "a ceiling,
# not a target: fewer is allowed whenever the work does not need them." A
# watchdog that installs that ceiling as a floor turns every lane count the
# ruling expressly permits into a permanent fault, and sub-floor IS the normal
# state, so the nudge would fire forever. Raising the cap widens that band rather
# than narrowing it, which is why CRITICAL below does not move with the cap.
#
# `autonomy-and-capacity` states the same rule for the orchestrator in prose:
# "report when the fleet is idle against available work, not on a fixed number."
# This is that rule in code.
#
#   running < CRITICAL   the fleet is doing NOTHING while work remains. Wake the
#                        orchestrator, and tell the Human once (deduplicated).
#   running < TARGET     below a capacity-derived width: wake the orchestrator
#                        only, never the Human. DISABLED by default, see below.
#   otherwise            allowed by HR-2342. Silent.
int_or() { # value default -- a non-integer knob falls back rather than making `[` error out
  case "$1" in
    '' | *[!0-9]*) printf '%s' "$2" ;;
    *) printf '%s' "$1" ;;
  esac
}
# Never zero. `running -lt 0` is unreachable, so a zero here silently deletes the
# severe tier — which is exactly what `CRITICAL=$((FLOOR / 3))` did at any floor
# below three (1 -> 0, 2 -> 0).
CRITICAL=$(int_or "${FLEET_NUDGE_CRITICAL:-1}" 1)
[ "$CRITICAL" -ge 1 ] || CRITICAL=1
# The seam for the capacity-derived budget row V3-0.34 asks for, deliberately OFF
# (0) by default: no measured host capacity exists yet, and installing another
# underived constant here is the defect that row exists to end. Replacing an
# underived 10 with an underived 3 would re-commit it.
TARGET=$(int_or "${FLEET_NUDGE_TARGET:-0}" 0)
# The HR-2456 ceiling (five, raised from HR-2342's three), quoted to the
# orchestrator so it knows how wide it may go. It is not a trigger: nothing in
# this script compares the lane count against it, and CRITICAL above stays at 1
# regardless of what this becomes.
CAP=$(int_or "${FLEET_NUDGE_CAP:-3}" 3)

BOARD=${FLEET_NUDGE_BOARD:-/root/bpa-dev-infrastructure/instance/workboard.md}
DAEMON=${FLEET_NUDGE_DAEMON:-http://127.0.0.1:4822}
LOGFILE=${FLEET_NUDGE_LOGFILE:-/root/.cache/infra-lanes/fleet-nudge.log}
HEARTBEAT=${FLEET_NUDGE_HEARTBEAT:-/run/bpa-orchestrator/fleet-nudge.heartbeat}
ALERT_DIR=${FLEET_NUDGE_ALERT_DIR:-/run/bpa-orchestrator}
# tmux needs a moment between the paste and the Enter that submits it, or the
# agent reads a half-arrived line. Named rather than inlined so the regression
# locks can fire a full night of nudges without spending a real second on each.
PASTE_DELAY=${FLEET_NUDGE_PASTE_DELAY:-1}

# ── Idle hysteresis ─────────────────────────────────────────────────────────
# The dedup above is per EPISODE, and an episode used to end the instant one lane
# appeared. So a fleet oscillating around zero — lane exits, next lane starts,
# repeat — ended and reopened an episode every cycle and paid the operator TWO
# messages per cycle: the raise and its clear. That is the ~9 consecutive
# messages he screenshotted. It is not a threshold set wrong; it is an episode
# boundary drawn at the wrong place.
#
# So both edges get a dwell. The fleet must be idle for a while before he is
# told, and back at work for a while before the episode is declared over.
#
# WHERE THE NUMBER COMES FROM. The sampling quantum is the timer period,
# `OnUnitActiveSec=10min` in bootstrap/units/orch-fleet-nudge.timer.in — the
# watchdog cannot resolve anything shorter, so nothing shorter can be a
# meaningful dwell. That the quantum is also the right dwell is measured, not
# assumed: of the 14 genuine idle episodes in the timer's own log
# (/root/.cache/infra-lanes/fleet-nudge.log, 2026-08-05, restricted to firings
# that read the real board), SEVEN lasted exactly one tick — idle at one sample,
# working at the next. Half of all idle episodes were handovers that resolved
# themselves inside one period, and every one of them paged him. Requiring
# idleness to outlive one full period removes exactly that population and
# nothing else; the longest real idle run was 9 ticks and would still alert.
# The busy dwell is the same number for the same reason: single-busy-tick
# interruptions occur too, and one of them must not be read as recovery.
#
# The tracked timer is the source, so a change to it must not silently leave
# this behind: fleet-nudge.test.sh reads OnUnitActiveSec out of the unit template
# and fails if this default stops matching it.
TIMER_PERIOD=$(int_or "${FLEET_NUDGE_TIMER_PERIOD:-600}" 600)
IDLE_SUSTAIN=$(int_or "${FLEET_NUDGE_IDLE_SUSTAIN:-$TIMER_PERIOD}" "$TIMER_PERIOD")
BUSY_DWELL=$(int_or "${FLEET_NUDGE_BUSY_DWELL:-$TIMER_PERIOD}" "$TIMER_PERIOD")
# How long after telling him before telling him AGAIN about the same stall, for
# the first repeat; it doubles from there (see raise_idle). Same measured source
# as the dwells: the longest genuine idle run in the timer's log was 9 ticks, so
# 9 periods is the point past which a stall has outlasted anything this fleet has
# ever done in normal operation. Repeating sooner would be reporting behaviour
# that has been observed to resolve itself.
IDLE_REALERT=$(int_or "${FLEET_NUDGE_IDLE_REALERT:-$((TIMER_PERIOD * 9))}" "$((TIMER_PERIOD * 9))")

# Every time-dependent decision reads this, never `date` directly, so the
# regression locks can drive days of fleet behaviour without sleeping through
# them — the same reason PASTE_DELAY above is a knob.
now() { printf '%s' "${FLEET_NUDGE_NOW:-$(date +%s)}"; }

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
      # `--+` and not `-{2,}`: mawk does not enable regex intervals by default,
      # and this awk program IS the watchdog. Under mawk the interval matched
      # nothing, so the `|---|---|` separator row of every table fell through to
      # the id recognizer below, failed it, and made EVERY board read as
      # structurally damaged — a fail-closed refusal of a perfectly good board,
      # forever. This host has gawk and a clean Ubuntu 24.04 has mawk, so the
      # defect was invisible here and total on the machine the operator is
      # rebuilding onto. Keep this program POSIX-clean; awk-portability.sh locks
      # it under mawk by name.
      #
      # NOTE: this whole awk program is a single-quoted bash string, so no
      # comment in it may contain an apostrophe. One would close the quote and
      # break the script at parse time, which bash reports as an error on this
      # line rather than on the comment that caused it.
      if (cell[1] ~ /^:?--+:?$/) next
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

# Armed only for the timer path, deliberately AFTER the query flag. `--count-open`
# is a diagnostic anyone may run at any moment; if it wrote a heartbeat it would
# keep the watchdog's own supervisor looking at a fresh timestamp for a watchdog
# that has not fired in hours, and the staleness detection that is the entire
# point of the liveness alarm would never fire.
trap finish_with_heartbeat EXIT

if ! mkdir -p "$ALERT_DIR"; then
  echo "fleet-nudge: cannot create alert state directory: $ALERT_DIR" >&2
  exit 5
fi

notify() { # text
  if ! curl -fsS -m 10 -X POST "$DAEMON/notify" -H 'Content-Type: application/json' \
    --data "$(printf '{"text":%s}' "$(printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')")" \
    >/dev/null; then
    echo "fleet-nudge: operator notification failed" >&2
    return 1
  fi
}

# ── Alert deduplication ─────────────────────────────────────────────────────
# This runs every ten minutes, so an undeduplicated notify is not a message, it
# is 36 messages between 02:00 and 08:00 — which is what happened on 2026-08-04
# and is the reason the timer had to be stopped. Every operator-facing condition
# therefore raises AT MOST ONCE per episode and says so again only when it
# repairs. The state file is the episode: present means "he has been told".
#
# The clear message is not politeness, it is the other half of the contract. A
# raise with no clear teaches the operator that a message means nothing, because
# he can never tell whether the condition is still true.
#
# State lives under /run (tmpfs): a reboot forgets the episodes and each standing
# condition re-announces itself once. That is the correct direction to fail — a
# repeated alert is noise, a swallowed one is a dead fleet nobody is watching.
alert_state() { printf '%s/fleet-nudge-%s.alerted' "$ALERT_DIR" "$1"; }

# How long the current unbroken run of a condition has lasted. The file holds the
# epoch the run STARTED, so the answer survives a firing and does not depend on
# how many times the timer happened to fire — this script is invoked irregularly
# (its own log shows firings seconds apart as well as ten minutes apart), so
# counting firings would measure the invoker, not the fleet.
streak_file() { printf '%s/fleet-nudge-%s.since' "$ALERT_DIR" "$1"; }

streak_since() { # key now -> epoch the run began, starting one if none is open
  local file began
  file=$(streak_file "$1")
  began=$(cat "$file" 2>/dev/null)
  case "$began" in
    '' | *[!0-9]*)
      began=$2
      if ! printf '%s\n' "$began" >"$file"; then
        echo "fleet-nudge: cannot write streak state: $file" >&2
        return 1
      fi
      ;;
  esac
  printf '%s' "$began"
}

streak_break() { rm -f "$(streak_file "$1")"; }

raise() { # key text
  local state
  state=$(alert_state "$1")
  [ -e "$state" ] && return 0
  # The state file is written only AFTER delivery succeeds. Writing it first
  # would mark the operator as told by a message that never arrived.
  notify "$2" || return 1
  if ! : >"$state"; then
    echo "fleet-nudge: cannot write alert state: $state" >&2
    return 1
  fi
}

clear_alert() { # key text
  local state
  state=$(alert_state "$1")
  [ -e "$state" ] || return 0
  notify "$2" || return 1
  rm -f "$state"
}

# The idle alert is the one condition that may speak more than once per episode,
# and this is deliberate. A fleet stuck at zero for eight hours told once at 02:00
# is a fleet nobody is watching by 03:00: if he misses that single message there
# is no second signal, ever, and the mission brief is explicit that suppression
# which cannot be escaped is worse than the flood, because the flood is at least
# honest.
#
# So it repeats on a DOUBLING interval, the first repeat IDLE_REALERT after the
# first message. A stall is announced at +10m and re-announced at +100m, +280m,
# +640m... — the message count grows with the LOGARITHM of the stall, so a six
# hour night costs three messages where the timer would have sent thirty-six, a
# full week costs seven, and no stall however long ever goes permanently silent.
# There is deliberately no ceiling on the interval: a cap would reintroduce a
# fixed message rate, and an uncapped double is the only shape that is both
# eventually-quiet and never-silent.
#
# The state file carries "<epoch of last message> <messages so far>"; removing it
# (clear_alert, or a reboot clearing the tmpfs) resets the backoff to the start,
# so the next real stall is reported promptly rather than inheriting a stale
# interval.
raise_idle() { # now text
  local state last count interval
  state=$(alert_state idle)
  count=0
  if [ -e "$state" ]; then
    read -r last count <"$state" 2>/dev/null || true
    case "$last" in '' | *[!0-9]*) last='' ;; esac
    case "$count" in '' | *[!0-9]*) count=0 ;; esac
    if [ -n "$last" ]; then
      # IDLE_REALERT * 2^(count-1), by doubling: bash has no pow, and this keeps
      # the arithmetic integer and inspectable.
      interval=$IDLE_REALERT
      local i=1
      while [ "$i" -lt "$count" ]; do interval=$((interval * 2)); i=$((i + 1)); done
      [ $(($1 - last)) -ge "$interval" ] || return 0
    fi
  fi
  # Written only AFTER delivery succeeds, for the same reason raise() is: a
  # message that never arrived must not advance the backoff past him.
  notify "$2" || return 1
  if ! printf '%s %s\n' "$1" "$((count + 1))" >"$state"; then
    echo "fleet-nudge: cannot write alert state: $state" >&2
    return 1
  fi
}

if ! open=$(count_open_rows "$BOARD"); then
  echo "fleet-nudge: refusing to run with an unparseable workboard: $BOARD" >&2
  raise board "⚠️ Fleet watchdog не може прочитати workboard. Підрахунок зупинено; перевір $BOARD." || exit 3
  exit 2
fi
clear_alert board "✅ Fleet watchdog знову читає workboard: $open відкритих рядків. Alert cleared." || exit 3

running=$(systemctl list-units --type=service --state=running --no-legend 'lane-*' 2>/dev/null | wc -l)
session_up=true
tmux has-session -t "$SESSION" 2>/dev/null || session_up=false

# Every alert's CLEAR is evaluated on every firing, including the firings where
# the watchdog then has nothing else to do. Raising happens further down, inside
# the branch that owns each condition — but a clear that could only run from
# inside its own branch would stay latched once the fleet got busy, and the next
# real occurrence would then be swallowed as a duplicate. A latched alert is a
# silent one, so the release is deliberately the unconditional half.
[ "$open" -gt 0 ] &&
  { clear_alert empty "✅ На дошці знову є робота: $open відкритих рядків. Alert cleared." || exit 3; }
[ "$session_up" = true ] &&
  { clear_alert session "✅ Оркестратор знову запущений. Alert cleared." || exit 3; }

# The idle edges. Whichever way the fleet is, the OTHER run is broken and this
# one is opened, so both durations are always measured from a real transition.
NOW=$(now)
if [ "$running" -ge "$CRITICAL" ]; then
  streak_break idle
  busy_since=$(streak_since busy "$NOW") || exit 5
  # A single busy tick is not recovery — the log shows the fleet returning for
  # one period and dropping straight back. Clearing on it would end the episode,
  # and the next drop to zero would then read as new and page him again: the
  # clear is the other half of the flood, not the cure for it.
  [ $((NOW - busy_since)) -ge "$BUSY_DWELL" ] &&
    { clear_alert idle "✅ Флот знову працює: активних лейнів $running. Alert cleared." || exit 3; }
else
  streak_break busy
  idle_since=$(streak_since idle "$NOW") || exit 5
fi

# 1 or 2 lanes at the default settings land here and the watchdog stays silent:
# HR-2342 permits them, so they are not a fault and must not be reported as one.
if [ "$running" -ge "$CRITICAL" ] && { [ "$TARGET" -eq 0 ] || [ "$running" -ge "$TARGET" ]; }; then
  exit 0
fi

# Every firing that ACTS is recorded. This log is the honest metric of whether
# the orchestrator holds the fleet by ITSELF: a nudge that fires often means the
# orchestrator keeps ending its turn with the fleet idle, which is an
# orchestrator defect, not a watchdog success. Vova asked for a number he can
# demand at any time instead of taking the orchestrator's word (Telegram 314).
# Query it with: tail /root/.cache/infra-lanes/fleet-nudge.log
mkdir -p "$(dirname "$LOGFILE")" 2>/dev/null || true
printf '%s fired running=%s critical=%s target=%s open_rows=%s\n' \
  "$(date -Is)" "$running" "$CRITICAL" "$TARGET" "$open" >>"$LOGFILE" 2>/dev/null || true

if [ "$open" -eq 0 ]; then
  # Nothing left to dispatch. This is the ONE case that legitimately goes to the
  # Human, because only he can say what comes next.
  raise empty "Дошка порожня, активних лейнів $running. Роботи для флоту не лишилось — скажи, що робимо далі." || exit 3
  exit 0
fi

if [ "$session_up" = false ]; then
  # Nothing to wake, and this message already carries the lane count, so the
  # idle alert would be a second message about the same situation.
  raise session "Оркестратор не запущений, а на дошці $open відкритих рядків. Потрібен /start_codex або /start_claude." || exit 3
  exit 0
fi

# Work remains but the fleet is doing none of it => something on the orchestrator
# side is wrong. Wake IT, and tell the Human once.
#
# The ORCHESTRATOR is still woken on every single firing, below the dwell and
# above it — that is the tmux paste further down, it costs nothing, and waking it
# is how the idleness gets fixed without anyone being told about it. Only the
# HUMAN waits for the dwell. That split is the whole design: react immediately,
# escalate only if the reaction did not work.
if [ "$running" -lt "$CRITICAL" ] && [ $((NOW - idle_since)) -ge "$IDLE_SUSTAIN" ]; then
  raise_idle "$NOW" "⚠️ Флот простоює: активних лейнів $running, на дошці $open відкритих рядків. Піднімаю оркестратор." || exit 3
fi

msg="[fleet-nudge] running lanes=$running, workboard open rows=$open. HR-2538 caps parallel lanes at $CAP — a ceiling, not a target. Collect finished lane reports, land what is ACCEPTed, dispatch the next wave. Per HR-281 report the lane count to Vova unprompted."
buf="nudge$$"
tmux set-buffer -b "$buf" -- "$msg" 2>/dev/null || exit 0
tmux paste-buffer -t "$SESSION" -b "$buf" -d 2>/dev/null || exit 0
sleep "$PASTE_DELAY"
tmux send-keys -t "$SESSION" Enter 2>/dev/null || true
