#!/usr/bin/env bash
# Drift lock for the orchestrator heartbeat's WRITER.
#
# The outage this exists to keep dead: launch.sh referenced
# orchestrator-turnend-relay.sh and orchestrator-claude-stop-relay.sh, neither
# existed in any commit or on any host, and a `[[ -x ]]` guard skipped both in
# silence. watchdog.sh:348-350 names the turn-end relay as the SINGLE ongoing
# writer of the heartbeat, so the heartbeat had no writer from 2026-08-04 18:13
# and aged to 41x its own threshold. Nothing fired, because the tmux
# pane-activity signal carried the whole system alone under newest-signal-wins
# — a redundancy silently absorbing the total failure of the thing it
# supplements, presenting as two signals while being one. Full write-up:
# instance/incidents/2026-08-05-the-heartbeat-has-had-no-writer-since-yesterday.md
#
# Each assertion below is written to go RED on one specific regression:
#   - deleting or untracking either relay, or dropping its executable bit
#   - unwiring either relay from its provider branch in launch.sh
#   - loosening either relay guard back to a fail-open `[[ -x ]]` test
#   - the relay ceasing to write the heartbeat, or writing it late enough that
#     a failed delivery can prevent the stamp
#   - the relay and the watchdog resolving DIFFERENT heartbeat paths
#   - the watchdog ceasing to escalate a stale heartbeat that no tmux signal
#     is masking
#
# Section 5 is the incident reproduced as a fixture in both directions: the
# masking that hid it, and the escalation that must fire without it.
#
# The kill path is fully shimmed — tmux is a recorder and launch.sh is a stub —
# so no real session, timer or unit is ever touched by this suite.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LAUNCH="$SCRIPT_DIR/launch.sh"
WATCHDOG="$SCRIPT_DIR/watchdog.sh"
TURNEND_RELATIVE="orchestrator/orchestrator-turnend-relay.sh"
STOP_RELATIVE="orchestrator/orchestrator-claude-stop-relay.sh"
TURNEND_PATH="$REPO_DIR/$TURNEND_RELATIVE"
STOP_PATH="$REPO_DIR/$STOP_RELATIVE"

SCRATCH="$(mktemp -d)"
cleanup() { rm -rf "$SCRATCH"; return 0; }
trap cleanup EXIT

