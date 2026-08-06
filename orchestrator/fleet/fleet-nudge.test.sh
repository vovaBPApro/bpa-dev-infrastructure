#!/usr/bin/env bash
# Regression locks for the fleet watchdog, ported from v2-deprecated and adapted
# to the v3 markdown-table workboard.
set -euo pipefail

DIR=$(cd "$(dirname "$0")" && pwd)
# Overridable so the hysteresis locks below can be replayed against a PRE-change
# copy of the watchdog and shown to fail. Red-before evidence that cannot be
# re-executed by the next reader is a claim, not evidence.
SCRIPT=${FLEET_NUDGE_TEST_SCRIPT:-$DIR/fleet-nudge.sh}
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

# V3-5.10. The cap and the ruling id are read out of instance/params.yaml by a
# second awk program, in fleet-params.sh, on this watchdog's path AND on the lane
# launcher's. It is replayed under mawk for the same reason the board parser is:
# an awk-specific parse here does not make the fleet noisy, it makes the launcher
# refuse every lane on a rebuilt host.
params_reader_locks() {
  local fixture="$TMP/params-reader"
  mkdir -p "$fixture/instance"
  printf 'operator:\n  name: Vova\n\nfleet:\n  cap: 4   # trailing comment\n  declared_by: HR-4711\n  status: active\n\norchestrator:\n  session: s\n' \
    >"$fixture/instance/params.yaml"
  # shellcheck source=orchestrator/fleet/fleet-params.sh
  . "$DIR/fleet-params.sh"
  [ "$(fleet_cap "$fixture")" = 4 ] ||
    fail "${AWK_LABEL:-awk}: fleet_cap did not read the cap past its trailing comment"
  [ "$(fleet_declared_by "$fixture")" = HR-4711 ] ||
    fail "${AWK_LABEL:-awk}: fleet_declared_by did not read the ruling id"
  # A key of the same name outside the fleet block is not the fleet's key.
  printf 'other:\n  cap: 9\n\nfleet:\n  status: active\n' >"$fixture/instance/params.yaml"
  if fleet_cap "$fixture" >/dev/null; then
    fail "${AWK_LABEL:-awk}: fleet_cap read a cap from outside the fleet block"
  fi
  # A malformed cap is an absent one: the launcher refuses rather than guessing.
  printf 'fleet:\n  cap: soon\n  status: active\n' >"$fixture/instance/params.yaml"
  if fleet_cap "$fixture" >/dev/null; then
    fail "${AWK_LABEL:-awk}: fleet_cap accepted a non-numeric cap"
  fi

  # A leading zero is digits, and used to pass — then the launcher's
  # `((running >= cap))` read it as octal and FAILED OPEN at twelve lanes
  # running. The launcher-level proof is in launch-lane-cap.test.sh; this is the
  # reader's half, replayed under mawk with the rest.
  for bad_cap in 09 010 03 00 0; do
    printf 'fleet:\n  cap: %s\n  status: active\n' "$bad_cap" >"$fixture/instance/params.yaml"
    if fleet_cap "$fixture" >/dev/null; then
      fail "${AWK_LABEL:-awk}: fleet_cap accepted a leading-zero cap of $bad_cap"
    fi
  done

  # A comment in column 1 is a comment, not the end of the block. The old
  # terminator `/^[^ \t]/` matched a `#`, and because an unreadable cap is a
  # refusal evaluated BEFORE --allow-over-cap, that truncation stopped every
  # dispatch in the fleet with no override.
  printf 'fleet:\n# a comment reflowed to column 1\n  cap: 4\n  declared_by: HR-4711\n\nother:\n  cap: 9\n' \
    >"$fixture/instance/params.yaml"
  [ "$(fleet_cap "$fixture")" = 4 ] ||
    fail "${AWK_LABEL:-awk}: a column-1 comment inside the fleet block made the cap unreadable"
  [ "$(fleet_declared_by "$fixture")" = HR-4711 ] ||
    fail "${AWK_LABEL:-awk}: a column-1 comment inside the fleet block hid declared_by"

  # ...and the block still ENDS at the next real top-level key, so the comment
  # rule did not buy F4 by making the reader read the whole file.
  printf 'fleet:\n  status: active\n\n# a comment between blocks\nother:\n  cap: 9\n' \
    >"$fixture/instance/params.yaml"
  if fleet_cap "$fixture" >/dev/null; then
    fail "${AWK_LABEL:-awk}: skipping comments let the reader run past the end of the fleet block"
  fi

  # Depth. A `cap:` nested under any subkey of `fleet:` is a different parameter
  # wearing the same name; the reader used to answer with it.
  printf 'fleet:\n  budget:\n    cap: 99\n  status: active\n' >"$fixture/instance/params.yaml"
  if fleet_cap "$fixture" >/dev/null; then
    fail "${AWK_LABEL:-awk}: fleet_cap answered with a cap nested under a fleet subkey"
  fi
  # The block's own key is still found when a nested one sits above it.
  printf 'fleet:\n  budget:\n    cap: 99\n  cap: 4\n  status: active\n' >"$fixture/instance/params.yaml"
  [ "$(fleet_cap "$fixture")" = 4 ] ||
    fail "${AWK_LABEL:-awk}: the depth rule hid the fleet block's own cap"

  # A quoted scalar is valid YAML, and refusing it was a total dispatch refusal.
  for quoted in '"3"' "'3'"; do
    printf 'fleet:\n  cap: %s\n  declared_by: "HR-4711"\n' "$quoted" >"$fixture/instance/params.yaml"
    [ "$(fleet_cap "$fixture")" = 3 ] ||
      fail "${AWK_LABEL:-awk}: fleet_cap refused the quoted scalar $quoted"
    [ "$(fleet_declared_by "$fixture")" = HR-4711 ] ||
      fail "${AWK_LABEL:-awk}: fleet_declared_by refused a quoted ruling id"
  done
  # An empty quoted scalar is an absent value, not an empty cap.
  printf 'fleet:\n  cap: ""\n  status: active\n' >"$fixture/instance/params.yaml"
  if fleet_cap "$fixture" >/dev/null; then
    fail "${AWK_LABEL:-awk}: fleet_cap read an empty quoted scalar as a cap"
  fi
}
params_reader_locks

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

