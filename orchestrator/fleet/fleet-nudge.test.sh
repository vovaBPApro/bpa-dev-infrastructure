#!/usr/bin/env bash
# Regression locks for the fleet watchdog, ported from v2-deprecated and adapted
# to the v3 markdown-table workboard.
set -euo pipefail

SCRIPT=$(cd "$(dirname "$0")" && pwd)/fleet-nudge.sh
REPO=$(cd "$(dirname "$0")/../.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

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
    if (id ~ /^:?-{2,}:?$/) next
    if (t) n++ }
  END { print n + 0 }' "$real")
[ "$real_open" -lt "$real_rows" ] ||
  fail "every one of the $real_rows real rows counted open — the classifier is not discriminating"

# ── Deployed-copy drift ─────────────────────────────────────────────────────
# The tracked-to-deployed check must detect drift, not merely locate both files.
cp "$SCRIPT" "$TMP/deployed.sh"
"$SCRIPT" --verify-deployed "$TMP/deployed.sh"
printf '\n# stale deployed copy\n' >>"$TMP/deployed.sh"
if "$SCRIPT" --verify-deployed "$TMP/deployed.sh" >"$TMP/out" 2>"$TMP/err"; then
  fail "deployed drift was accepted"
fi
grep -q 'deployed script differs from tracked script' "$TMP/err"
# The 2026-08-04 condition: a hand-edited host copy, shorter than the tracked one.
head -n 20 "$SCRIPT" >"$TMP/handedited.sh"
if "$SCRIPT" --verify-deployed "$TMP/handedited.sh" >"$TMP/out" 2>"$TMP/err"; then
  fail "a truncated hand-edited deployed copy was accepted"
fi
# An absent deployed copy is drift too, not a pass.
if "$SCRIPT" --verify-deployed "$TMP/does-not-exist.sh" >"$TMP/out" 2>"$TMP/err"; then
  fail "a missing deployed copy was accepted"
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
exit 0
EOF
cat >"$TMP/bin/curl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$FLEET_NUDGE_TEST_NOTIFY_LOG"
if [ "${FLEET_NUDGE_TEST_NOTIFY_FAIL:-0}" = 1 ]; then exit 22; fi
exit 0
EOF
chmod +x "$TMP/bin/systemctl" "$TMP/bin/tmux" "$TMP/bin/curl"

run_watchdog() {
  PATH="$TMP/bin:$PATH" \
  FLEET_NUDGE_BOARD="$1" \
  FLEET_NUDGE_HEARTBEAT="$TMP/runtime/heartbeat" \
  FLEET_NUDGE_LOGFILE="$TMP/fleet.log" \
  FLEET_NUDGE_TEST_NOTIFY_LOG="$TMP/notify.log" \
  FLEET_NUDGE_TEST_TMUX_LOG="$TMP/tmux.log" \
  "$SCRIPT"
}

board "$TMP/valid.md" '| V3-1 | row | acc | **open** |' '| V3-2 | row | acc | **done** |'

: >"$TMP/notify.log"
: >"$TMP/tmux.log"
run_watchdog "$TMP/valid.md"
grep -q '/notify' "$TMP/notify.log"
grep -q 'has-session' "$TMP/tmux.log"
grep -q 'paste-buffer' "$TMP/tmux.log"

# HR-2342 caps parallel lanes at three, so three is the default floor. At or
# above it the watchdog stays quiet; below it, the operator-facing string quotes
# the floor rather than a second, driftable literal.
grep -Fq "$(esc 'потрібно 3')" "$TMP/notify.log" ||
  fail "the sub-floor warning does not quote the default floor of 3"
if grep -Fq "$(esc 'потрібно 10')" "$TMP/notify.log"; then
  fail "the sub-floor warning still hardcodes the pre-HR-2342 floor of 10"
fi

: >"$TMP/notify.log"
: >"$TMP/tmux.log"
FLEET_NUDGE_TEST_LANES=3 run_watchdog "$TMP/valid.md"
if [ -s "$TMP/notify.log" ] || [ -s "$TMP/tmux.log" ]; then
  fail "the watchdog fired at the floor of 3 running lanes"
fi

# Raising the floor moves BOTH numbers together: the nudge fires again and the
# string follows the knob.
: >"$TMP/notify.log"
: >"$TMP/tmux.log"
FLEET_NUDGE_TEST_LANES=0 FLEET_NUDGE_FLOOR=10 run_watchdog "$TMP/valid.md"
grep -Fq "$(esc 'потрібно 10')" "$TMP/notify.log" ||
  fail "the sub-floor warning did not follow FLEET_NUDGE_FLOOR"

# An empty board is the one case that legitimately asks the Human what is next.
: >"$TMP/notify.log"
: >"$TMP/tmux.log"
board "$TMP/empty.md" '| V3-1 | row | acc | **done** |'
run_watchdog "$TMP/empty.md"
grep -Fq "$(esc 'Роботи для флоту не лишилось')" "$TMP/notify.log" ||
  fail "an empty board did not ask the Human what comes next"
if grep -q 'paste-buffer' "$TMP/tmux.log"; then
  fail "the orchestrator was nudged with no work left"
fi

# A parse error is operator-loud and remains a failed service invocation.
: >"$TMP/notify.log"
set +e
run_watchdog "$TMP/lowercase.md" >"$TMP/out" 2>"$TMP/err"
status=$?
set -e
test "$status" -eq 2 || fail "malformed runtime board exited $status, expected 2"
grep -q '/notify' "$TMP/notify.log"
grep -q 'refusing to run with an unparseable workboard' "$TMP/err"

# Notification delivery failure is loud and prevents a false-success nudge.
: >"$TMP/notify.log"
: >"$TMP/tmux.log"
set +e
FLEET_NUDGE_TEST_NOTIFY_FAIL=1 run_watchdog "$TMP/valid.md" >"$TMP/out" 2>"$TMP/err"
status=$?
set -e
test "$status" -eq 3 || fail "notification failure exited $status, expected 3"
grep -q 'operator notification failed' "$TMP/err"
if grep -q 'paste-buffer' "$TMP/tmux.log"; then
  fail "orchestrator was nudged after operator notification failed"
fi

printf 'fleet-nudge watchdog regression locks: PASS (real workboard open rows=%s of %s)\n' \
  "$real_open" "$real_rows"