failures=0
pass() { printf 'ok   %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1"; failures=$((failures + 1)); }
check() { # check <name> <condition-status> [detail]
  if (( $2 == 0 )); then pass "$1"; else fail "$1${3:+ — $3}"; fi
}

mkdir -p "$SCRATCH/runtime" "$SCRATCH/bin"
: > "$SCRATCH/no-runtime.env"

# ── 1. Both relays exist as tracked, executable files ───────────────────────
# "Tracked and executable" is Hard Floor 5 made decidable: a mechanism that
# exists only as a path some host might satisfy is not reproducible from git,
# and that is exactly the condition the incident measured.
for pair in "turn-end relay:$TURNEND_RELATIVE:$TURNEND_PATH" "Stop relay:$STOP_RELATIVE:$STOP_PATH"; do
  IFS=: read -r label relative absolute <<<"$pair"
  git -C "$REPO_DIR" ls-files --error-unmatch "$relative" >/dev/null 2>&1
  check "$label is tracked in git ls-files" $? "$relative is not in the index"

  mode="$(git -C "$REPO_DIR" ls-files --stage "$relative" 2>/dev/null | awk '{print $1}')"
  [[ "$mode" == "100755" ]]
  check "$label carries git mode 100755" $? "mode is '${mode:-<absent>}'"

  [[ -x "$absolute" ]]
  check "$label is executable on disk" $? "$absolute"
done

# ── 2. The relay writes the heartbeat, from either provider's call shape ────
# codex hands the payload as the final argv element; the claude Stop hook hands
# it on stdin. ORCH_RELAY_CLI points at a file that does not exist so delivery
# provably cannot succeed: the stamp must not depend on it.
relay_run() { # relay_run <script> <runtime-dir> [argv-payload]; stdin optional
  local script="$1" runtime="$2"
  shift 2
  RELAY_ERR_FILE="$SCRATCH/relay.err"
  env ORCH_CONFIG_FILE="$SCRATCH/no-runtime.env" \
    ORCH_RUNTIME_DIR="$runtime" \
    ORCH_RELAY_CLI="$SCRATCH/no-such-relay.ts" \
    "$script" "$@" >"$SCRATCH/relay.out" 2>"$RELAY_ERR_FILE"
  RELAY_RC=$?
  RELAY_ERR="$(cat "$RELAY_ERR_FILE")"
  return 0
}

stamp_is_fresh() { # stamp_is_fresh <heartbeat-file>
  local file="$1" stamp now age
  [[ -f "$file" ]] || return 1
  stamp="$(cat "$file" 2>/dev/null)"
  [[ "$stamp" =~ ^[0-9]+$ ]] || return 1
  now="$(date +%s)"
  age=$(( now - stamp ))
  (( age >= 0 && age <= 120 ))
}

codex_payload='{"type":"agent-turn-complete","thread-id":"t","turn-id":"1","last-assistant-message":"done"}'
claude_payload='{"session_id":"s","turn_id":"1","last_assistant_message":"done"}'

relay_run "$TURNEND_PATH" "$SCRATCH/codex-rt" "$codex_payload" </dev/null
stamp_is_fresh "$SCRATCH/codex-rt/orchestrator.heartbeat"
check "the turn-end relay stamps the heartbeat from a codex notify payload" $? \
  "rc=$RELAY_RC err=$RELAY_ERR"

printf '%s' "$claude_payload" > "$SCRATCH/claude-payload.json"
relay_run "$STOP_PATH" "$SCRATCH/claude-rt" < "$SCRATCH/claude-payload.json"
stamp_is_fresh "$SCRATCH/claude-rt/orchestrator.heartbeat"
check "the Stop relay stamps the heartbeat from a claude Stop payload on stdin" $? \
  "rc=$RELAY_RC err=$RELAY_ERR"

# A failed delivery must not cost the stamp, and must not fail the turn: the
# Stop hook runs synchronously, so failing it because the daemon is down turns
# a notification outage into a turn outage. The failure is NAMED instead.
(( RELAY_RC == 0 ))
check "a failed delivery does not fail the provider's turn" $? "rc=$RELAY_RC"
[[ "$RELAY_ERR" == *"orchestrator-turnend-relay-cli-missing"* ]]
check "a failed delivery is named on stderr, never silent" $? "err=$RELAY_ERR"

# An unparseable or empty payload is still a turn that ended. The stamp is the
# first act precisely so that no downstream validation can swallow it.
relay_run "$TURNEND_PATH" "$SCRATCH/garbage-rt" 'not json at all' </dev/null
stamp_is_fresh "$SCRATCH/garbage-rt/orchestrator.heartbeat"
check "a malformed payload still stamps the heartbeat" $? "rc=$RELAY_RC err=$RELAY_ERR"

relay_run "$TURNEND_PATH" "$SCRATCH/empty-rt" </dev/null
stamp_is_fresh "$SCRATCH/empty-rt/orchestrator.heartbeat"
check "an empty payload still stamps the heartbeat" $? "rc=$RELAY_RC err=$RELAY_ERR"
[[ "$RELAY_ERR" == *"orchestrator-turnend-relay-empty-payload"* ]]
check "an empty payload says so rather than passing quietly" $? "err=$RELAY_ERR"

# The stamp is written through a temporary file and renamed, so a concurrent
# watchdog tick reads either the old complete stamp or the new one. A leftover
# temp file would mean the rename path is not the one being taken.
leftovers="$(find "$SCRATCH/codex-rt" "$SCRATCH/claude-rt" -name '.orchestrator.heartbeat.*' 2>/dev/null | wc -l)"
[[ "$leftovers" == "0" ]]
check "the stamp leaves no temporary files behind" $? "found $leftovers"

# ── 3. The relay and the watchdog resolve the SAME heartbeat file ───────────
# A writer stamping a file no watchdog reads is the same outage with extra
# steps. Asserted behaviourally (one ORCH_RUNTIME_DIR, one resolved path) and
# at the source, so a default that drifts in either file is caught.
watchdog_default="$(grep -c 'HEARTBEAT_FILE="\${ORCH_HEARTBEAT_FILE:-\$RUNTIME_DIR/orchestrator.heartbeat}"' "$WATCHDOG")"
relay_default="$(grep -c 'HEARTBEAT_FILE="\${ORCH_HEARTBEAT_FILE:-\$RUNTIME_DIR/orchestrator.heartbeat}"' "$TURNEND_PATH")"
[[ "$watchdog_default" == "1" && "$relay_default" == "1" ]]
check "relay and watchdog spell the heartbeat default identically" $? \
  "watchdog=$watchdog_default relay=$relay_default"

# The relay must honour runtime.env the way the watchdog does — the pane
# inherits the tmux server's environment, not the launcher's, so a config file
# is the only thing that can put a non-default path in front of both.
printf 'ORCH_HEARTBEAT_FILE=%s\n' "$SCRATCH/config-directed.heartbeat" > "$SCRATCH/directed.env"
env ORCH_CONFIG_FILE="$SCRATCH/directed.env" ORCH_RUNTIME_DIR="$SCRATCH/directed-rt" \
  ORCH_RELAY_CLI="$SCRATCH/no-such-relay.ts" \
  "$TURNEND_PATH" "$codex_payload" >/dev/null 2>&1 </dev/null
stamp_is_fresh "$SCRATCH/config-directed.heartbeat"
check "the relay honours ORCH_HEARTBEAT_FILE from runtime.env" $? \
  "the pane cannot be reached any other way"

# ── 4. Both provider branches wire their relay, fail-closed ────────────────
render() { # render <provider> [env assignments...]
  local provider="$1"
  shift
  RENDER_OUT="$(env \
    ORCH_CONFIG_FILE="$SCRATCH/no-runtime.env" \
    ORCH_RUNTIME_DIR="$SCRATCH/runtime" \
    ORCH_OPS_JOURNAL="$SCRATCH/runtime/ops-journal.log" \
    ORCH_PROVIDER="$provider" \
    "$@" \
    bash "$LAUNCH" render-command 2>"$SCRATCH/render.err")"
  RENDER_RC=$?
  RENDER_ERR="$(cat "$SCRATCH/render.err")"
  return 0
}

# No ORCH_*_RELAY override here on purpose: this asserts the DEFAULT the live
# host resolves, which is the value that was dangling.
render codex
if (( RENDER_RC == 0 )) && [[ "$RENDER_OUT" == *"notify"* && "$RENDER_OUT" == *"$TURNEND_PATH"* ]]; then
  pass "codex wires the tracked turn-end relay into --config notify by default"
else
  fail "codex wires the tracked turn-end relay into --config notify by default — rc=$RENDER_RC out=$RENDER_OUT err=$RENDER_ERR"
fi

render claude
settings_file="$SCRATCH/runtime/claude-relay-settings.json"
if (( RENDER_RC == 0 )) && [[ -f "$settings_file" ]] &&
  grep -q '"Stop"' "$settings_file" && grep -qF "$STOP_PATH" "$settings_file"; then
  pass "claude wires the tracked Stop relay into its settings JSON by default"
else
  fail "claude wires the tracked Stop relay into its settings JSON by default — rc=$RENDER_RC err=$RENDER_ERR $(cat "$settings_file" 2>/dev/null)"
fi

# Fail-closed, per provider. This is the half V3-5.2 r2 had to leave open: a
# missing relay is a refusal that NAMES the path, not a silent skip.
render codex ORCH_TURNEND_RELAY="$SCRATCH/does-not-exist.sh"
if (( RENDER_RC != 0 )) && [[ "$RENDER_ERR" == *"orchestrator-turnend-relay-unavailable"* ]]; then
  pass "codex refuses when the turn-end relay is missing"
else
  fail "codex refuses when the turn-end relay is missing — rc=$RENDER_RC err=$RENDER_ERR"
fi

render claude ORCH_CLAUDE_STOP_RELAY="$SCRATCH/does-not-exist.sh"
if (( RENDER_RC != 0 )) && [[ "$RENDER_ERR" == *"orchestrator-claude-stop-relay-unavailable"* ]]; then
  pass "claude refuses when the Stop relay is missing"
else
  fail "claude refuses when the Stop relay is missing — rc=$RENDER_RC err=$RENDER_ERR"
fi

# Present-but-not-executable is the same refusal: `[[ -x ]]` conflated the two
# and skipped both.
printf '#!/usr/bin/env bash\nexit 0\n' > "$SCRATCH/not-executable.sh"
chmod -x "$SCRATCH/not-executable.sh"
render codex ORCH_TURNEND_RELAY="$SCRATCH/not-executable.sh"
if (( RENDER_RC != 0 )) && [[ "$RENDER_ERR" == *"reason=not executable"* ]]; then
  pass "a non-executable relay refuses and says why"
else
  fail "a non-executable relay refuses and says why — rc=$RENDER_RC err=$RENDER_ERR"
fi

# The source-level half: the fail-open shape must be gone, not merely bypassed.
# Anchored on `esac` rather than a closing `}` because build_command embeds a
# bun -e script whose JS puts a `}` in column 0.
body="$(awk '/^build_command\(\)/,/^  esac$/' "$LAUNCH")"
# Comment lines are stripped before counting: the citations kept at each guard
# QUOTE the `[[ -x ]]` shape they replaced, and a checker that cannot tell a
# quoted defect from a live one forces the repair to erase its own history.
code="$(printf '%s\n' "$body" | grep -v '^[[:space:]]*#' || true)"
open_guards="$(printf '%s\n' "$code" | grep -c '\[\[ -x' || true)"
[[ "$open_guards" == "0" ]]
check "build_command has no fail-open [[ -x ]] guard left" $? \
  "found $open_guards — every mechanism there routes through require_mechanism"

for kind in claude-stop-relay turnend-relay; do
  printf '%s\n' "$body" | grep -q "require_mechanism $kind"
  check "build_command resolves $kind through require_mechanism" $? \
    "the guard was loosened back to a silent skip"
done

# The citation V3-5.2 r2 left at each guard is kept, not deleted: it records
# what the guard used to be and why that was tolerated, which is the only thing
# that stops the fail-open shape returning as another "temporary" fix.
for kind in claude-stop-relay turnend-relay; do
  guard_line="$(printf '%s\n' "$body" | grep -n "require_mechanism $kind" | cut -d: -f1 | head -n 1)"
  start=$(( guard_line > 15 ? guard_line - 15 : 1 ))
  context="$(printf '%s\n' "$body" | sed -n "${start},${guard_line}p")"
  grep -q 'V3-5\.6' <<<"$context" &&
    grep -q '2026-08-05-the-heartbeat-has-had-no-writer-since-yesterday' <<<"$context"
  check "the $kind guard keeps its V3-5.6 and incident citation" $? \
    "the marker is exactly what this repository keeps losing"
done

# ── 5. The incident, reproduced in both directions ─────────────────────────
# tmux is shimmed so `list-windows` — the newest-signal-wins input — is under
# the fixture's control: ORCH_TEST_WINDOW_ACTIVITY empty means NO pane signal
# at all, which is the condition the incident never had.
SHIM="$SCRATCH/bin"
cat > "$SHIM/tmux" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  has-session) exit 0 ;;
  list-panes) ps -o ppid= -p "$PPID" | tr -d ' ' ;;
  list-windows) [[ -z "${ORCH_TEST_WINDOW_ACTIVITY:-}" ]] || printf '%s\n' "$ORCH_TEST_WINDOW_ACTIVITY" ;;
  kill-session) printf 'kill-session %s\n' "${3:-}" >> "${ORCH_TEST_TMUX_LOG:?}" ;;
  *) exit 0 ;;
