#!/usr/bin/env bash
# Regression lock: watchdog and full-suite must not lose concurrent nudges.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT
BIN="$SCRATCH/bin"
OUTBOX="$SCRATCH/nudges.outbox"
BARRIER="$SCRATCH/barrier"
mkdir -p "$BIN" "$BARRIER"
printf 'existing nudge\n' > "$OUTBOX"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

cat > "$BIN/cat" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
/bin/cat "$@"
if [[ "${1:-}" == "$OUTBOX_TEST_FILE" ]]; then
  marker="$OUTBOX_TEST_BARRIER/reader.$$"
  : > "$marker"
  deadline=$((SECONDS + 1))
  while [[ "$(find "$OUTBOX_TEST_BARRIER" -name 'reader.*' -type f | wc -l)" -lt 2 ]]; do
    (( SECONDS < deadline )) || break
  done
fi
EOF
cat > "$BIN/df" <<'EOF'
#!/usr/bin/env bash
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n'
printf 'fixture 100 91 9 91%% /\n'
EOF
cat > "$BIN/tmux" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  has-session) exit 0 ;;
  list-panes) ps -o ppid= -p "$PPID" | tr -d ' ' ;;
  *) exit 0 ;;
esac
EOF
chmod +x "$BIN/cat" "$BIN/df" "$BIN/tmux"

SUITE_ROOT="$SCRATCH/suites"
mkdir -p "$SUITE_ROOT"
printf '%s\n' '#!/usr/bin/env bash' 'exit 7' > "$SUITE_ROOT/red.test.sh"
chmod +x "$SUITE_ROOT/red.test.sh"

COMMON_ENV=(
  "PATH=$BIN:$PATH"
  "ORCH_CONFIG_FILE=$SCRATCH/no-config"
  "ORCH_RUNTIME_DIR=$SCRATCH/runtime"
  "NUDGE_OUTBOX_FILE=$OUTBOX"
  "OUTBOX_TEST_FILE=$OUTBOX"
  "OUTBOX_TEST_BARRIER=$BARRIER"
)

env "${COMMON_ENV[@]}" ORCH_STATE_DB="$SCRATCH/missing.db" \
  ORCH_WATCHDOG_LOG="$SCRATCH/runtime/watchdog.log" ORCH_INSTALL_ROOT="$SCRATCH" \
  DISK_ALERT_PCT=80 FLEET_NUDGE_REPEAT_MS=1 \
  "$SCRIPT_DIR/watchdog.sh" &
watchdog_pid=$!

env "${COMMON_ENV[@]}" ORCH_INSTALL_ROOT="$SUITE_ROOT" \
  FULL_SUITE_LOG="$SCRATCH/runtime/full-suite.log" FULL_SUITE_NUDGE_REPEAT_MS=1 \
  "$SCRIPT_DIR/full-suite.sh" &
suite_pid=$!

watchdog_rc=0
suite_rc=0
wait "$watchdog_pid" || watchdog_rc=$?
wait "$suite_pid" || suite_rc=$?
[[ "$watchdog_rc" == 0 ]] || fail "watchdog exited $watchdog_rc"
[[ "$suite_rc" == 1 ]] || fail "full-suite exited $suite_rc instead of expected red-suite status 1"

[[ "$(grep -c '^NUDGE disk-pressure ' "$OUTBOX" || true)" == 1 ]] \
  || fail 'watchdog nudge missing or duplicated'
[[ "$(grep -c '^NUDGE full-suite ' "$OUTBOX" || true)" == 1 ]] \
  || fail 'full-suite nudge missing or duplicated'
[[ "$(grep -c '^existing nudge$' "$OUTBOX" || true)" == 1 ]] \
  || fail 'existing outbox entry missing or duplicated'

printf 'outbox concurrency test: PASS\n'
