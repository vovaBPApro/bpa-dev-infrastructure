#!/usr/bin/env bash
# Recovery/replay lock: mission progress, not live-agent headcount, drives nudges.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRATCH="$(mktemp -d)"
SHIM="$SCRATCH/bin"
MISSION_CLI="${ORCH_MISSION_CLI:-$SCRIPT_DIR/../core/mission-cli.ts}"
trap 'rm -rf "$SCRATCH"' EXIT
mkdir -p "$SHIM"

# This recovery lane is reviewed before the independently owned state lane is
# integrated, so its default CLI does not exist at this SHA. Keep that seam
# explicit and rerunnable: integration removes this guard after core lands,
# while ORCH_MISSION_CLI still lets an exact compatible fixture exercise the
# full suite before then.
if [[ ! -f "$MISSION_CLI" ]]; then
  printf 'SKIP: watchdog mission progress tests require core/mission-cli.ts from v3-state; integrator must remove this guard after state lands\n'
  exit 0
fi

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
printf 'fixture 100 10 90 10%% /\n'
EOF
chmod +x "$SHIM/tmux" "$SHIM/df"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
contains() { grep -Fq -- "$1" "$2" || fail "missing: $1"; }
not_exists() { [[ ! -e "$1" ]] || fail "unexpected file: $1"; }
mission_id() { sed -nE 's/^MISSION id=([^ ]+) state=.*/\1/p'; }

create_mission() {
  local db="$1" correlation="$2" lane="$3" mission manager
  manager="manager-$lane"
  mission="$(INFRA_STATE_DB="$db" bun "$MISSION_CLI" mission create "$correlation" watchdog-acceptance | mission_id)"
  [[ -n "$mission" ]] || fail 'fixture mission ID missing'
  INFRA_STATE_DB="$db" bun "$MISSION_CLI" manager create "$mission" "$manager" >/dev/null
  INFRA_STATE_DB="$db" bun "$MISSION_CLI" lane create "$mission" "$manager" "$lane" watchdog-acceptance 1 >/dev/null
  printf '%s\n' "$mission"
}

seed_running() {
  local db="$1" mission="$2" lane="$3" with_lease="$4"
  INFRA_STATE_DB="$db" bun -e \
    'import { Database } from "bun:sqlite";
     const db = new Database(process.env.INFRA_STATE_DB);
     db.query("UPDATE missions SET state = ? WHERE id = ?").run("running", process.argv[1]);
     db.query("UPDATE lanes SET state = ? WHERE id = ?").run("running", process.argv[2]);
     if (process.argv[3] === "lease") {
       db.query("UPDATE lanes SET lease_owner = ?, fencing_token = ?, lease_deadline_at = ?, updated_at = ? WHERE id = ?")
         .run("fixture-owner", 1, Date.now() + 600000, Date.now(), process.argv[2]);
     }' "$mission" "$lane" "$with_lease"
}

run_watchdog() {
  local db="$1" runtime="$2" outbox="$3" now="$4" cli="${5:-$MISSION_CLI}"
  mkdir -p "$runtime"
  # ORCH_DONE_SENTINEL and ORCH_DAEMON_HEALTH_URL are NOT covered by
  # ORCH_RUNTIME_DIR: the rest sentinel lives under the daemon's state dir, and
  # the health probe defaults to the live daemon's URL. Ambient, a real /done
  # would make this whole suite pass without the watchdog doing anything.
  env PATH="$SHIM:$PATH" ORCH_CONFIG_FILE="$SCRATCH/no-config" ORCH_STATE_DB="$db" \
    ORCH_RUNTIME_DIR="$runtime" ORCH_WATCHDOG_LOG="$runtime/watchdog.log" \
    ORCH_DONE_SENTINEL="$SCRATCH/no-done-sentinel" ORCH_DAEMON_HEALTH_URL="" \
    ORCH_MISSION_CLI="$cli" \
    NUDGE_OUTBOX_FILE="$outbox" ORCH_INSTALL_ROOT="$SCRATCH" DISK_ALERT_PCT=99 \
    FLEET_IDLE_NUDGE_MS=1000 FLEET_NUDGE_REPEAT_MS=3600000 ORCH_WATCHDOG_NOW_MS="$now" \
    "$SCRIPT_DIR/watchdog.sh"
}

