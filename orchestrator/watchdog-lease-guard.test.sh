#!/usr/bin/env bash
# Regression lock: the watchdog's lease fence must kill only on GENUINE
# displacement.
#
# The fault this suite locks out: `lease renew` failing was treated as proof
# that another orchestrator had taken over, so the watchdog killed the tmux
# session. But renew also fails when nothing took over at all — the lease simply
# aged out, because the renewal TTL (30s, hardcoded in mission-cli) was SHORTER
# than the watchdog tick that performs the renewal (60s, install-watchdog.sh).
# That combination guarantees the lease is already expired at every tick, so an
# armed watchdog would kill a perfectly healthy singleton on its second tick,
# forever. Found live: orchestrator.lease held owner=<host>:<pid> token=18 for a
# healthy session whose lease had self-expired and been reaped.
#
# Locked here:
#   1. uncontested self-expiry  -> re-acquire, DO NOT kill
#   2. displacement by a LIVE other owner -> still kill (the fence stays intact)
#   3. holder present but not live -> NO-GO, no kill
#   4. lease state unreadable -> NO-GO, no kill
#   5. a renewal must outlive the next tick (the root cause, not the symptom)
#   6. renewals keep one token alive across consecutive ticks
#
# The kill path is shimmed: tmux is replaced by a recorder, so a real
# kill-session is never issued against any session on this box.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SCRATCH="$(mktemp -d)"
SHIM="$SCRATCH/bin"
# Every step tolerates already-gone state: under `set -e` a failing step in an
# EXIT trap aborts the trap and turns a passing run into a non-zero exit.
cleanup() {
  if [[ -n "${LAUNCH_TMUX_SOCKET:-}" ]]; then
    tmux -L "$LAUNCH_TMUX_SOCKET" kill-server 2>/dev/null || true
  fi
  [[ -z "${HOLDER_PID:-}" ]] || kill "$HOLDER_PID" 2>/dev/null || true
  [[ -z "${SELF_PID:-}" ]] || kill "$SELF_PID" 2>/dev/null || true
  rm -rf "$SCRATCH"
  return 0
}
trap cleanup EXIT
mkdir -p "$SHIM"

BUN_BIN="${BUN_BIN:-$(command -v bun)}"
export BUN_BIN
HOST="$(hostname)"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

# ── Shims ───────────────────────────────────────────────────────────────────
# tmux records instead of acting. stop_supervised_unit resolves to
# `tmux kill-session`, so recording it is how a kill is observed without one
# ever reaching a real session.
cat > "$SHIM/tmux" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  has-session) exit 0 ;;
  list-panes) ps -o ppid= -p "$PPID" | tr -d ' ' ;;
  kill-session) printf 'kill-session %s\n' "${3:-}" >> "${ORCH_TEST_TMUX_LOG:?}"; exit 0 ;;
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
EOF
chmod +x "$SHIM/tmux" "$SHIM/df" "$SCRATCH/launch-shim.sh"
export PATH="$SHIM:$PATH"

# ── Live-state isolation ────────────────────────────────────────────────────
# A coder lane runs inside the orchestrator's own process tree and inherits its
# whole ORCH_* surface. Every path below is env-derived inside watchdog.sh and
# each override wins over ORCH_RUNTIME_DIR, so an unset here resolves to the
# operator's REAL file: the live lease would be rewritten or re-acquired under a
# new token, the live heartbeat forged, the real nudge outbox (which the daemon
# forwards to Telegram) appended to, and the live state DB written. Two earlier
# lanes were bitten by exactly this.
export ORCH_CONFIG_FILE="$SCRATCH/no-runtime.env"
export ORCH_INSTALL_ROOT="$SCRATCH"
export ORCH_INSTANCE_LOCK_FILE="$SCRATCH/instance.lock"
export ORCH_SINGLETON_LOCK_FILE="$SCRATCH/orchestrator.singleton.lock"
export ORCH_LOCK_FILE="$SCRATCH/launch.lock"
export ORCH_LAUNCH_SCRIPT="$SCRATCH/launch-shim.sh"
export ORCH_TEST_ACTIONS="$SCRATCH/actions"
export ORCH_TEST_TMUX_LOG="$SCRATCH/tmux.log"
export ORCH_SESSION="watchdog-lease-guard-test"
export ORCH_WORK_DIR="$SCRATCH"
export DISK_ALERT_PCT=99
export FLEET_IDLE_NUDGE_MS=900000
export FLEET_NUDGE_REPEAT_MS=3600000
export ORCH_HEARTBEAT_MAX_AGE=100000
unset ORCH_MISSION_CLI ORCH_FENCING_TOKEN ORCH_LEASE_OWNER ORCH_PROVIDER
unset ORCH_WATCHDOG_NOW ORCH_WATCHDOG_NOW_MS

