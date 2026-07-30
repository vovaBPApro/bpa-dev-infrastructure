#!/usr/bin/env bash
# Regression lock: the watchdog's supervision behaviour must match what the
# operator is TOLD it does.
#
# Four losses restored here, each verified against the reference implementation
# in migration-prep/reference-daemon/tools/claude-telegram-daemon/:
#
#   A. /done rest. daemon/server.ts writes an `orchestrator-done` sentinel and
#      answers the operator "✅ Готово. Watchdog спить (квоту не палить)". No
#      code anywhere read that file, so the reassurance was false and the
#      watchdog kept nudging and restarting. The reference checked it first and
#      exited (reference watchdog :35, :108-111).
#   B. Restart cooldown. Every tick called `launch.sh start` unconditionally, at
#      the installed 60s cadence (install-watchdog.sh). The reference had a
#      900s/1800s cooldown on a 600s timer (:44-55, :203-217) — we had dropped
#      the anti-thrash AND made the tick 10x faster, i.e. a restart storm that
#      burns provider quota.
#   C. Restart visibility. The reference sent restarting / restarted / failed to
#      Telegram (:206-211). Ours only wrote a log line nobody reads, so the
#      operator's orchestrator could be killed and relaunched all night in
#      silence.
#   E. Daemon health. The reference probed the daemon /health (:130-134). Ours
#      had no probe at all, so a dead daemon — which owns the Telegram token AND
#      drains this very outbox — was invisible.
#
# The kill/restart path is fully shimmed: tmux is a recorder and launch.sh is
# replaced by a scripted stub, so no real session is ever touched.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SCRATCH="$(mktemp -d)"
SHIM="$SCRATCH/bin"
cleanup() { rm -rf "$SCRATCH"; return 0; }
trap cleanup EXIT
mkdir -p "$SHIM"

BUN_BIN="${BUN_BIN:-$(command -v bun)}"
export BUN_BIN

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

# ── Shims ───────────────────────────────────────────────────────────────────
# ORCH_TEST_SESSION_ALIVE drives session health, so "dead session" is reachable
# without killing anything. kill-session is recorded, never performed.
cat > "$SHIM/tmux" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  has-session) [[ "${ORCH_TEST_SESSION_ALIVE:-1}" == 1 ]] ;;
  list-panes) ps -o ppid= -p "$PPID" | tr -d ' ' ;;
  kill-session) printf 'kill-session %s\n' "${3:-}" >> "${ORCH_TEST_TMUX_LOG:?}" ;;
  *) exit 0 ;;
esac
EOF
cat > "$SHIM/df" <<'EOF'
#!/usr/bin/env bash
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n'
printf 'fixture 100 10 90 10%% /\n'
EOF
# Scripted launcher: records every action and returns ORCH_TEST_LAUNCH_STATUS,
# so both the success and the failure branch of a restart are exercised.
cat > "$SCRATCH/launch-shim.sh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$1" >> "${ORCH_TEST_ACTIONS:?}"
exit "${ORCH_TEST_LAUNCH_STATUS:-0}"
EOF
# curl shim: never leaves the box. ORCH_TEST_DAEMON_UP decides the verdict.
cat > "$SHIM/curl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${ORCH_TEST_CURL_LOG:?}"
[[ "${ORCH_TEST_DAEMON_UP:-1}" == 1 ]]
EOF
chmod +x "$SHIM/tmux" "$SHIM/df" "$SHIM/curl" "$SCRATCH/launch-shim.sh"
export PATH="$SHIM:$PATH"

# ── Live-state isolation ────────────────────────────────────────────────────
# A coder lane inherits the orchestrator's whole ORCH_* surface. Each of these
# is env-derived inside watchdog.sh and each override wins over
# ORCH_RUNTIME_DIR, so an unset here resolves to the operator's REAL file: the
# live lease, the live heartbeat, the live nudge outbox the daemon forwards to
# Telegram, the live state DB, and — new in this suite — the DAEMON's `/done`
# sentinel, which is not under ORCH_RUNTIME_DIR at all.
export ORCH_CONFIG_FILE="$SCRATCH/no-runtime.env"
export ORCH_INSTALL_ROOT="$SCRATCH"
export ORCH_INSTANCE_LOCK_FILE="$SCRATCH/instance.lock"
export ORCH_SINGLETON_LOCK_FILE="$SCRATCH/orchestrator.singleton.lock"
export ORCH_LOCK_FILE="$SCRATCH/launch.lock"
export ORCH_LAUNCH_SCRIPT="$SCRATCH/launch-shim.sh"
export ORCH_TEST_ACTIONS="$SCRATCH/actions"
export ORCH_TEST_TMUX_LOG="$SCRATCH/tmux.log"
export ORCH_TEST_CURL_LOG="$SCRATCH/curl.log"
export ORCH_SESSION="watchdog-supervision-test"
export ORCH_WORK_DIR="$SCRATCH"
export DISK_ALERT_PCT=99
export ORCH_HEARTBEAT_MAX_AGE=100000
unset ORCH_MISSION_CLI ORCH_FENCING_TOKEN ORCH_LEASE_OWNER ORCH_PROVIDER
unset ORCH_WATCHDOG_NOW ORCH_WATCHDOG_NOW_MS

