#!/usr/bin/env bash
# Real-subprocess coverage for watchdog pressure and the operator status screen.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRATCH="$(mktemp -d)"
SHIM="$SCRATCH/bin"
trap 'rm -rf "$SCRATCH"' EXIT
mkdir -p "$SHIM"

cat > "$SHIM/tmux" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  has-session) exit 0 ;;
  list-panes) ps -o ppid= -p "$PPID" | tr -d ' ' ;;
  *) exit 0 ;;
esac
EOF
cat > "$SHIM/df" <<'EOF'
#!/usr/bin/env bash
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n'
printf 'fixture 100 50 50 %s%% /\n' "${ORCH_TEST_DF_PCT:-10}"
EOF
chmod +x "$SHIM/tmux" "$SHIM/df"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
assert() { "$@" || fail "$*"; }
contains() { grep -Fq -- "$1" "$2" || fail "missing: $1"; }
not_contains() { ! grep -Fq -- "$1" "$2" || fail "unexpected: $1"; }
not_exists() { [[ ! -e "$1" ]] || fail "unexpected file: $1"; }
mission_id() { sed -nE 's/^MISSION id=([^ ]+) state=.*/\1/p'; }
lease_expiry() { sed -nE 's/.*"key":"orchestrator","owner":"orchestrator","fencingToken":1,"expiresAt":([0-9]+).*/\1/p'; }

make_open_lane() {
  local db="$1" correlation="$2" mission
  mission="$(INFRA_STATE_DB="$db" bun "$SCRIPT_DIR/../core/mission-cli.ts" mission create "$correlation" | mission_id)"
  [[ -n "$mission" ]] || fail 'fixture mission ID missing'
  INFRA_STATE_DB="$db" bun "$SCRIPT_DIR/../core/mission-cli.ts" lane create "$mission" "lane-$correlation" >/dev/null
}

run_watchdog() {
  local db="$1" runtime="$2" outbox="$3"
  PATH="$SHIM:$PATH" ORCH_CONFIG_FILE="$SCRATCH/no-config" ORCH_STATE_DB="$db" ORCH_RUNTIME_DIR="$runtime" \
    ORCH_WATCHDOG_LOG="$runtime/watchdog.log" NUDGE_OUTBOX_FILE="$outbox" ORCH_INSTALL_ROOT="$SCRATCH" \
    FLEET_IDLE_NUDGE_MS=1 FLEET_NUDGE_REPEAT_MS=3600000 DISK_ALERT_PCT=99 ORCH_WATCHDOG_NOW_MS="$(( $(date +%s) * 1000 + 10000 ))" \
    "$SCRIPT_DIR/watchdog.sh"
}

# An open lane without a lane lease produces one mission-specific nudge, then
# remains rate-limited on the following tick.
IDLE_DB="$SCRATCH/idle.db"
IDLE_RUNTIME="$SCRATCH/idle-runtime"
IDLE_OUTBOX="$SCRATCH/idle.outbox"
mkdir -p "$IDLE_RUNTIME"
make_open_lane "$IDLE_DB" idle-fixture
assert run_watchdog "$IDLE_DB" "$IDLE_RUNTIME" "$IDLE_OUTBOX"
contains 'NUDGE mission=idle-fixture open_lanes=1 active=0 idle_ms=' "$IDLE_OUTBOX"
first_lines="$(wc -l < "$IDLE_OUTBOX")"
assert run_watchdog "$IDLE_DB" "$IDLE_RUNTIME" "$IDLE_OUTBOX"
[[ "$(wc -l < "$IDLE_OUTBOX")" == "$first_lines" ]] || fail 'mission nudge ignored rate limit'