# Per-case paths are assigned by new_case; nothing may resolve outside SCRATCH.
assert_isolated() {
  local name value
  for name in ORCH_STATE_DB ORCH_RUNTIME_DIR ORCH_LEASE_FILE ORCH_HEARTBEAT_FILE \
    ORCH_HEARTBEAT_MISSING_SINCE_FILE ORCH_WATCHDOG_LOG NUDGE_OUTBOX_FILE \
    NUDGE_RATE_FILE ORCH_INSTANCE_LOCK_FILE ORCH_SINGLETON_LOCK_FILE \
    ORCH_LAUNCH_SCRIPT ORCH_INSTALL_ROOT; do
    value="${!name-}"
    [[ -n "$value" ]] || fail "isolation: $name is unset; it would resolve to a live path"
    [[ "$value" == "$SCRATCH"/* || "$value" == "$SCRATCH" ]] ||
      fail "isolation: $name=$value escapes the scratch tree"
  done
}

cli() { INFRA_STATE_DB="$1" "$BUN_BIN" "$REPO_DIR/core/mission-cli.ts" "${@:2}"; }
token_of() { sed -nE 's/^LEASE key=orchestrator owner=.* token=([1-9][0-9]*)$/\1/p'; }
lease_file_token() { sed -n 's/^token=//p' "$ORCH_LEASE_FILE"; }
lease_file_owner() { sed -n 's/^owner=//p' "$ORCH_LEASE_FILE"; }

# Active orchestrator lease as "owner<TAB>token<TAB>expiresAt", empty if none.
live_lease() {
  cli "$ORCH_STATE_DB" status | "$BUN_BIN" -e '
const s = JSON.parse(await Bun.stdin.text());
const lease = s.leases.find((l) => l.key === "orchestrator");
if (lease) console.log([lease.owner, lease.fencingToken, lease.expiresAt].join("\t"));'
}

# Split live_lease into LEASE_OWNER_NOW / LEASE_TOKEN_NOW / LEASE_EXPIRY_NOW.
read_live_lease() {
  local row
  row="$(live_lease)"
  LEASE_OWNER_NOW=""; LEASE_TOKEN_NOW=""; LEASE_EXPIRY_NOW=""
  [[ -n "$row" ]] || return 1
  IFS=$'\t' read -r LEASE_OWNER_NOW LEASE_TOKEN_NOW LEASE_EXPIRY_NOW <<<"$row"
  return 0
}

expire_lease() {
  INFRA_STATE_DB="$ORCH_STATE_DB" "$BUN_BIN" -e '
import { Database } from "bun:sqlite";
const db = new Database(process.env.INFRA_STATE_DB);
db.query("UPDATE leases SET expires_at = ? WHERE lease_key = ? AND released_at IS NULL")
  .run(Date.now() - 60_000, "orchestrator");'
}

write_lease_file() { printf 'owner=%s\ntoken=%s\n' "$1" "$2" > "$ORCH_LEASE_FILE"; }

CASE=""
new_case() {
  CASE="$1"
  local root="$SCRATCH/$CASE"
  mkdir -p "$root/runtime"
  export ORCH_RUNTIME_DIR="$root/runtime"
  export ORCH_STATE_DB="$root/state.db"
  export ORCH_LEASE_FILE="$root/runtime/orchestrator.lease"
  export ORCH_HEARTBEAT_FILE="$root/runtime/orchestrator.heartbeat"
  export ORCH_HEARTBEAT_MISSING_SINCE_FILE="$root/runtime/heartbeat-missing-since"
  export ORCH_WATCHDOG_LOG="$root/runtime/watchdog.log"
  export NUDGE_OUTBOX_FILE="$root/runtime/nudges.outbox"
  export NUDGE_RATE_FILE="$root/runtime/nudge-rate.tsv"
  export ORCH_MISSION_CLI="$REPO_DIR/core/mission-cli.ts"
  : > "$ORCH_TEST_TMUX_LOG"
  : > "$ORCH_TEST_ACTIONS"
  printf '%s\n' "$(date +%s)" > "$ORCH_HEARTBEAT_FILE"
  # A real DB file, so state_available() is true and the lease branch is reached.
  cli "$ORCH_STATE_DB" status >/dev/null
  assert_isolated
}

tick() { "$SCRIPT_DIR/watchdog.sh"; }
log_has() { grep -Fq -- "$1" "$ORCH_WATCHDOG_LOG" || fail "[$CASE] missing log line: $1"; }
assert_killed() {
  grep -Fxq "kill-session $ORCH_SESSION" "$ORCH_TEST_TMUX_LOG" ||
    fail "[$CASE] the fence did NOT stop the session on genuine displacement"
}
assert_not_killed() {
  [[ ! -s "$ORCH_TEST_TMUX_LOG" ]] ||
    fail "[$CASE] a healthy session was killed: $(cat "$ORCH_TEST_TMUX_LOG")"
}

# A PID that is guaranteed not to exist, without relying on PID reuse timing.
free_pid() {
  local max candidate
  max="$(cat /proc/sys/kernel/pid_max 2>/dev/null || printf '%s' 32768)"
  for (( candidate = max - 1; candidate > max - 200; candidate-- )); do
    kill -0 "$candidate" 2>/dev/null || { printf '%s\n' "$candidate"; return 0; }
  done
  fail 'could not find a free PID for the dead-owner fixture'
}

sleep 100000 & SELF_PID=$!      # our own live orchestrator process
sleep 100000 & HOLDER_PID=$!    # a competing live orchestrator process
DEAD_PID="$(free_pid)"
SELF_OWNER="$HOST:$SELF_PID"
HOLDER_OWNER="$HOST:$HOLDER_PID"
DEAD_OWNER="$HOST:$DEAD_PID"

# ── 1. Uncontested self-expiry: re-acquire, never kill ──────────────────────
# Nobody else holds the lease; our own token simply aged out. Killing here
# destroys the operator's only channel for no reason at all.
new_case uncontested-self-expiry
stale_token="$(cli "$ORCH_STATE_DB" lease acquire "$SELF_OWNER" orchestrator 1000 | token_of)"
[[ -n "$stale_token" ]] || fail 'fixture lease token missing'
expire_lease
write_lease_file "$SELF_OWNER" "$stale_token"
[[ -z "$(live_lease)" ]] || fail 'fixture: lease should be expired before the tick'
tick
assert_not_killed
log_has "WATCHDOG lease-reacquired owner=$SELF_OWNER stale-token=$stale_token"
read_live_lease || fail 'no live lease after an uncontested re-acquire'
[[ "$LEASE_OWNER_NOW" == "$SELF_OWNER" ]] || fail "re-acquired lease owner drifted: $LEASE_OWNER_NOW"
(( LEASE_TOKEN_NOW > stale_token )) || fail 're-acquire did not mint a newer fencing token'
[[ "$(lease_file_token)" == "$LEASE_TOKEN_NOW" ]] ||
  fail "lease file kept the dead token $(lease_file_token), expected $LEASE_TOKEN_NOW"
[[ "$(lease_file_owner)" == "$SELF_OWNER" ]] || fail 'lease file owner drifted'
[[ ! -s "$ORCH_TEST_ACTIONS" ]] || fail 'self-expiry triggered a relaunch'

# ── 2. Contradictory live ownership: preserve the configured live session ───
# Lease bookkeeping alone cannot authorize killing the operator's live channel.
# The launcher's singleton lock remains the mutual-exclusion boundary.
new_case displaced-by-live-owner
stale_self_token="$(cli "$ORCH_STATE_DB" lease acquire "$SELF_OWNER" orchestrator 1000 | token_of)"
expire_lease
held_token="$(cli "$ORCH_STATE_DB" lease acquire "$HOLDER_OWNER" orchestrator 600000 | token_of)"
write_lease_file "$SELF_OWNER" "$stale_self_token"
tick
assert_not_killed
log_has "WATCHDOG NO-GO reason=lease-displaced-session-live owner=$SELF_OWNER token=$stale_self_token holder=$HOLDER_OWNER"
read_live_lease || fail 'the fence destroyed the live holder lease'
[[ "$LEASE_OWNER_NOW" == "$HOLDER_OWNER" && "$LEASE_TOKEN_NOW" == "$held_token" ]] ||
  fail 'the fence stole the live holder lease instead of standing down'

# ── 3. Holder present but not live: ambiguous, so NO-GO and no kill ─────────
# A corpse holding an unexpired lease is not a takeover. Killing the healthy
# singleton because a dead process still owns a row is the failure mode itself.
new_case holder-not-live
dead_token="$(cli "$ORCH_STATE_DB" lease acquire "$DEAD_OWNER" orchestrator 600000 | token_of)"
write_lease_file "$SELF_OWNER" "$dead_token"
tick
assert_not_killed
log_has "WATCHDOG NO-GO reason=lease-holder-not-live holder=$DEAD_OWNER"

# ── 4. Lease state unreadable: NO-GO and no kill ────────────────────────────
# The state DB exists (so the fence branch is entered) but the CLI cannot answer.
# An unverifiable answer is never grounds to kill.
new_case lease-state-unreadable
write_lease_file "$SELF_OWNER" 7
export ORCH_MISSION_CLI="$SCRATCH/absent-mission-cli.ts"
tick
assert_not_killed
log_has 'WATCHDOG NO-GO reason=lease-state-unreadable'
export ORCH_MISSION_CLI="$REPO_DIR/core/mission-cli.ts"

# ── 5. A renewal must outlive the next tick ────────────────────────────────
# The root cause. `lease renew` used a fixed 30s TTL while the installed timer
# ticks every 60s, so the lease was guaranteed to be dead at the next tick and
# the fence was guaranteed to fire against a healthy session. A renewal that
# does not reach the next tick is not a renewal.
new_case renewal-outlives-tick
export ORCH_WATCHDOG_INTERVAL=60
# Was 120000, which is EXACTLY two ticks — the boundary the fence now rejects
# (see the `<=` note in watchdog.sh). Renewal mechanics are what this case is
# about, so it uses a TTL the fence approves rather than one it flags.
export ORCH_LEASE_TTL_MS=180000
live_token="$(cli "$ORCH_STATE_DB" lease acquire "$SELF_OWNER" orchestrator 1000 | token_of)"
write_lease_file "$SELF_OWNER" "$live_token"
before_ms="$(( $(date +%s) * 1000 ))"
tick
assert_not_killed
read_live_lease || fail 'the renewing tick left no live lease at all'
[[ "$LEASE_TOKEN_NOW" == "$live_token" ]] ||
  fail "a live lease was re-acquired instead of renewed (token $live_token -> $LEASE_TOKEN_NOW)"
headroom_ms=$(( LEASE_EXPIRY_NOW - before_ms ))
(( headroom_ms >= ORCH_WATCHDOG_INTERVAL * 1000 * 2 )) ||
  fail "renewal leaves only ${headroom_ms}ms, under two ${ORCH_WATCHDOG_INTERVAL}s ticks: the lease dies before the next renewal"

# The knob that produced the fault must fail loudly rather than silently arming
# a self-killing watchdog.
new_case renewal-ttl-under-tick
export ORCH_WATCHDOG_INTERVAL=60
export ORCH_LEASE_TTL_MS=30000
short_token="$(cli "$ORCH_STATE_DB" lease acquire "$SELF_OWNER" orchestrator 60000 | token_of)"
write_lease_file "$SELF_OWNER" "$short_token"
tick
assert_not_killed
log_has 'WATCHDOG NO-GO reason=lease-ttl-under-tick'
unset ORCH_WATCHDOG_INTERVAL ORCH_LEASE_TTL_MS

# ── 6. Consecutive ticks keep one token alive ──────────────────────────────
# End to end, wall-clock: a lease acquired with a short TTL survives ticks that
# straddle that TTL, under the SAME fencing token, with no kill and no relaunch.
new_case renewal-across-ticks
export ORCH_LEASE_TTL_MS=4000
export ORCH_WATCHDOG_INTERVAL=1
# The acquire TTL is deliberately shorter than the run: without working
# renewals this lease is dead before the last tick.
kept_token="$(cli "$ORCH_STATE_DB" lease acquire "$SELF_OWNER" orchestrator 2000 | token_of)"
write_lease_file "$SELF_OWNER" "$kept_token"
for _ in 1 2 3 4; do
  tick
  sleep 1
done
assert_not_killed
read_live_lease || fail 'the lease died across ticks that were supposed to renew it'
[[ "$LEASE_TOKEN_NOW" == "$kept_token" ]] ||
  fail "the lease lapsed and was re-acquired mid-run (token $kept_token -> $LEASE_TOKEN_NOW)"
[[ "$LEASE_OWNER_NOW" == "$SELF_OWNER" ]] || fail 'owner drifted across renewals'
# Survival alone does not prove the renewer is using the configured TTL — a
# hardcoded TTL that happens to be longer would also survive. Pin the renewal
# to ORCH_LEASE_TTL_MS so the knob, and only the knob, sets the headroom.
(( LEASE_EXPIRY_NOW - $(date +%s) * 1000 <= ORCH_LEASE_TTL_MS + 1000 )) ||
  fail 'renewals ignore ORCH_LEASE_TTL_MS: the renewer applies a TTL of its own'
[[ "$(lease_file_token)" == "$kept_token" ]] || fail 'lease file drifted across renewals'
[[ ! -s "$ORCH_TEST_ACTIONS" ]] || fail 'a renewed, healthy session was relaunched'
unset ORCH_LEASE_TTL_MS ORCH_WATCHDOG_INTERVAL

# ── mission-cli contract: renew must accept an explicit TTL ────────────────
new_case renew-ttl-argument
arg_token="$(cli "$ORCH_STATE_DB" lease acquire "$SELF_OWNER" orchestrator 1000 | token_of)"
cli "$ORCH_STATE_DB" lease renew "$SELF_OWNER" orchestrator "$arg_token" 900000 >/dev/null ||
  fail 'lease renew rejects an explicit TTL argument'
read_live_lease || fail 'explicit-TTL renewal left no live lease'
(( LEASE_EXPIRY_NOW - $(date +%s) * 1000 > 600000 )) ||
  fail 'lease renew ignored the explicit TTL argument'
cli "$ORCH_STATE_DB" lease renew "$SELF_OWNER" orchestrator "$arg_token" >/dev/null ||
  fail 'lease renew lost its three-argument (default TTL) form'

# ── launch.sh must not shrink the lease it just acquired ───────────────────
# The live fault: launch.sh acquires with ORCH_LEASE_TTL_MS (120s) and then
# renews twice as a liveness probe. Those probes passed no TTL, so the CLI
# default (30s) overwrote the 120s expiry and the singleton lease died ~34s
# after start with no renewer running at all. Measured end to end against the
# real launcher, confined to a private tmux socket.
new_case launch-renew-keeps-full-ttl
export ORCH_TEST_TMUX_SOCKET="watchdog-lease-guard-$$"
LAUNCH_TMUX_SOCKET="$ORCH_TEST_TMUX_SOCKET"
cat > "$SHIM/tmux" <<'EOF'
#!/usr/bin/env bash
exec /usr/bin/tmux -L "${ORCH_TEST_TMUX_SOCKET:?}" "$@"
EOF
cat > "$SHIM/codex" <<'EOF'
#!/usr/bin/env bash
exec sleep 1000
EOF
cat > "$SCRATCH/preflight.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$SHIM/tmux" "$SHIM/codex" "$SCRATCH/preflight.sh"
export ORCH_AUTH_PREFLIGHT="$SCRATCH/preflight.sh"
export ORCH_PROVIDER=codex
export ORCH_SKIP_TRUST_CHECK=1
export ORCH_SESSION="watchdog-lease-guard-launch"
export ORCH_LEASE_TTL_MS=120000
export ORCH_READINESS_WINDOW_MS=200
"$SCRIPT_DIR/launch.sh" start >/dev/null
read_live_lease || fail 'launch left no live orchestrator lease'
launch_headroom_ms=$(( LEASE_EXPIRY_NOW - $(date +%s) * 1000 ))
"$SCRIPT_DIR/launch.sh" stop >/dev/null
tmux -L "$LAUNCH_TMUX_SOCKET" kill-server 2>/dev/null || true
(( launch_headroom_ms > 60000 )) ||
  fail "launch shrank its own lease to ${launch_headroom_ms}ms of an ${ORCH_LEASE_TTL_MS}ms TTL: the singleton lease dies shortly after start"

printf 'watchdog lease-guard tests: PASS\n'
