#!/usr/bin/env bash
# Regression locks for the fleet watchdog, ported from v2-deprecated and adapted
# to the v3 markdown-table workboard.
set -euo pipefail

DIR=$(cd "$(dirname "$0")" && pwd)
SCRIPT="$DIR/fleet-nudge.sh"
REPO=$(cd "$DIR/../.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# shellcheck source=orchestrator/fleet/awk-portability.sh
. "$DIR/awk-portability.sh"

# Which awk implementation the current replay of the parser locks is running
# under. A failure must name the interpreter: "the parser refused a valid board"
# and "the parser refused a valid board under mawk" are different bug reports,
# and round 2 shipped because only the first one was ever printed.
AWK_LABEL=default

fail() { printf 'FAIL [awk=%s]: %s\n' "$AWK_LABEL" "$*" >&2; exit 1; }

# The operator-facing strings are Ukrainian and reach the mock JSON-escaped, so
# assertions compare against the same escaping the script produces.
esc() { printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read())[1:-1])'; }

board() { # path, rows...
  local path=$1; shift
  {
    printf '# Workboard\n\n'
    printf '| id | row | acceptance | state |\n|---|---|---|---|\n'
    printf '%s\n' "$@"
  } >"$path"
}

expect_count() { # board expected
  local got
  got=$("$SCRIPT" --count-open "$1" 2>/dev/null) || fail "parser refused $1"
  [ "$got" = "$2" ] || fail "$1: open rows $got, expected $2"
}

# ── Classification, one row per state form observed on the real board ────────
# CLOSED is exactly {done, superseded}. Everything else is work the fleet could
# be doing, so it counts OPEN. This block is the lock: changing the rule without
# changing this list makes the counts below disagree.
closed_forms=(
  '| C-1 | row | acc | **done** |'
  '| C-2 | row | acc | **done** — landed `ff152de`. |'
  '| C-3 | row | acc | **superseded** by C-2. |'
)
open_forms=(
  '| O-1 | row | acc | **open** |'
  '| O-2 | row | acc | **open.** |'
  '| O-3 | row | acc | **open — top of the queue.** Fail-before evidence exists. |'
  '| O-4 | row | acc | **in progress on `ag-s6-7b`.** |'
  '| O-5 | row | acc | **in review** — `d88b1af` claims the hard case. |'
  '| O-6 | row | acc | **RECUT REQUIRED 2026-08-04 — the premise moved.** |'
  '| O-7 | row | acc | **blocked** on O-1. |'
  '| O-8 | row | acc | **PARKED 2026-08-03 at the HR-1726 cap.** |'
  '| O-9 | row | acc | **partial** — one half landed. |'
  '| O-10 | row | acc | **done (PARTIAL)** — landed `1f30726`. |'
  '| O-11 | row | acc | **stage 1 done** — landed `88361ff`. |'
  '| O-12 | row | acc | **round 4 REJECTed 2026-08-04.** |'
  '| O-13 | row | acc | **REOPENED 2026-08-04 by the Fable global review.** |'
  '| O-14 | row | acc | **fix landed `2e62608`, structural half still open.** |'
  '| O-15 | row | acc | **landed `fac4f35`, container proof deferred.** |'
  '| O-16 | row | acc | not started — awaiting operator restatement |'
  '| O-17 | row | acc | |'
)