# A live lease whose key is the open lane ID suppresses a mission nudge.
ACTIVE_DB="$SCRATCH/active.db"
ACTIVE_RUNTIME="$SCRATCH/active-runtime"
ACTIVE_OUTBOX="$SCRATCH/active.outbox"
mkdir -p "$ACTIVE_RUNTIME"
make_open_lane "$ACTIVE_DB" active-fixture
INFRA_STATE_DB="$ACTIVE_DB" bun "$SCRIPT_DIR/../core/mission-cli.ts" lease acquire worker lane-active-fixture 30000 >/dev/null
assert run_watchdog "$ACTIVE_DB" "$ACTIVE_RUNTIME" "$ACTIVE_OUTBOX"
not_exists "$ACTIVE_OUTBOX"

# Disk pressure has a separate rate key and is emitted only at/above threshold.
DISK_DB="$SCRATCH/disk.db"
DISK_RUNTIME="$SCRATCH/disk-runtime"
DISK_OUTBOX="$SCRATCH/disk.outbox"
mkdir -p "$DISK_RUNTIME"
PATH="$SHIM:$PATH" ORCH_CONFIG_FILE="$SCRATCH/no-config" ORCH_STATE_DB="$DISK_DB" ORCH_RUNTIME_DIR="$DISK_RUNTIME" \
  ORCH_WATCHDOG_LOG="$DISK_RUNTIME/watchdog.log" NUDGE_OUTBOX_FILE="$DISK_OUTBOX" ORCH_INSTALL_ROOT="$SCRATCH" \
  ORCH_TEST_DF_PCT=91 DISK_ALERT_PCT=80 FLEET_NUDGE_REPEAT_MS=3600000 "$SCRIPT_DIR/watchdog.sh"
contains 'WATCHDOG disk-pressure pct=91' "$DISK_RUNTIME/watchdog.log"
contains 'NUDGE disk-pressure pct=91' "$DISK_OUTBOX"
disk_alerts="$(grep -c 'WATCHDOG disk-pressure' "$DISK_RUNTIME/watchdog.log")"
rm -f "$DISK_OUTBOX"
PATH="$SHIM:$PATH" ORCH_CONFIG_FILE="$SCRATCH/no-config" ORCH_STATE_DB="$DISK_DB" ORCH_RUNTIME_DIR="$DISK_RUNTIME" \
  ORCH_WATCHDOG_LOG="$DISK_RUNTIME/watchdog.log" NUDGE_OUTBOX_FILE="$DISK_OUTBOX" ORCH_INSTALL_ROOT="$SCRATCH" \
  ORCH_TEST_DF_PCT=12 DISK_ALERT_PCT=80 "$SCRIPT_DIR/watchdog.sh"
not_exists "$DISK_OUTBOX"
[[ "$(grep -c 'WATCHDOG disk-pressure' "$DISK_RUNTIME/watchdog.log")" == "$disk_alerts" ]] || fail 'disk guard was not silent below threshold'

# Invalid observability knobs must fall back safely: the supervision lease is
# renewed before observability runs, and the default disk/idle thresholds apply.
KNOB_DB="$SCRATCH/knob.db"
KNOB_RUNTIME="$SCRATCH/knob-runtime"
KNOB_OUTBOX="$SCRATCH/knob.outbox"
mkdir -p "$KNOB_RUNTIME"
make_open_lane "$KNOB_DB" knob-fixture
INFRA_STATE_DB="$KNOB_DB" bun "$SCRIPT_DIR/../core/mission-cli.ts" lease acquire orchestrator orchestrator 30000 >/dev/null
printf '%s\n' 'owner=orchestrator' 'token=1' > "$KNOB_RUNTIME/orchestrator.lease"
before_lease="$(INFRA_STATE_DB="$KNOB_DB" bun "$SCRIPT_DIR/../core/mission-cli.ts" status | lease_expiry)"
[[ "$before_lease" =~ ^[0-9]+$ ]] || fail 'fixture watchdog lease missing'
assert env PATH="$SHIM:$PATH" ORCH_CONFIG_FILE="$SCRATCH/no-config" ORCH_STATE_DB="$KNOB_DB" ORCH_RUNTIME_DIR="$KNOB_RUNTIME" \
  ORCH_WATCHDOG_LOG="$KNOB_RUNTIME/watchdog.log" ORCH_LEASE_FILE="$KNOB_RUNTIME/orchestrator.lease" NUDGE_OUTBOX_FILE="$KNOB_OUTBOX" \
  ORCH_INSTALL_ROOT="$SCRATCH" ORCH_TEST_DF_PCT=91 DISK_ALERT_PCT=abc FLEET_IDLE_NUDGE_MS=abc FLEET_NUDGE_REPEAT_MS=abc \
  "$SCRIPT_DIR/watchdog.sh"