# ── The census, against systemd's actual line shape ─────────────────────────
# `fleet_running_lanes` is the number the launcher REFUSES against, so an
# undercount here is the fail-open direction: lanes that exist but are not seen.
# The pattern was `^[ \t]*lane-`, where a BRE `[ \t]` is the literal set
# {space, backslash, t} and not a tab — so systemd's `●` marker column, which it
# prefixes to a unit that is not happy, made that unit invisible to the cap. No
# awk on this path, so it is proven once rather than replayed.
census_locks() {
  local shim="$TMP/census-bin" count
  mkdir -p "$shim"
  cat >"$shim/systemctl" <<'EOF'
#!/usr/bin/env bash
[[ "${1:-}" == list-units ]] || exit 0
printf '  lane-plain.service loaded active running Ordinary lane\n'
printf '\xe2\x97\x8f lane-bulleted.service loaded active running A lane systemd marked\n'
printf '\tlane-tabbed.service loaded active running A tab in the marker column\n'
printf '  daemon-other.service loaded active running Not a lane\n'
printf '  watchdog.service loaded active running Mentions lane-ghost.service in its text\n'
EOF
  chmod +x "$shim/systemctl"
  count=$(PATH="$shim:$PATH" fleet_running_lanes) ||
    fail "the census failed against a well-formed systemctl listing"
  [ "$count" = 3 ] ||
    fail "the census counted $count of the 3 lane units listed (bulleted and tabbed lines must count, descriptions must not)"

  # An empty listing is still a census: zero, not a failure.
  cat >"$shim/systemctl" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  chmod +x "$shim/systemctl"
  count=$(PATH="$shim:$PATH" fleet_running_lanes) ||
    fail "an empty lane listing was reported as an untakeable census"
  [ "$count" = 0 ] || fail "an empty lane listing counted $count"

  # A census that cannot be taken is a failure, never a zero — the launcher
  # turns this into a refusal and the watchdog into a nudge, deliberately.
  cat >"$shim/systemctl" <<'EOF'
#!/usr/bin/env bash
printf 'Failed to list units: connection refused\n' >&2
exit 1
EOF
  chmod +x "$shim/systemctl"
  if PATH="$shim:$PATH" fleet_running_lanes >/dev/null; then
    fail "a failed census reported a number instead of failing"
  fi
}
# shellcheck source=orchestrator/fleet/fleet-params.sh
. "$DIR/fleet-params.sh"
census_locks

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