# Everything the parser itself is held to, as one replayable block: it is run
# once under this machine's awk and once under mawk (see the replay below).
parser_locks() {

board "$TMP/closed.md" "${closed_forms[@]}"
expect_count "$TMP/closed.md" 0
board "$TMP/open.md" "${open_forms[@]}"
expect_count "$TMP/open.md" "${#open_forms[@]}"
board "$TMP/mixed.md" "${closed_forms[@]}" "${open_forms[@]}"
expect_count "$TMP/mixed.md" "${#open_forms[@]}"

# Each form individually, so a single misclassification cannot hide inside a sum.
for row in "${closed_forms[@]}"; do
  board "$TMP/one.md" "$row"
  expect_count "$TMP/one.md" 0
done
for row in "${open_forms[@]}"; do
  board "$TMP/one.md" "$row"
  expect_count "$TMP/one.md" 1
done

# An unstated row is counted OPEN and named on stderr — the direction that can
# never read as "no work", and never silently.
board "$TMP/unstated.md" '| U-1 | row | acc | |'
"$SCRIPT" --count-open "$TMP/unstated.md" 2>"$TMP/err" >/dev/null
grep -q 'carry no recognized state, counted OPEN: U-1' "$TMP/err" ||
  fail "an unstated row was not reported"

# ── Table shapes the real board actually contains ────────────────────────────
# A row may carry appended state cells beyond the declared column count; the
# rightmost recognized state is the current one (V3-0.2, V3-0.5, V3-0.21).
board "$TMP/appended.md" '| A-1 | row | acc | **partial** — first verdict. | **done** — superseded by the later landing. |'
expect_count "$TMP/appended.md" 0
board "$TMP/appended2.md" '| A-2 | row | acc | **done** — first verdict. | **open** — REOPENED later. |'
expect_count "$TMP/appended2.md" 1

# An escaped pipe is cell text, not a delimiter (V3-0.40, V3-0.19).
board "$TMP/escaped.md" '| E-1 | `<clean\|NO-GO\|blocker>` in the row text | acc | **open** |'
expect_count "$TMP/escaped.md" 1

# An UNescaped pipe inside a code span splits the row; the state must still be
# found by scanning from the right (V3-2.4).
board "$TMP/unescaped.md" '| E-2 | row | acc | **PARKED 2026-08-03.** removing `assert_model_pin || return $?` makes the suite fail |'
expect_count "$TMP/unescaped.md" 1

# A table without a state column is backlog: its rows are unfinished work and
# count OPEN, but a state cell present anyway is honored (V3-3.6, V3-4.1).
cat >"$TMP/backlog.md" <<'EOF'
| id | row | acceptance | state |
|---|---|---|---|
| S-1 | row | acc | **done** |

| id | row | source |
|---|---|---|
| B-1 | row | HR-1349 |
| B-2 | row | HR-1734 | **done** — landed `472df6b`. |
| B-3 | row | HR-1752 | **in review** — `d88b1af`. |
EOF
expect_count "$TMP/backlog.md" 2

# Prose containing a pipe outside any table is not a row.
cat >"$TMP/prose.md" <<'EOF'
| id | row | acceptance | state |
|---|---|---|---|
| P-1 | row | acc | **open** |

Some prose, then a stray table-looking line:

| x-9 | not a workboard row |
EOF
expect_count "$TMP/prose.md" 1

# ── Fail-closed structural cases (exit 2, never a count) ─────────────────────
printf '# Workboard\n\nNo table at all.\n' >"$TMP/norows.md"
if "$SCRIPT" --count-open "$TMP/norows.md" >"$TMP/out" 2>"$TMP/err"; then
  fail "a board with no rows was accepted"
fi
grep -q 'no parseable workboard rows' "$TMP/err"

cat >"$TMP/nostate.md" <<'EOF'
| id | row | acceptance |
|---|---|---|
| N-1 | row | acc |
EOF
if "$SCRIPT" --count-open "$TMP/nostate.md" >"$TMP/out" 2>"$TMP/err"; then
  fail "a board whose state column vanished was accepted"
fi
grep -q 'no workboard table declares a state column' "$TMP/err"

# The row recognizer is deliberately broad: a malformed id must make the board
# loud, not quietly shrink the count.
board "$TMP/lowercase.md" '| V3-1 | row | acc | **open** |' '| v3-2 | row | acc | **open** |'
if "$SCRIPT" --count-open "$TMP/lowercase.md" >"$TMP/out" 2>"$TMP/err"; then
  fail "lowercase id silently reduced the count"
fi
grep -q 'malformed workboard row at line 6' "$TMP/err"

board "$TMP/duplicate.md" '| V3-1 | first | acc | **open** |' '| V3-1 | duplicate | acc | **done** |'
if "$SCRIPT" --count-open "$TMP/duplicate.md" >"$TMP/out" 2>"$TMP/err"; then
  fail "duplicate id was accepted"
fi
grep -q 'duplicate workboard id' "$TMP/err"

# ── The real board, which is the file the v2 parser died on ─────────────────
real="$REPO/instance/workboard.md"
[ -r "$real" ] || fail "instance/workboard.md is missing"
real_open=$("$SCRIPT" --count-open "$real" 2>"$TMP/err") ||
  fail "the parser refuses the real workboard: $(cat "$TMP/err")"
if grep -q 'malformed workboard row' "$TMP/err"; then fail "the real workboard reports a malformed row"; fi
[ "$real_open" -ge 1 ] || fail "the real workboard counted zero open rows"
real_rows=$(awk '
  !/^[[:space:]]*\|/ { t = 0; next }
  { l = $0; gsub(/\\\|/, "\034", l); sub(/^[[:space:]]*\|/, "", l); sub(/\|[[:space:]]*$/, "", l)
    split(l, c, "|"); id = c[1]; gsub(/^[[:space:]]+|[[:space:]]+$/, "", id)
    if (tolower(id) == "id") { t = 1; next }
    # POSIX-clean for the same reason the parser is: under mawk `-{2,}` matches
    # nothing, so this counter would have swallowed every separator row into
    # `real_rows` and inflated the very number the assertion below leans on.
    if (id ~ /^:?--+:?$/) next
    if (t) n++ }
  END { print n + 0 }' "$real")
[ "$real_open" -lt "$real_rows" ] ||
  fail "every one of the $real_rows real rows counted open — the classifier is not discriminating"

}

# ── awk portability: the parser must behave identically under mawk ───────────
# The whole block above, replayed through a shim directory whose only entry is
# `awk -> mawk`. The parser IS the watchdog, so an awk-specific parse is not a
# test-portability nuisance: on the rebuilt server it is the watchdog refusing
# every board and paging the operator forever.
parser_locks
mawk_shim=$(awk_portability_shim "$TMP")
if [ -n "$mawk_shim" ]; then
  awk_portability=mawk
  # A subshell, so the replay cannot leak its PATH or its label into the timer
  # locks below. `set -e` still propagates a failure out of it.
  (
    PATH="$mawk_shim:$PATH"
    AWK_LABEL=mawk
    # Prove the replay actually took before trusting anything it reports. A shim
    # that silently failed to shadow `awk` would run the whole block under gawk
    # again and print a green that means nothing — the round-2 failure exactly.
    # Compared without a pipe: these suites run under `pipefail`.
    resolved=$(command -v awk)
    [ "$resolved" = "$mawk_shim/awk" ] ||
      fail "the mawk replay did not take: awk resolves to $resolved"
    parser_locks
  )
else
  awk_portability=SKIPPED
  awk_portability_skip_notice 'fleet-nudge.test.sh'
fi

# ── Timer path, through mocked process boundaries ───────────────────────────
mkdir "$TMP/bin"
cat >"$TMP/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
n=${FLEET_NUDGE_TEST_LANES:-0}
for ((i = 0; i < n; i++)); do printf 'lane-%d.service loaded active running\n' "$i"; done
exit 0
EOF
cat >"$TMP/bin/tmux" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$FLEET_NUDGE_TEST_TMUX_LOG"
if [ "$1" = has-session ] && [ "${FLEET_NUDGE_TEST_NO_SESSION:-0}" = 1 ]; then exit 1; fi
exit 0
EOF
cat >"$TMP/bin/curl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$FLEET_NUDGE_TEST_NOTIFY_LOG"
if [ "${FLEET_NUDGE_TEST_NOTIFY_FAIL:-0}" = 1 ]; then exit 22; fi
exit 0
EOF
chmod +x "$TMP/bin/systemctl" "$TMP/bin/tmux" "$TMP/bin/curl"

# FLEET_NUDGE_ALERT_DIR is pinned into $TMP with the heartbeat: the alert state
# is what makes deduplication work, so a test that let it default would both
# write into the host's /run and read another test's episodes.
run_watchdog() {
  PATH="$TMP/bin:$PATH" \
  FLEET_NUDGE_BOARD="$1" \
  FLEET_NUDGE_HEARTBEAT="$TMP/runtime/heartbeat" \
  FLEET_NUDGE_ALERT_DIR="$TMP/runtime" \
  FLEET_NUDGE_LOGFILE="$TMP/fleet.log" \
  FLEET_NUDGE_PASTE_DELAY=0 \
  FLEET_NUDGE_TEST_NOTIFY_LOG="$TMP/notify.log" \
  FLEET_NUDGE_TEST_TMUX_LOG="$TMP/tmux.log" \
  "$SCRIPT"
}

# A fresh episode: no alert state, no history. Every count below starts here, so
# a number in this file is always "messages caused by THIS scenario".
reset_state() {
  rm -rf "$TMP/runtime"
  : >"$TMP/notify.log"
  : >"$TMP/tmux.log"
}
notifies() { wc -l <"$TMP/notify.log" | tr -d ' '; }
pastes() { grep -c 'paste-buffer' "$TMP/tmux.log" || true; }

# Six hours of a ten-minute timer: 02:00 to 08:00, the window in which the
# 2026-08-04 storm was delivered.
NIGHT=36
fire_night() { # board [env assignments applied by caller]
  local i
  for ((i = 0; i < NIGHT; i++)); do
    run_watchdog "$1" >/dev/null 2>&1 || true
  done
}

board "$TMP/valid.md" '| V3-1 | row | acc | **open** |' '| V3-2 | row | acc | **done** |'
board "$TMP/empty.md" '| V3-1 | row | acc | **done** |'

reset_state
run_watchdog "$TMP/valid.md"
grep -q '/notify' "$TMP/notify.log"
grep -q 'has-session' "$TMP/tmux.log"
grep -q 'paste-buffer' "$TMP/tmux.log"

# ── B1: every operator-facing path deduplicates and clears ──────────────────
# THE lock this file was missing. The shipped suite asserted that each condition
# produced a message and never that it produced only one, so 36 identical
# messages a night passed it. Each block below counts messages across a full
# night of firings, then across the repair.

# The 2026-08-04 incident itself: a board the parser refuses.
reset_state
fire_night "$TMP/lowercase.md"
test "$(notifies)" -eq 1 ||
  fail "an unparseable board sent $(notifies) messages over $NIGHT firings, expected 1"
FLEET_NUDGE_TEST_LANES=3 run_watchdog "$TMP/valid.md"
test "$(notifies)" -eq 2 || fail "a repaired board did not tell the operator exactly once"
grep -Fq "$(esc 'знову читає workboard')" "$TMP/notify.log" ||
  fail "the repaired board reported something other than a cleared alert"
FLEET_NUDGE_TEST_LANES=3 run_watchdog "$TMP/valid.md"
FLEET_NUDGE_TEST_LANES=3 run_watchdog "$TMP/valid.md"
test "$(notifies)" -eq 2 || fail "the cleared board alert kept talking after it cleared"

# An idle fleet with work outstanding. The ORCHESTRATOR is woken on every single
# firing — it is a tmux paste, it costs nothing, and waking it is the point. Only
# the HUMAN is deduplicated. Conflating the two is how B1 and B2 became one fix.
reset_state
fire_night "$TMP/valid.md"
test "$(notifies)" -eq 1 ||
  fail "an idle fleet sent $(notifies) messages over $NIGHT firings, expected 1"
test "$(pastes)" -eq "$NIGHT" ||
  fail "the orchestrator was woken $(pastes) times over $NIGHT firings, expected $NIGHT"
FLEET_NUDGE_TEST_LANES=3 run_watchdog "$TMP/valid.md"
test "$(notifies)" -eq 2 || fail "a fleet back at work did not clear the idle alert exactly once"
grep -Fq "$(esc 'Флот знову працює')" "$TMP/notify.log" || fail "the idle alert cleared silently"

# An empty board asks the Human what comes next — once, not once per firing.
reset_state
fire_night "$TMP/empty.md"
test "$(notifies)" -eq 1 ||
  fail "an empty board sent $(notifies) messages over $NIGHT firings, expected 1"
grep -Fq "$(esc 'Роботи для флоту не лишилось')" "$TMP/notify.log" ||
  fail "an empty board did not ask the Human what comes next"
test "$(pastes)" -eq 0 || fail "the orchestrator was nudged with no work left"
FLEET_NUDGE_TEST_LANES=3 run_watchdog "$TMP/valid.md"
test "$(notifies)" -eq 2 || fail "work returning did not clear the empty-board alert exactly once"
grep -Fq "$(esc 'На дошці знову є робота')" "$TMP/notify.log" ||
  fail "the empty-board alert cleared silently"

# A missing orchestrator session. One message, and NOT also an idle message: the
# same situation reported twice is the volume defect in miniature.
reset_state
FLEET_NUDGE_TEST_NO_SESSION=1 fire_night "$TMP/valid.md"
test "$(notifies)" -eq 1 ||
  fail "an absent orchestrator sent $(notifies) messages over $NIGHT firings, expected 1"
grep -Fq "$(esc 'Оркестратор не запущений')" "$TMP/notify.log" ||
  fail "an absent orchestrator was reported as something else"
run_watchdog "$TMP/valid.md"
grep -Fq "$(esc 'Оркестратор знову запущений')" "$TMP/notify.log" ||
  fail "a restarted orchestrator did not clear its alert"

# A condition that repairs and then recurs must be reported AGAIN. Deduplication
# that never releases is silence with extra steps.
reset_state
run_watchdog "$TMP/lowercase.md" >/dev/null 2>&1 || true
FLEET_NUDGE_TEST_LANES=3 run_watchdog "$TMP/valid.md"
run_watchdog "$TMP/lowercase.md" >/dev/null 2>&1 || true
test "$(notifies)" -eq 3 ||
  fail "a recurrence after repair sent $(notifies) messages, expected 3 (raise, clear, raise)"

# Delivery failure must not mark the operator as told. If the state file were
# written before the notify succeeded, the retry ten minutes later would be
# swallowed as a duplicate and the condition would never reach him.
reset_state
set +e
FLEET_NUDGE_TEST_NOTIFY_FAIL=1 run_watchdog "$TMP/valid.md" >"$TMP/out" 2>"$TMP/err"
status=$?
set -e
test "$status" -eq 3 || fail "notification failure exited $status, expected 3"
grep -q 'operator notification failed' "$TMP/err"
test ! -e "$TMP/runtime/fleet-nudge-idle.alerted" ||
  fail "an undelivered alert still marked the operator as told"
test "$(pastes)" -eq 0 || fail "orchestrator was nudged after operator notification failed"
run_watchdog "$TMP/valid.md"
test "$(notifies)" -eq 2 || fail "the retry after a failed delivery did not reach the operator"

# ── B3: the cap is a ceiling, not a floor ───────────────────────────────────
# HR-2342: "Three is a ceiling, not a target: fewer is allowed whenever the work
# does not need them." One and two running lanes are therefore ALLOWED, not a
# fault, and the watchdog must be completely silent at both — the shipped
# version nudged the orchestrator every ten minutes at either count and paged the
# operator every ten minutes at zero.
for lanes in 0 1 2 3; do
  reset_state
  FLEET_NUDGE_TEST_LANES=$lanes run_watchdog "$TMP/valid.md"
  if [ "$lanes" -eq 0 ]; then
    test "$(notifies)" -eq 1 || fail "an idle fleet sent $(notifies) messages, expected 1"
    test "$(pastes)" -eq 1 || fail "an idle fleet did not wake the orchestrator"
  else
    test "$(notifies)" -eq 0 ||
      fail "$lanes running lanes were reported to the operator; HR-2342 permits them"
    test "$(pastes)" -eq 0 ||
      fail "$lanes running lanes nudged the orchestrator; HR-2342 permits them"
  fi
done

# The severe tier must be REACHABLE. `CRITICAL=$((FLOOR / 3))` truncated to 0 at
# any floor below three, and `running -lt 0` is never true, so the operator ping
# was silently unreachable. A zero or a non-integer clamps to 1 instead.
for critical in 0 '' abc; do
  reset_state
  FLEET_NUDGE_CRITICAL="$critical" run_watchdog "$TMP/valid.md"
  test "$(notifies)" -eq 1 ||
    fail "FLEET_NUDGE_CRITICAL='$critical' made the severe tier unreachable"
done

# "Idle" and "below a target width" are different questions with different
# audiences. A target is the seam for the derived budget V3-0.34 asks for; while
# it is set, a non-idle fleet under it wakes the ORCHESTRATOR and never the Human.
reset_state
FLEET_NUDGE_TEST_LANES=2 FLEET_NUDGE_TARGET=3 run_watchdog "$TMP/valid.md"
test "$(notifies)" -eq 0 || fail "a below-target but working fleet paged the operator"
test "$(pastes)" -eq 1 || fail "a below-target fleet did not wake the orchestrator"
reset_state
FLEET_NUDGE_TEST_LANES=3 FLEET_NUDGE_TARGET=3 run_watchdog "$TMP/valid.md"
test "$(pastes)" -eq 0 || fail "a fleet at its target was nudged anyway"

# The operator-facing string must not tell him a number of lanes is REQUIRED.
# That sentence is what turned HR-2342's ceiling into a floor, and it read
# correctly right up until the ruling arrived.
reset_state
run_watchdog "$TMP/valid.md"
grep -Fq "$(esc 'Флот простоює: активних лейнів 0')" "$TMP/notify.log" ||
  fail "the idle warning does not report the actual lane count"
if grep -Fq "$(esc 'потрібно')" "$TMP/notify.log"; then
  fail "the idle warning still tells the operator a lane count is required"
fi

# The wake-up quotes the cap AS a cap, and follows the knob rather than a second
# literal that can drift away from it.
grep -Fq 'caps parallel lanes at 3 — a ceiling, not a target' "$TMP/tmux.log" ||
  fail "the orchestrator wake-up does not quote HR-2538's cap as a ceiling"
# The probe value is deliberately NOT the default: a knob that is followed and a
# knob that is ignored produce the same log line when the two numbers agree.
reset_state
FLEET_NUDGE_CAP=7 run_watchdog "$TMP/valid.md"
grep -Fq 'caps parallel lanes at 7' "$TMP/tmux.log" ||
  fail "the orchestrator wake-up did not follow FLEET_NUDGE_CAP"

# A parse error is operator-loud and remains a failed service invocation.
reset_state
set +e
run_watchdog "$TMP/lowercase.md" >"$TMP/out" 2>"$TMP/err"
status=$?
set -e
test "$status" -eq 2 || fail "malformed runtime board exited $status, expected 2"
grep -q '/notify' "$TMP/notify.log"
grep -q 'refusing to run with an unparseable workboard' "$TMP/err"

# ── Reproducible from git: the units run from the checkout ───────────────────
# The mechanism has exactly one copy, the tracked one. A unit pointing at a
# second copy under /root/.local/bin is what let the deployed script be
# hand-edited to 120 lines against the tracked 141 and diverge in silence.
for unit in orch-fleet-nudge.service orch-fleet-nudge-liveness.service; do
  template="$REPO/bootstrap/units/$unit.in"
  [ -r "$template" ] || fail "$unit has no tracked template at bootstrap/units/"
  grep -q '^ExecStart=\$INSTALL_ROOT/orchestrator/fleet/' "$template" ||
    fail "$unit does not run the watchdog from the checkout"
  if grep -q '/root/.local/bin' "$template"; then
    fail "$unit still points at a second, hand-editable copy of the script"
  fi
  grep -q '^EnvironmentFile=' "$template" ||
    fail "$unit exposes no configuration surface; FLEET_NUDGE_* would need a hand-edited unit"
done
grep -q '^unit:orch-fleet-nudge.timer' "$REPO/instance/expected-mechanisms.tsv" ||
  fail "the watchdog timer is not registered in expected-mechanisms.tsv"

# The awk-portability verdict is part of the recorded result, not only a stderr
# notice: a reader of this line must be able to tell a proven parser from one
# that was merely never contradicted on the dev box.
printf 'fleet-nudge watchdog regression locks: PASS (real workboard open rows=%s of %s; awk-portability=%s)\n' \
  "$real_open" "$real_rows" "$awk_portability"