esac
EOF
cat > "$SHIM/df" <<'EOF'
#!/usr/bin/env bash
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n'
printf 'fixture 100 10 90 10%% /\n'
EOF
cat > "$SCRATCH/launch-shim.sh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$1" >> "${ORCH_TEST_ACTIONS:?}"
exit 0
EOF
chmod +x "$SHIM/tmux" "$SHIM/df" "$SCRATCH/launch-shim.sh"

TICK_CASE=""
# Every ORCH_* path is set explicitly: a coder lane inherits the orchestrator's
# whole environment, and an unset knob here resolves to the operator's REAL
# heartbeat, lease and nudge outbox.
tick() { # tick <case> [extra env assignments...]
  TICK_CASE="$1"
  shift
  local root="$SCRATCH/tick-$TICK_CASE"
  TICK_LOG="$root/runtime/watchdog.log"
  TICK_OUTBOX="$root/runtime/nudges.outbox"
  TICK_HEARTBEAT="$root/runtime/orchestrator.heartbeat"
  TICK_LIVENESS="$root/runtime/orchestrator.liveness"
  ORCH_TEST_ACTIONS="$root/actions"
  ORCH_TEST_TMUX_LOG="$root/tmux.log"
  : > "$ORCH_TEST_ACTIONS"
  : > "$ORCH_TEST_TMUX_LOG"
  env PATH="$SHIM:$PATH" \
    ORCH_CONFIG_FILE="$SCRATCH/no-runtime.env" \
    ORCH_SESSION="heartbeat-writer-test" \
    ORCH_RUNTIME_DIR="$root/runtime" \
    ORCH_STATE_DB="$root/absent-state.db" \
    ORCH_LEASE_FILE="$root/runtime/orchestrator.lease" \
    ORCH_HEARTBEAT_FILE="$TICK_HEARTBEAT" \
    ORCH_HEARTBEAT_MISSING_SINCE_FILE="$root/runtime/heartbeat-missing-since" \
    ORCH_LIVENESS_FILE="$TICK_LIVENESS" \
    ORCH_WATCHDOG_LOG="$TICK_LOG" \
    ORCH_DONE_SENTINEL="$root/no-done-sentinel" \
    ORCH_RESTART_STATE_FILE="$root/runtime/watchdog-restart-state" \
    ORCH_LAUNCH_SCRIPT="$SCRATCH/launch-shim.sh" \
    ORCH_DAEMON_HEALTH_URL="" \
    ORCH_INSTALL_ROOT="$SCRATCH" \
    ORCH_WORK_DIR="$SCRATCH" \
    NUDGE_OUTBOX_FILE="$TICK_OUTBOX" \
    NUDGE_RATE_FILE="$root/runtime/nudge-rate.tsv" \
    ORCH_TEST_ACTIONS="$ORCH_TEST_ACTIONS" \
    ORCH_TEST_TMUX_LOG="$ORCH_TEST_TMUX_LOG" \
    DISK_ALERT_PCT=99 \
    "$@" \
    "$WATCHDOG" >/dev/null 2>&1
  return 0
}