# The watchdog's timer period, and the unit of simulated time below. Read from
# the tracked unit rather than written here: the script's dwell defaults are
# derived from this number, and a suite that hard-coded its own copy would keep
# passing after someone changed the timer and left the dwells behind.
PERIOD=$(sed -n 's/^OnUnitActiveSec=\([0-9]*\)min$/\1/p' "$REPO/bootstrap/units/orch-fleet-nudge.timer.in")
[ -n "$PERIOD" ] || fail "cannot read OnUnitActiveSec from the tracked timer unit"
PERIOD=$((PERIOD * 60))

# Simulated wall clock. The dwells are measured in seconds, so a suite that fired
# 36 times in the same millisecond would prove nothing about a night — and
# sleeping through a real one is not an option. FLEET_NUDGE_NOW exists for this.
SIM_NOW=1000000000
tick() { SIM_NOW=$((SIM_NOW + ${1:-$PERIOD})); }

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
  FLEET_NUDGE_NOW="$SIM_NOW" \
  FLEET_NUDGE_TEST_NOTIFY_LOG="$TMP/notify.log" \
  FLEET_NUDGE_TEST_TMUX_LOG="$TMP/tmux.log" \
  "$SCRIPT"
}

# A fresh episode: no alert state, no history, clock back at the start. Every
# count below starts here, so a number in this file is always "messages caused by
# THIS scenario".
reset_state() {
  rm -rf "$TMP/runtime"
  : >"$TMP/notify.log"
  : >"$TMP/tmux.log"
  SIM_NOW=1000000000
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
    tick
  done
}

board "$TMP/valid.md" '| V3-1 | row | acc | **open** |' '| V3-2 | row | acc | **done** |'
board "$TMP/empty.md" '| V3-1 | row | acc | **done** |'

# Plumbing smoke check: the timer path reaches both process boundaries. The dwell
# is collapsed because this asserts that a message CAN be delivered at all, not
# when — an idle fleet's first sample is now deliberately silent.
reset_state
FLEET_NUDGE_IDLE_SUSTAIN=0 run_watchdog "$TMP/valid.md"
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
test "$(pastes)" -eq "$NIGHT" ||
  fail "the orchestrator was woken $(pastes) times over $NIGHT firings, expected $NIGHT"
# A fleet genuinely stuck at zero all night is told, and told again on a doubling
# interval — bounded, but never silent. The exact count is asserted by the
# backoff lock further down; here the point is only that it is neither the
# 36-message storm nor the single 02:00 message that leaves the rest of the night
# unwatched.
night_msgs=$(notifies)
test "$night_msgs" -gt 1 ||
  fail "a fleet stuck idle all night sent $night_msgs messages — silent after the first is a fleet nobody is watching"
test "$night_msgs" -le 6 ||
  fail "a fleet stuck idle all night sent $night_msgs messages over $NIGHT firings — that is the flood again"
# Recovery: one busy tick is NOT recovery (the dwell), two consecutive ones are.
FLEET_NUDGE_TEST_LANES=3 run_watchdog "$TMP/valid.md"
test "$(notifies)" -eq "$night_msgs" ||
  fail "a single busy tick ended the episode; the clear must wait out the busy dwell"