after_lease="$(INFRA_STATE_DB="$KNOB_DB" bun "$SCRIPT_DIR/../core/mission-cli.ts" status | lease_expiry)"
[[ "$after_lease" =~ ^[0-9]+$ && "$after_lease" -gt "$before_lease" ]] || fail 'watchdog lease was not renewed'
contains 'WATCHDOG invalid-knob name=DISK_ALERT_PCT value=abc using-default=80' "$KNOB_RUNTIME/watchdog.log"
contains 'WATCHDOG invalid-knob name=FLEET_IDLE_NUDGE_MS value=abc using-default=900000' "$KNOB_RUNTIME/watchdog.log"
contains 'WATCHDOG invalid-knob name=FLEET_NUDGE_REPEAT_MS value=abc using-default=3600000' "$KNOB_RUNTIME/watchdog.log"
contains 'NUDGE disk-pressure pct=91' "$KNOB_OUTBOX"
not_contains 'NUDGE mission=knob-fixture' "$KNOB_OUTBOX"

# The status screen renders data when present and explicit SKIP rows otherwise.
DECISIONS="$SCRATCH/decisions.md"
printf '%s\n' '- [ ] choose retention policy' '- [x] done' > "$DECISIONS"
STATUS_OUT="$SCRATCH/status.out"
PATH="$SHIM:$PATH" ORCH_CONFIG_FILE="$SCRATCH/no-config" ORCH_STATE_DB="$IDLE_DB" ORCH_RUNTIME_DIR="$IDLE_RUNTIME" \
  NUDGE_OUTBOX_FILE="$IDLE_OUTBOX" DECISIONS_FILE="$DECISIONS" ORCH_INSTALL_ROOT="$SCRATCH" "$SCRIPT_DIR/status.sh" > "$STATUS_OUT"
contains 'Missions / lanes / leases' "$STATUS_OUT"
contains 'mission    idle-fixture open_lanes=1 active=0' "$STATUS_OUT"
contains 'Server resources' "$STATUS_OUT"
contains 'Newest nudges' "$STATUS_OUT"
contains 'Pending decisions' "$STATUS_OUT"
contains '- [ ] choose retention policy' "$STATUS_OUT"

MISSING_OUT="$SCRATCH/missing-status.out"
PATH="$SHIM:$PATH" ORCH_CONFIG_FILE="$SCRATCH/no-config" ORCH_STATE_DB="$SCRATCH/missing.db" ORCH_RUNTIME_DIR="$SCRATCH/missing-runtime" \
  NUDGE_OUTBOX_FILE="$SCRATCH/missing.outbox" DECISIONS_FILE="$SCRATCH/missing-decisions.md" ORCH_INSTALL_ROOT="$SCRATCH" \
  ORCH_PROC_ROOT="$SCRATCH/missing-proc" ORCH_DF_BIN=false "$SCRIPT_DIR/status.sh" > "$MISSING_OUT"
contains 'SKIP state DB or mission status unavailable' "$MISSING_OUT"
contains 'ram        SKIP' "$MISSING_OUT"
contains 'cpu        SKIP' "$MISSING_OUT"
contains 'disk       root     SKIP' "$MISSING_OUT"
contains 'SKIP nudge outbox absent' "$MISSING_OUT"
contains 'SKIP decisions file absent' "$MISSING_OUT"

printf 'observability tests: PASS\n'