new_tick_case() { # new_tick_case <name>; seeds an isolated runtime tree
  local root="$SCRATCH/tick-$1"
  mkdir -p "$root/runtime"
}

log_has() { grep -Fq -- "$1" "$TICK_LOG" 2>/dev/null; }
outbox_has() { [[ -f "$TICK_OUTBOX" ]] && grep -Fq -- "$1" "$TICK_OUTBOX"; }

STALE_NOW=2000000000
STALE_STAMP=$(( STALE_NOW - 49197 ))   # the age measured in the incident

# 5a. THE MASKING, reproduced. Heartbeat stale by the incident's own 49 197s,
# but a FRESH tmux window_activity: the watchdog logs the stale heartbeat and
# deliberately does not kill. This is what carried the system for fourteen
# hours, and it must keep working — it is a correct guard, not the defect.
new_tick_case masked
printf '%s\n' "$STALE_STAMP" > "$SCRATCH/tick-masked/runtime/orchestrator.heartbeat"
tick masked ORCH_WATCHDOG_NOW="$STALE_NOW" ORCH_WATCHDOG_NOW_MS="$(( STALE_NOW * 1000 ))" \
  ORCH_TEST_WINDOW_ACTIVITY="$(( STALE_NOW - 5 ))"
log_has "reason=heartbeat-stale-session-active"
check "a fresh tmux signal masks a stale heartbeat into a no-kill NO-GO" $? \
  "this is the fallback that hid the outage; it must still hold"