tick
FLEET_NUDGE_TEST_LANES=3 run_watchdog "$TMP/valid.md"
test "$(notifies)" -eq "$((night_msgs + 1))" ||
  fail "a fleet back at work did not clear the idle alert exactly once"
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
#
# FLEET_NUDGE_IDLE_SUSTAIN=0 here and in the blocks below: these locks are about
# delivery, the cap, and the knobs — not about the dwell. Collapsing the dwell
# keeps each one testing the single thing it was written to test, and the dwell
# has its own locks at the end of this file.
reset_state
set +e
FLEET_NUDGE_IDLE_SUSTAIN=0 FLEET_NUDGE_TEST_NOTIFY_FAIL=1 run_watchdog "$TMP/valid.md" >"$TMP/out" 2>"$TMP/err"
status=$?
set -e
test "$status" -eq 3 || fail "notification failure exited $status, expected 3"
grep -q 'operator notification failed' "$TMP/err"
test ! -e "$TMP/runtime/fleet-nudge-idle.alerted" ||
  fail "an undelivered alert still marked the operator as told"
test "$(pastes)" -eq 0 || fail "orchestrator was nudged after operator notification failed"
FLEET_NUDGE_IDLE_SUSTAIN=0 run_watchdog "$TMP/valid.md"
test "$(notifies)" -eq 2 || fail "the retry after a failed delivery did not reach the operator"

# ── B3: the cap is a ceiling, not a floor ───────────────────────────────────
# HR-2342: "Three is a ceiling, not a target: fewer is allowed whenever the work
# does not need them." One and two running lanes are therefore ALLOWED, not a
# fault, and the watchdog must be completely silent at both — the shipped
# version nudged the orchestrator every ten minutes at either count and paged the
# operator every ten minutes at zero.
for lanes in 0 1 2 3; do
  reset_state
  FLEET_NUDGE_IDLE_SUSTAIN=0 FLEET_NUDGE_TEST_LANES=$lanes run_watchdog "$TMP/valid.md"
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
  FLEET_NUDGE_IDLE_SUSTAIN=0 FLEET_NUDGE_CRITICAL="$critical" run_watchdog "$TMP/valid.md"
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
FLEET_NUDGE_IDLE_SUSTAIN=0 run_watchdog "$TMP/valid.md"
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

# V3-5.10. The number and the ruling id in that sentence were both literals in
# this file, hand-retyped at each cap change — and the comment block beside them
# was already saying "five" against a parameter of three when nobody noticed.
# Both are now read from the repository's instance/params.yaml, so a fixture
# repository stating different values must produce a different sentence with no
# edit here.
reset_state
mkdir -p "$TMP/other-repo/instance"
printf 'fleet:\n  cap: 9\n  declared_by: HR-4711\n  status: active\n' >"$TMP/other-repo/instance/params.yaml"
FLEET_NUDGE_REPO="$TMP/other-repo" run_watchdog "$TMP/valid.md"
grep -Fq 'HR-4711 caps parallel lanes at 9 — a ceiling, not a target' "$TMP/tmux.log" ||
  { cat "$TMP/tmux.log" >&2; fail "the wake-up did not read the cap and its ruling from instance/params.yaml"; }

# Half a citation is not a citation. With no ruling to quote, the sentence is
# dropped rather than sent with an invented or stale id.
reset_state
printf 'fleet:\n  cap: 9\n  status: active\n' >"$TMP/other-repo/instance/params.yaml"
FLEET_NUDGE_REPO="$TMP/other-repo" run_watchdog "$TMP/valid.md"
if grep -Fq 'caps parallel lanes' "$TMP/tmux.log"; then
  cat "$TMP/tmux.log" >&2
  fail "the wake-up quoted a cap with no ruling behind it"
fi
grep -Fq '[fleet-nudge] running lanes=' "$TMP/tmux.log" ||
  fail "dropping the ceiling sentence also dropped the wake-up"

# An unreadable parameter file invents no ceiling either.
reset_state
FLEET_NUDGE_REPO="$TMP/no-such-repo" run_watchdog "$TMP/valid.md"
if grep -Fq 'caps parallel lanes' "$TMP/tmux.log"; then
  cat "$TMP/tmux.log" >&2
  fail "the wake-up quoted a cap it could not read"
fi

# A parse error is operator-loud and remains a failed service invocation.
reset_state
set +e
run_watchdog "$TMP/lowercase.md" >"$TMP/out" 2>"$TMP/err"
status=$?
set -e
test "$status" -eq 2 || fail "malformed runtime board exited $status, expected 2"
grep -q '/notify' "$TMP/notify.log"
grep -q 'refusing to run with an unparseable workboard' "$TMP/err"