# A populated mission with an old completion signal is stalled. Its live lane
# lease is headcount only and must not suppress the real emitted decision.
STALLED_DB="$SCRATCH/stalled.db"
STALLED_OUTBOX="$SCRATCH/stalled.outbox"
stalled_mission="$(create_mission "$STALLED_DB" stalled-populated lane-stalled)"
seed_running "$STALLED_DB" "$stalled_mission" lane-stalled lease
stalled_updated="$(INFRA_STATE_DB="$STALLED_DB" bun -e \
  'import { Database } from "bun:sqlite";
   const db = new Database(process.env.INFRA_STATE_DB);
   console.log(Math.max(db.query("SELECT updated_at FROM missions").get().updated_at,
     db.query("SELECT updated_at FROM lanes").get().updated_at));')"
run_watchdog "$STALLED_DB" "$SCRATCH/stalled-runtime" "$STALLED_OUTBOX" "$(( stalled_updated + 10000 ))"
contains 'NUDGE mission=stalled-populated open_lanes=1 active=1 idle_ms=10000' "$STALLED_OUTBOX"

# A winding-down mission may have zero live agents. Recent lane progress is
# authoritative progress and must suppress a headcount-driven false escalation.
PROGRESS_DB="$SCRATCH/progress.db"
PROGRESS_OUTBOX="$SCRATCH/progress.outbox"
progress_mission="$(create_mission "$PROGRESS_DB" winding-down lane-progress)"
seed_running "$PROGRESS_DB" "$progress_mission" lane-progress no-lease
INFRA_STATE_DB="$PROGRESS_DB" bun -e \
  'import { Database } from "bun:sqlite";
   const db = new Database(process.env.INFRA_STATE_DB);
   const lane = db.query("SELECT updated_at FROM lanes WHERE id = ?").get("lane-progress");
   db.query("UPDATE missions SET updated_at = ? WHERE id = ?").run(lane.updated_at - 10000, process.argv[1]);' \
  "$progress_mission"
progress_updated="$(INFRA_STATE_DB="$PROGRESS_DB" bun -e \
  'import { Database } from "bun:sqlite";
   const db = new Database(process.env.INFRA_STATE_DB);
   console.log(Math.max(db.query("SELECT updated_at FROM missions").get().updated_at,
     db.query("SELECT updated_at FROM lanes").get().updated_at));')"
run_watchdog "$PROGRESS_DB" "$SCRATCH/progress-runtime" "$PROGRESS_OUTBOX" "$(( progress_updated + 100 ))"
not_exists "$PROGRESS_OUTBOX"

# The malformed snapshot starts as genuine mission-cli output, then removes
# one required field at the transport boundary. The watchdog must make the
# unmeasured subject visible instead of letting undefined become NaN/quiet.
MALFORMED_CLI="$SHIM/mission-cli-missing-updated-at.ts"
cat > "$MALFORMED_CLI" <<'EOF'
const args = Bun.argv.slice(2);
const result = Bun.spawnSync([process.env.BUN_REAL!, process.env.MISSION_CLI_REAL!, ...args], {
  env: process.env, stdout: "pipe", stderr: "inherit",
});
if (result.exitCode !== 0) process.exit(result.exitCode ?? 1);
if (args.length === 1 && args[0] === "status") {
  const status = JSON.parse(result.stdout.toString());
  delete status.lanes[0].updatedAt;
  console.log(JSON.stringify(status));
} else {
  process.stdout.write(result.stdout);
}
EOF
MALFORMED_RUNTIME="$SCRATCH/malformed-runtime"
export BUN_REAL="$(command -v bun)" MISSION_CLI_REAL="$MISSION_CLI"
run_watchdog "$STALLED_DB" "$MALFORMED_RUNTIME" "$SCRATCH/malformed.outbox" "$(( stalled_updated + 10000 ))" "$MALFORMED_CLI"
contains 'WATCHDOG NO-GO reason=mission-pressure-status-contract-invalid' "$MALFORMED_RUNTIME/watchdog.log"
not_exists "$SCRATCH/malformed.outbox"

printf 'watchdog mission progress tests: PASS\n'