[[ ! -s "$SCRATCH/tick-masked/actions" ]]
check "the masked case kills nothing" $? "$(cat "$SCRATCH/tick-masked/actions" 2>/dev/null)"

# 5b. THE ESCALATION. Same stale heartbeat, NO tmux signal masking it, and no
# pulse file: the watchdog must escalate to the operator. Absence of a pulse is
# ambiguity, so this alerts rather than kills — an alert IS the escalation the
# incident never got.
new_tick_case unmasked
printf '%s\n' "$STALE_STAMP" > "$SCRATCH/tick-unmasked/runtime/orchestrator.heartbeat"
tick unmasked ORCH_WATCHDOG_NOW="$STALE_NOW" ORCH_WATCHDOG_NOW_MS="$(( STALE_NOW * 1000 ))" \
  ORCH_TEST_WINDOW_ACTIVITY=""
log_has "reason=liveness-signal-absent"
check "a stale heartbeat with no tmux signal escalates" $? \
  "the whole outage was this branch never being reached"
outbox_has "NUDGE liveness-signal-absent"
check "the escalation reaches the operator's nudge outbox" $? \
  "a log line nobody reads is not an escalation"

# 5c. THE KILL PATH. Stale heartbeat, no tmux signal, a STALE pulse, and the
# recorded provider verifiably gone — the one combination allowed to recover.
new_tick_case dead
printf '%s\n' "$STALE_STAMP" > "$SCRATCH/tick-dead/runtime/orchestrator.heartbeat"
printf '%s\n' "$STALE_STAMP" > "$SCRATCH/tick-dead/runtime/orchestrator.liveness"
# A pid that cannot exist: /proc has no entry, so the identity resolves `gone`.
printf 'pid=%s\nstarttime=1\n' "$(( $(cat /proc/sys/kernel/pid_max) - 1 ))" \
  > "$SCRATCH/tick-dead/runtime/orchestrator.liveness.identity"