# ── V3-5.9: the alert flood that wakes him ──────────────────────────────────
# The dedup above is per EPISODE and the episode used to end the instant a lane
# appeared, so a fleet oscillating around zero paid two messages per cycle — the
# raise and its clear. Every lock in this block fails against the pre-change
# watchdog; replay it with FLEET_NUDGE_TEST_SCRIPT=<old copy> to see that.

BASE=1000000000

# Fire `$2` ticks against board `$1` and print the elapsed time at which each new
# operator message appeared. Times, not just a count: "five messages" and "five
# messages spread ever wider apart" are different claims and only the second is
# the design.
stall_message_times() { # board ticks
  local i before after
  for ((i = 0; i < $2; i++)); do
    before=$(notifies)
    run_watchdog "$1" >/dev/null 2>&1 || true
    after=$(notifies)
    [ "$after" -gt "$before" ] && printf '%s\n' "$((SIM_NOW - BASE))"
    tick
  done
  return 0
}

# 1. THE FLOOD. A fleet cycling zero → one → zero → one, which is what his
#    screenshot actually showed: not a threshold set wrong, a fleet handing over
#    between lanes. The pre-change watchdog raised on every drop and cleared on
#    every start, so this sequence alone cost 2 messages per cycle.
reset_state
oscillate() { # board cycles
  local i
  for ((i = 0; i < $2; i++)); do
    FLEET_NUDGE_TEST_LANES=0 run_watchdog "$1" >/dev/null 2>&1 || true
    tick
    FLEET_NUDGE_TEST_LANES=1 run_watchdog "$1" >/dev/null 2>&1 || true
    tick
  done
  return 0
}
oscillate "$TMP/valid.md" $((NIGHT / 2))
test "$(notifies)" -eq 0 ||
  fail "an oscillating fleet sent $(notifies) messages over $NIGHT firings — the flood is still there"
# It is silent because the fleet is WORKING, not because it was gagged: the
# orchestrator was still woken on every idle tick.
test "$(pastes)" -eq "$((NIGHT / 2))" ||
  fail "an oscillating fleet woke the orchestrator $(pastes) times, expected $((NIGHT / 2))"

# 2. THE ALERT IS STILL REACHABLE. The same oscillating fleet, then a real stall.
#    Suppression that cannot be escaped is worse than the flood, so this is the
#    lock that matters most in this block.
reset_state
oscillate "$TMP/valid.md" 4
test "$(notifies)" -eq 0 || fail "the oscillation preamble already sent a message"
stall_message_times "$TMP/valid.md" 4 >"$TMP/reach"
test "$(notifies)" -ge 1 ||
  fail "a fleet that oscillated and then genuinely stalled never reached the operator — that is the suppression trap"
grep -Fq "$(esc 'Флот простоює')" "$TMP/notify.log" ||
  fail "the stall after an oscillation reported something other than an idle fleet"

# 3. A STUCK FLEET ESCALATES ONCE, THEN BACKS OFF. Not once per firing (the
#    flood), and not once and then never again (the silence).
reset_state
stall_message_times "$TMP/valid.md" "$NIGHT" >"$TMP/stall"
stall_n=$(wc -l <"$TMP/stall" | tr -d ' ')
# The first escalation is a single message, not one per tick: over the first hour
# of a stall he is told exactly once.
first_hour=$(awk -v p="$PERIOD" '$1 <= 6 * p' "$TMP/stall" | wc -l | tr -d ' ')
test "$first_hour" -eq 1 ||
  fail "a stuck fleet sent $first_hour messages in its first hour, expected exactly 1"
# The first one waits out the dwell rather than firing on the first idle sample.
test "$(head -1 "$TMP/stall")" -eq "$PERIOD" ||
  fail "the first escalation came at $(head -1 "$TMP/stall")s, expected one dwell ($PERIOD s)"
