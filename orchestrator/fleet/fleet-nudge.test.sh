#!/usr/bin/env bash
set -euo pipefail

SCRIPT=$(cd "$(dirname "$0")" && pwd)/fleet-nudge.sh
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

cat >"$TMP/valid.md" <<'EOF'
# Workboard
- <!-- status: open --> **W-1 — first**
- <!-- status: done --> **ML-2 — second** — landed at `deadbee`.
- <!-- status: blocked --> **NI-3 — third**
- <!-- status: superseded --> **PR-4 — fourth**
- <!-- status: open --> **ML-GOV — fifth**
EOF

test "$("$SCRIPT" --count-open "$TMP/valid.md")" = 2

cat >"$TMP/missing.md" <<'EOF'
- **W-1 — missing status**
EOF
if "$SCRIPT" --count-open "$TMP/missing.md" >"$TMP/out" 2>"$TMP/err"; then
  echo "FAIL: missing status was accepted" >&2
  exit 1
fi
grep -q 'malformed workboard row' "$TMP/err"

cat >"$TMP/invalid.md" <<'EOF'
- <!-- status: finished --> **W-1 — invalid status**
EOF
if "$SCRIPT" --count-open "$TMP/invalid.md" >"$TMP/out" 2>"$TMP/err"; then
  echo "FAIL: invalid status was accepted" >&2
  exit 1
fi
grep -q 'malformed workboard row' "$TMP/err"

cat >"$TMP/lowercase.md" <<'EOF'
- <!-- status: open --> **W-1 — valid**
- <!-- status: open --> **w-2 — malformed lowercase id**
EOF
if "$SCRIPT" --count-open "$TMP/lowercase.md" >"$TMP/out" 2>"$TMP/err"; then
  echo "FAIL: lowercase id silently reduced the count" >&2
  exit 1
fi
grep -q 'malformed workboard row at line 2' "$TMP/err"

cat >"$TMP/duplicate.md" <<'EOF'
- <!-- status: open --> **W-1 — first**
- <!-- status: done --> **W-1 — duplicate**
EOF
if "$SCRIPT" --count-open "$TMP/duplicate.md" >"$TMP/out" 2>"$TMP/err"; then
  echo "FAIL: duplicate id was accepted" >&2
  exit 1
fi
grep -q 'duplicate workboard id' "$TMP/err"

# The tracked-to-deployed check must detect drift, not merely locate both files.
cp "$SCRIPT" "$TMP/deployed.sh"
"$SCRIPT" --verify-deployed "$TMP/deployed.sh"
printf '\n# stale deployed copy\n' >>"$TMP/deployed.sh"
if "$SCRIPT" --verify-deployed "$TMP/deployed.sh" >"$TMP/out" 2>"$TMP/err"; then
  echo "FAIL: deployed drift was accepted" >&2
  exit 1
fi
grep -q 'deployed script differs from tracked script' "$TMP/err"

# Exercise the timer path through mocked process boundaries. This locks HR-281:
# below three lanes must notify the operator before nudging the orchestrator.
mkdir "$TMP/bin"
cat >"$TMP/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
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
  FLEET_NUDGE_LOGFILE="$TMP/fleet.log" \
  FLEET_NUDGE_TEST_NOTIFY_LOG="$TMP/notify.log" \
  FLEET_NUDGE_TEST_TMUX_LOG="$TMP/tmux.log" \
  "$SCRIPT"
}

: >"$TMP/notify.log"
: >"$TMP/tmux.log"
run_watchdog "$TMP/valid.md"
grep -q '/notify' "$TMP/notify.log"
grep -q 'has-session' "$TMP/tmux.log"
grep -q 'paste-buffer' "$TMP/tmux.log"

# A parse error is operator-loud and remains a failed service invocation.
: >"$TMP/notify.log"
set +e
run_watchdog "$TMP/lowercase.md" >"$TMP/out" 2>"$TMP/err"
status=$?
set -e
if [ "$status" -eq 0 ]; then
  echo "FAIL: malformed runtime board exited zero" >&2
  exit 1
fi
test "$status" -eq 2
grep -q '/notify' "$TMP/notify.log"
grep -q 'refusing to run with an unparseable workboard' "$TMP/err"

# Notification delivery failure is loud and prevents a false-success nudge.
: >"$TMP/notify.log"
: >"$TMP/tmux.log"
set +e
FLEET_NUDGE_TEST_NOTIFY_FAIL=1 run_watchdog "$TMP/valid.md" >"$TMP/out" 2>"$TMP/err"
status=$?
set -e
if [ "$status" -eq 0 ]; then
  echo "FAIL: notification failure was swallowed" >&2
  exit 1
fi
test "$status" -eq 3
grep -q 'operator notification failed' "$TMP/err"
if grep -q 'paste-buffer' "$TMP/tmux.log"; then
  echo "FAIL: orchestrator was nudged after operator notification failed" >&2
  exit 1
fi

printf 'fleet-nudge watchdog regression locks: PASS\n'