tick dead ORCH_WATCHDOG_NOW="$STALE_NOW" ORCH_WATCHDOG_NOW_MS="$(( STALE_NOW * 1000 ))" \
  ORCH_TEST_WINDOW_ACTIVITY=""
log_has "action=kill-relaunch"
check "a stale heartbeat over a provably dead provider recovers" $? \
  "the escalation must still be able to reach a kill"

# 5d. THE REPAIR, end to end. The relay stamps the SAME heartbeat file the
# watchdog then judges, and the stale branch is not entered at all. This is the
# assertion that goes red the moment the relay stops writing: sections 1-2 prove
# the file exists and stamps, this proves the stamp is the one that counts.
new_tick_case repaired
env ORCH_CONFIG_FILE="$SCRATCH/no-runtime.env" \
  ORCH_RUNTIME_DIR="$SCRATCH/tick-repaired/runtime" \
  ORCH_RELAY_CLI="$SCRATCH/no-such-relay.ts" \
  "$TURNEND_PATH" "$codex_payload" >/dev/null 2>&1 </dev/null
tick repaired ORCH_TEST_WINDOW_ACTIVITY=""
if ! log_has "heartbeat-stale" && ! log_has "liveness-signal-absent"; then
  pass "after the relay runs, the watchdog sees no staleness at all"
else
  fail "after the relay runs, the watchdog sees no staleness at all — $(cat "$TICK_LOG" 2>/dev/null)"
fi

printf '\n'
if (( failures > 0 )); then
  printf '%s: %d assertion(s) FAILED\n' "$(basename "$0")" "$failures"
  exit 1
fi
printf '%s: all assertions passed\n' "$(basename "$0")"