# And the gaps double, so the count grows with the logarithm of the stall.
awk -v n="$stall_n" '
  { t[NR] = $1 }
  END {
    if (n < 3) { print "too few messages to prove a backoff: " n > "/dev/stderr"; exit 1 }
    for (i = 3; i <= n; i++) {
      prev = t[i - 1] - t[i - 2]; cur = t[i] - t[i - 1]
      if (cur < prev * 2) {
        printf "gap %d (%ds) did not at least double the previous (%ds)\n", i, cur, prev > "/dev/stderr"
        exit 1
      }
    }
  }' "$TMP/stall" || fail "the stuck-fleet escalation does not back off"

# 4. A LONG STALL NEVER FALLS SILENT. A full week at zero lanes: the operator is
#    still being told, and the doubling keeps the total tiny.
reset_state
stall_message_times "$TMP/valid.md" $((7 * 24 * 6)) >"$TMP/week"
week_n=$(wc -l <"$TMP/week" | tr -d ' ')
test "$week_n" -gt "$stall_n" ||
  fail "a week-long stall sent no more messages than a six-hour one — the alert went silent"
test "$week_n" -le 12 ||
  fail "a week-long stall sent $week_n messages; the backoff is not bounding anything"
# The last message lands in the final third of the week, not all of them on the
# first evening: "still stuck" must remain a live signal, not an archive entry.
last_msg=$(tail -1 "$TMP/week")
test "$last_msg" -gt $((7 * 24 * 3600 / 3)) ||
  fail "the last message of a week-long stall came at ${last_msg}s — it fell silent for the rest of the week"

# 5. THE BUSY DWELL. One lane appearing for a single tick is a handover, not a
#    recovery: it must neither clear the episode nor let the next drop to zero
#    read as new. Half of the real idle episodes in the timer's log were exactly
#    one tick long, which is where the derivation of this dwell comes from.
reset_state
stall_message_times "$TMP/valid.md" 3 >/dev/null
raised=$(notifies)
test "$raised" -ge 1 || fail "the stall preamble never alerted"
FLEET_NUDGE_TEST_LANES=1 run_watchdog "$TMP/valid.md"   # one busy tick
tick
test "$(notifies)" -eq "$raised" || fail "a single busy tick cleared the episode"
test -e "$TMP/runtime/fleet-nudge-idle.alerted" ||
  fail "a single busy tick removed the episode marker, so the next zero re-raises"

# 6. THE DWELL DEFAULT FOLLOWS THE TRACKED TIMER. The dwell is derived from the
#    timer period; if someone retimes the unit and leaves the script behind, the
#    number stops meaning what its comment says it means.
reset_state
FLEET_NUDGE_TEST_LANES=0 run_watchdog "$TMP/valid.md"   # opens the idle run at t=0
tick $((PERIOD - 60))
FLEET_NUDGE_TEST_LANES=0 run_watchdog "$TMP/valid.md"
test "$(notifies)" -eq 0 ||
  fail "the operator was told $((PERIOD - 60))s into a stall; the dwell is shorter than the timer period"
tick 60
FLEET_NUDGE_TEST_LANES=0 run_watchdog "$TMP/valid.md"
test "$(notifies)" -eq 1 ||
  fail "a stall of one full timer period ($PERIOD s) did not reach the operator; the dwell is longer than the timer period"

# 7. A LEGACY EPISODE FILE MUST NOT WEDGE. The live host has a zero-byte
#    fleet-nudge-idle.alerted written by the pre-change watchdog. It carries no
#    timestamp, so the backoff cannot be computed from it — the migration must
#    fail toward speaking, never toward silence.
reset_state
mkdir -p "$TMP/runtime"
: >"$TMP/runtime/fleet-nudge-idle.alerted"
# The dwell is collapsed because this lock is about the unreadable state file,
# not about the wait — with the dwell in force the first firing would be silent
# for the ordinary reason and prove nothing about the legacy file.
FLEET_NUDGE_IDLE_SUSTAIN=0 FLEET_NUDGE_TEST_LANES=0 run_watchdog "$TMP/valid.md"
test "$(notifies)" -eq 1 ||
  fail "a legacy zero-byte episode file swallowed the alert instead of re-announcing it"

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