assert_isolated() {
  local name value
  for name in ORCH_RUNTIME_DIR ORCH_STATE_DB ORCH_LEASE_FILE ORCH_HEARTBEAT_FILE \
    ORCH_HEARTBEAT_MISSING_SINCE_FILE ORCH_LIVENESS_FILE ORCH_WATCHDOG_LOG \
    ORCH_DONE_SENTINEL ORCH_RESTART_STATE_FILE NUDGE_OUTBOX_FILE NUDGE_RATE_FILE \
    ORCH_INSTANCE_LOCK_FILE ORCH_LAUNCH_SCRIPT ORCH_INSTALL_ROOT; do
    value="${!name-}"
    [[ -n "$value" ]] || fail "isolation: $name is unset; it would resolve to a live path"
    [[ "$value" == "$SCRATCH"/* || "$value" == "$SCRATCH" ]] ||
      fail "isolation: $name=$value escapes the scratch tree"
  done
  [[ "${ORCH_DAEMON_HEALTH_URL-unset}" != unset ]] ||
    fail 'isolation: ORCH_DAEMON_HEALTH_URL is unset; the probe would hit the live daemon'
}

CASE=""
new_case() {
  CASE="$1"
  local root="$SCRATCH/$CASE"
  mkdir -p "$root/runtime"
  export ORCH_RUNTIME_DIR="$root/runtime"
  export ORCH_STATE_DB="$root/absent-state.db"
  export ORCH_LEASE_FILE="$root/runtime/orchestrator.lease"
  export ORCH_HEARTBEAT_FILE="$root/runtime/orchestrator.heartbeat"
  export ORCH_HEARTBEAT_MISSING_SINCE_FILE="$root/runtime/heartbeat-missing-since"
  export ORCH_LIVENESS_FILE="$root/runtime/orchestrator.liveness"
  export ORCH_WATCHDOG_LOG="$root/runtime/watchdog.log"
  export ORCH_DONE_SENTINEL="$root/done-sentinel"
  export ORCH_RESTART_STATE_FILE="$root/runtime/watchdog-restart-state"
  export NUDGE_OUTBOX_FILE="$root/runtime/nudges.outbox"
  export NUDGE_RATE_FILE="$root/runtime/nudge-rate.tsv"
  export ORCH_DAEMON_HEALTH_URL=""
  export ORCH_TEST_SESSION_ALIVE=1
  export ORCH_TEST_LAUNCH_STATUS=0
  export ORCH_TEST_DAEMON_UP=1
  : > "$ORCH_TEST_ACTIONS"
  : > "$ORCH_TEST_TMUX_LOG"
  : > "$ORCH_TEST_CURL_LOG"
  printf '%s\n' "$(date +%s)" > "$ORCH_HEARTBEAT_FILE"
  assert_isolated
}

tick() { "$SCRIPT_DIR/watchdog.sh"; }
log_has() { grep -Fq -- "$1" "$ORCH_WATCHDOG_LOG" || fail "[$CASE] missing log line: $1"; }
outbox_has() {
  [[ -f "$NUDGE_OUTBOX_FILE" ]] || fail "[$CASE] no nudge outbox; operator was told nothing"
  grep -Fq -- "$1" "$NUDGE_OUTBOX_FILE" || fail "[$CASE] operator was not told: $1"
}
outbox_lacks() {
  [[ ! -f "$NUDGE_OUTBOX_FILE" ]] || ! grep -Fq -- "$1" "$NUDGE_OUTBOX_FILE" ||
    fail "[$CASE] unexpected operator message: $1"
}
action_count() { grep -cx "$1" "$ORCH_TEST_ACTIONS" 2>/dev/null || true; }
assert_actions() {
  local want_start="$1" want_stop="$2"
  [[ "$(action_count start)" == "$want_start" ]] ||
    fail "[$CASE] start count $(action_count start), expected $want_start"
  [[ "$(action_count stop)" == "$want_stop" ]] ||
    fail "[$CASE] stop count $(action_count stop), expected $want_stop"
}

# ── A. `/done` rest sentinel ────────────────────────────────────────────────
# The daemon already told the operator the watchdog is asleep. Make that true.
new_case done-sentinel-rests
: > "$ORCH_DONE_SENTINEL"
export ORCH_TEST_SESSION_ALIVE=0        # a dead session would normally relaunch
tick
log_has "rest reason=done-sentinel"
assert_actions 0 0
[[ ! -s "$ORCH_TEST_TMUX_LOG" ]] || fail '[done-sentinel-rests] a resting tick still killed a session'
outbox_lacks NUDGE

# The sentinel is the ONLY thing resting the tick: remove it and the same
# fixture recovers, so a passing rest case can never be a silently inert tick.
new_case done-sentinel-cleared-resumes
export ORCH_TEST_SESSION_ALIVE=0
tick
log_has 'dead session='
assert_actions 1 0

# The path is not ours to choose: it must be the file daemon/server.ts writes on
# /done. Derived from the daemon source so either side moving fails here.
new_case done-sentinel-path-matches-daemon
daemon_src="$REPO_DIR/daemon/server.ts"
grep -Fq "join(RUNTIME_DIR, 'orchestrator-done')" "$daemon_src" ||
  fail 'daemon no longer writes the orchestrator-done sentinel under RUNTIME_DIR'
grep -Fq "const RUNTIME_DIR = join(STATE_DIR, 'daemon', 'runtime')" "$daemon_src" ||
  fail 'daemon RUNTIME_DIR layout changed; the watchdog sentinel path must follow'
expected_sentinel="$SCRATCH/fake-telegram-state/daemon/runtime/orchestrator-done"
mkdir -p "$(dirname "$expected_sentinel")"
: > "$expected_sentinel"
resolved_log="$SCRATCH/resolved-sentinel.log"
# ORCH_DONE_SENTINEL is dropped on purpose: this case is about the DEFAULT the
# watchdog derives, which is the value that runs in production.
env -u ORCH_DONE_SENTINEL PATH="$SHIM:$PATH" ORCH_CONFIG_FILE="$SCRATCH/no-runtime.env" \
  TELEGRAM_STATE_DIR="$SCRATCH/fake-telegram-state" \
  ORCH_RUNTIME_DIR="$SCRATCH/$CASE/runtime" ORCH_WATCHDOG_LOG="$resolved_log" \
  ORCH_STATE_DB="$SCRATCH/$CASE/absent-state.db" ORCH_LAUNCH_SCRIPT="$SCRATCH/launch-shim.sh" \
  ORCH_DAEMON_HEALTH_URL="" ORCH_TEST_ACTIONS="$SCRATCH/actions" \
  ORCH_TEST_TMUX_LOG="$SCRATCH/tmux.log" ORCH_TEST_CURL_LOG="$SCRATCH/curl.log" \
  "$SCRIPT_DIR/watchdog.sh"
grep -Fq "rest reason=done-sentinel path=$expected_sentinel" "$resolved_log" ||
  fail 'the watchdog does not resolve the sentinel to the path the daemon writes'

# ── B. Restart cooldown ─────────────────────────────────────────────────────
# A provider that cannot come up must not be relaunched once a minute forever.
new_case restart-cooldown-suppresses
export ORCH_TEST_SESSION_ALIVE=0
export ORCH_RESTART_COOLDOWN=1800 ORCH_RESTART_COOLDOWN_NIGHT=1800
tick
assert_actions 1 0
tick
assert_actions 1 0
log_has 'WATCHDOG restart-suppressed reason=dead'
outbox_has 'NUDGE watchdog-restart-suppressed'

# Once the cooldown has elapsed, recovery resumes: the throttle must not become
# a permanent refusal to recover.
new_case restart-cooldown-expires
export ORCH_TEST_SESSION_ALIVE=0
export ORCH_RESTART_COOLDOWN=1800 ORCH_RESTART_COOLDOWN_NIGHT=1800
ORCH_WATCHDOG_NOW=1000000 tick
assert_actions 1 0
ORCH_WATCHDOG_NOW=1001000 tick        # +1000s, still inside a 1800s cooldown
assert_actions 1 0
ORCH_WATCHDOG_NOW=1002000 tick        # +2000s, past it
assert_actions 2 0

# Night (22:00-07:00 local) recovers sooner: the operator is asleep and cannot
# intervene, so the same stall must not sit un-recovered for the day window.
new_case restart-cooldown-night
export ORCH_TEST_SESSION_ALIVE=0
unset ORCH_RESTART_COOLDOWN ORCH_RESTART_COOLDOWN_NIGHT
ORCH_WATCHDOG_HOUR=23 ORCH_WATCHDOG_NOW=2000000 tick
assert_actions 1 0
log_has 'night=1'
ORCH_WATCHDOG_HOUR=23 ORCH_WATCHDOG_NOW=2001000 tick   # +1000s > 900s night
assert_actions 2 0
new_case restart-cooldown-day
export ORCH_TEST_SESSION_ALIVE=0
ORCH_WATCHDOG_HOUR=12 ORCH_WATCHDOG_NOW=2000000 tick
assert_actions 1 0
log_has 'night=0'
ORCH_WATCHDOG_HOUR=12 ORCH_WATCHDOG_NOW=2001000 tick   # +1000s < 1800s day
assert_actions 1 0
log_has 'WATCHDOG restart-suppressed'

# ── C. Restart visibility ───────────────────────────────────────────────────
new_case restart-announced
export ORCH_TEST_SESSION_ALIVE=0
tick
assert_actions 1 0
outbox_has "NUDGE watchdog-restarting session=$ORCH_SESSION reason=dead"
outbox_has "NUDGE watchdog-restarted session=$ORCH_SESSION reason=dead"

# A restart that FAILS is the case the operator most needs to hear about: the
# orchestrator is down and staying down.
new_case restart-failure-announced
export ORCH_TEST_SESSION_ALIVE=0
export ORCH_TEST_LAUNCH_STATUS=3
tick
outbox_has "NUDGE watchdog-restart-failed session=$ORCH_SESSION"
outbox_has needs=manual-intervention
log_has 'WATCHDOG NO-GO reason=restart-failed'

# A stale heartbeat is a kill-then-relaunch, and must be announced the same
# way. The kill now requires positive death evidence: a liveness pulse that WAS
# being renewed and has gone stale (the in-pane renewer dies with the provider
# PID it watches). Without it, a stale heartbeat is ambiguity and only alerts —
# heartbeat-liveness.test.sh owns that verdict table.
new_case zombie-restart-announced
printf '%s\n' 100 > "$ORCH_HEARTBEAT_FILE"
printf '%s\n' 100 > "$ORCH_LIVENESS_FILE"
ORCH_WATCHDOG_NOW=100000 ORCH_HEARTBEAT_MAX_AGE=10 tick
assert_actions 1 1
log_has 'zombie session='
outbox_has 'NUDGE watchdog-restarting'
outbox_has 'reason=zombie'

# A healthy tick stays quiet: no restart chatter on the operator's channel.
new_case healthy-tick-is-quiet
tick
assert_actions 0 0
outbox_lacks 'NUDGE watchdog-restart'

# ── E. Daemon health probe ──────────────────────────────────────────────────
# The daemon owns the Telegram token AND drains this outbox, so its death is the
# one failure that makes every other signal undeliverable.
new_case daemon-health-probed
export ORCH_DAEMON_HEALTH_URL="http://127.0.0.1:65535/health"
export ORCH_TEST_DAEMON_UP=1
tick
grep -Fq "$ORCH_DAEMON_HEALTH_URL" "$ORCH_TEST_CURL_LOG" ||
  fail '[daemon-health-probed] the daemon health endpoint was never probed'
outbox_lacks 'NUDGE daemon-unreachable'

new_case daemon-unreachable-reported
export ORCH_DAEMON_HEALTH_URL="http://127.0.0.1:65535/health"
export ORCH_TEST_DAEMON_UP=0
export FLEET_NUDGE_REPEAT_MS=1
tick
log_has 'WATCHDOG daemon-unreachable'
outbox_has 'NUDGE daemon-unreachable'
# An unreachable daemon says nothing about the orchestrator; it must not
# trigger a restart of a healthy session.
assert_actions 0 0
[[ ! -s "$ORCH_TEST_TMUX_LOG" ]] ||
  fail '[daemon-unreachable-reported] a daemon outage killed the orchestrator session'
unset FLEET_NUDGE_REPEAT_MS

printf 'watchdog supervision tests: PASS\n'
