#!/usr/bin/env bash
# Recovery/replay lock: mission progress, not live-agent headcount, drives nudges.
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
printf 'fixture 100 10 90 10%% /\n'
EOF
chmod +x "$SHIM/tmux" "$SHIM/df"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
contains() { grep -Fq -- "$1" "$2" || fail "missing: $1"; }
not_exists() { [[ ! -e "$1" ]] || fail "unexpected file: $1"; }
mission_id() { sed -nE 's/^MISSION id=([^ ]+) state=.*/\1/p'; }

create_mission() {
  local db="$1" correlation="$2" lane="$3" mission
  mission="$(INFRA_STATE_DB="$db" bun "$SCRIPT_DIR/../core/mission-cli.ts" mission create "$correlation" | mission_id)"
  [[ -n "$mission" ]] || fail 'fixture mission ID missing'
  INFRA_STATE_DB="$db" bun "$SCRIPT_DIR/../core/mission-cli.ts" lane create "$mission" "$lane" >/dev/null
  printf '%s\n' "$mission"
}

run_watchdog() {
  local db="$1" runtime="$2" outbox="$3" now="$4"
  mkdir -p "$runtime"
  env PATH="$SHIM:$PATH" ORCH_CONFIG_FILE="$SCRATCH/no-config" ORCH_STATE_DB="$db" \
    ORCH_RUNTIME_DIR="$runtime" ORCH_WATCHDOG_LOG="$runtime/watchdog.log" \
    NUDGE_OUTBOX_FILE="$outbox" ORCH_INSTALL_ROOT="$SCRATCH" DISK_ALERT_PCT=99 \
    FLEET_IDLE_NUDGE_MS=1000 FLEET_NUDGE_REPEAT_MS=3600000 ORCH_WATCHDOG_NOW_MS="$now" \
    "$SCRIPT_DIR/watchdog.sh"
}

# A populated mission with an old completion signal is stalled. Its live lane
# lease is headcount only and must not suppress the real emitted decision.
STALLED_DB="$SCRATCH/stalled.db"
STALLED_OUTBOX="$SCRATCH/stalled.outbox"
stalled_mission="$(create_mission "$STALLED_DB" stalled-populated lane-stalled)"
INFRA_STATE_DB="$STALLED_DB" bun "$SCRIPT_DIR/../core/mission-cli.ts" mission transition "$stalled_mission" running >/dev/null
INFRA_STATE_DB="$STALLED_DB" bun "$SCRIPT_DIR/../core/mission-cli.ts" lease acquire worker lane-stalled 600000 >/dev/null
stalled_updated="$(INFRA_STATE_DB="$STALLED_DB" bun "$SCRIPT_DIR/../core/mission-cli.ts" status | bun -e \
  'const s=JSON.parse(await Bun.stdin.text()); console.log(Math.max(s.missions[0].updatedAt, ...s.lanes.map((lane) => lane.updatedAt)));')"
run_watchdog "$STALLED_DB" "$SCRATCH/stalled-runtime" "$STALLED_OUTBOX" "$(( stalled_updated + 10000 ))"
contains 'NUDGE mission=stalled-populated open_lanes=1 active=1 idle_ms=10000' "$STALLED_OUTBOX"

# A winding-down mission may have zero live agents. Recent lane progress is
# authoritative progress and must suppress a headcount-driven false escalation.
PROGRESS_DB="$SCRATCH/progress.db"
PROGRESS_OUTBOX="$SCRATCH/progress.outbox"
progress_mission="$(create_mission "$PROGRESS_DB" winding-down lane-progress)"
INFRA_STATE_DB="$PROGRESS_DB" bun "$SCRIPT_DIR/../core/mission-cli.ts" mission transition "$progress_mission" running >/dev/null
INFRA_STATE_DB="$PROGRESS_DB" bun "$SCRIPT_DIR/../core/mission-cli.ts" lane transition lane-progress running >/dev/null
INFRA_STATE_DB="$PROGRESS_DB" bun -e \
  'import { Database } from "bun:sqlite";
   const db = new Database(process.env.INFRA_STATE_DB);
   const lane = db.query("SELECT updated_at FROM lanes WHERE id = ?").get("lane-progress");
   db.query("UPDATE missions SET updated_at = ? WHERE id = ?").run(lane.updated_at - 10000, process.argv[1]);' \
  "$progress_mission"
progress_updated="$(INFRA_STATE_DB="$PROGRESS_DB" bun "$SCRIPT_DIR/../core/mission-cli.ts" status | bun -e \
  'const s=JSON.parse(await Bun.stdin.text()); console.log(Math.max(s.missions[0].updatedAt, ...s.lanes.map((lane) => lane.updatedAt)));')"
run_watchdog "$PROGRESS_DB" "$SCRATCH/progress-runtime" "$PROGRESS_OUTBOX" "$(( progress_updated + 100 ))"
not_exists "$PROGRESS_OUTBOX"

printf 'watchdog mission progress tests: PASS\n'
