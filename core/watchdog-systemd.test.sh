#!/usr/bin/env bash
set -euo pipefail

ROOT="${GAP5_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
TOKEN="gap5-$BASHPID-$RANDOM"
UNIT="bpa-watchdog-$TOKEN.service"
SCRATCH="$(mktemp -d "$ROOT/.gap5-systemd.XXXXXX")"
FRAGMENT="/run/systemd/system/$UNIT"
DB="$SCRATCH/state.db"
BACKUP="$SCRATCH/state.backup.db"
cleaned=0

cleanup() {
  systemctl stop "$UNIT" >/dev/null 2>&1 || true
  rm -f "$FRAGMENT"
  systemctl daemon-reload >/dev/null 2>&1 || true
  rm -rf "$SCRATCH"
  cleaned=1
}
trap cleanup EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
invocation() { systemctl show "$UNIT" --property=InvocationID --value; }
account() {
  local args=(--intervals "$1")
  [[ "$1" == all ]] && args=(--all yes)
  ORCH_WATCHDOG_UNIT="$UNIT" ORCH_WATCHDOG_FRAGMENT="$FRAGMENT" \
    INFRA_STATE_DB="$DB" bun "$ROOT/core/tick-journal-cli.ts" account "${args[@]}"
}

SYSTEM_STATE="$(systemctl is-system-running 2>/dev/null || true)"
[[ "$SYSTEM_STATE" == running || "$SYSTEM_STATE" == degraded ]] || fail 'real systemd manager unavailable'
mkdir -p "$SCRATCH/orchestrator"
printf 'fixture only\n' > "$SCRATCH/runtime.env"
cat > "$SCRATCH/orchestrator/watchdog.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export ORCH_WATCHDOG_UNIT="$UNIT" ORCH_WATCHDOG_FRAGMENT="$FRAGMENT" INFRA_STATE_DB="$DB"
bun "$ROOT/core/tick-journal-cli.ts" reconcile --cadence-ms 1000 --observed-at "\${FIXTURE_OBSERVED_AT}"
bun "$ROOT/core/tick-journal-cli.ts" record --interval "\${FIXTURE_INTERVAL}" --cause fixture --observed-at "\${FIXTURE_OBSERVED_AT}"
sleep 10
EOF
chmod +x "$SCRATCH/orchestrator/watchdog.sh"
sed -e "s|\$INSTALL_ROOT|$SCRATCH|g" -e "s|\$ENV_FILE|$SCRATCH/runtime.env|g" \
  -e "s|bpa-orchestrator-watchdog.service|$UNIT|g" \
  "$ROOT/bootstrap/units/bpa-orchestrator-watchdog.service.in" > "$FRAGMENT"
systemctl daemon-reload

systemctl set-environment FIXTURE_OBSERVED_AT=1000 FIXTURE_INTERVAL=known-1
systemctl start --no-block "$UNIT"
for _ in {1..50}; do [[ -s "$DB" ]] && break; sleep 0.1; done
FIRST="$(invocation)"
[[ "$FIRST" =~ ^[0-9a-f]{32}$ ]] || fail 'first InvocationID unavailable'
account all | grep -q '"verdict":"clean"' || fail 'live producer accounting was not clean'
cp "$DB" "$BACKUP"

systemctl set-environment FIXTURE_OBSERVED_AT=2000 FIXTURE_INTERVAL=known-2
systemctl stop "$UNIT"
systemctl start --no-block "$UNIT"
for _ in {1..50}; do SECOND="$(invocation)"; [[ -n "$SECOND" && "$SECOND" != "$FIRST" ]] && break; sleep 0.1; done
SECOND="$(invocation)"
[[ "$SECOND" =~ ^[0-9a-f]{32}$ && "$SECOND" != "$FIRST" ]] || fail 'restart did not create a new InvocationID'
for _ in {1..50}; do
  [[ "$(bun -e 'import {Database} from "bun:sqlite"; const d=new Database(process.argv[1]); console.log(d.query("SELECT count(*) AS n FROM tick_journal WHERE interval_id=?").get("known-2").n)' "$DB")" == 2 ]] && break
  sleep 0.1
done
bun -e 'import {Database} from "bun:sqlite"; const d=new Database(process.argv[1]); d.query("UPDATE tick_producer_state SET invocation_id=? WHERE producer_id=?").run(process.argv[2],"bpa-orchestrator-watchdog"); d.close()' "$DB" "$FIRST"
STORED="$(bun -e 'import {Database} from "bun:sqlite"; const d=new Database(process.argv[1]); console.log(d.query("SELECT invocation_id FROM tick_producer_state WHERE producer_id=?").get("bpa-orchestrator-watchdog").invocation_id)' "$DB")"
[[ "$STORED" == "$FIRST" && "$STORED" != "$SECOND" ]] || fail 'stale producer fixture was not established'
CURRENT="$(invocation)"
[[ "$CURRENT" == "$SECOND" ]] || fail "systemd epoch moved unexpectedly current=$CURRENT second=$SECOND"
if account known-1 >"$SCRATCH/stale.out" 2>&1; then fail 'stale producer epoch replay was accepted'; fi
grep -q 'stored watchdog producer epoch is stale' "$SCRATCH/stale.out" || fail "stale epoch refusal was not explicit: $(tr '\n' ' ' < "$SCRATCH/stale.out")"

# The restarted producer reconciles the deliberately skipped 2s/3s ticks, then
# records a known cause in its new epoch. Historical accounting is authoritative
# only after that live producer proof refreshed tick_producer_state.
bun -e 'import {Database} from "bun:sqlite"; const d=new Database(process.argv[1]); d.query("UPDATE tick_producer_state SET invocation_id=? WHERE producer_id=?").run(process.argv[2],"bpa-orchestrator-watchdog"); d.close()' "$DB" "$SECOND"
account all >"$SCRATCH/new.out" 2>&1
grep -q '"verdict":"clean"' "$SCRATCH/new.out" || fail "new producer epoch was not measurable: $(tr '\n' ' ' < "$SCRATCH/new.out")"

bun -e 'import {Database} from "bun:sqlite"; const d=new Database(process.argv[1]); d.query("INSERT INTO tick_journal(interval_id,cause_id,kind,observed_at,created_at,source_id) VALUES (?,?,?,?,?,?)").run("partial","only-miss","missed-tick",1,1,"partial")' "$DB"
if account partial >/dev/null 2>&1; then fail 'partial journal row was accepted'; fi
printf 'not sqlite\n' > "$SCRATCH/corrupt.db"
if INFRA_STATE_DB="$SCRATCH/corrupt.db" bun "$ROOT/core/tick-journal-cli.ts" integrity >/dev/null 2>&1; then fail 'corrupt database was accepted'; fi

cp "$BACKUP" "$DB"
ORCH_WATCHDOG_UNIT="$UNIT" ORCH_WATCHDOG_FRAGMENT="$FRAGMENT" INFRA_STATE_DB="$DB" \
  bun "$ROOT/core/tick-journal-cli.ts" integrity | grep -qx ok || fail 'rollback database did not reconstruct'

cleanup
trap - EXIT
[[ "$cleaned" == 1 && ! -e "$FRAGMENT" && ! -e "$SCRATCH" ]] || fail 'fixture paths remain after cleanup'
[[ "$(systemctl show "$UNIT" --property=LoadState --value)" == not-found ]] || fail 'fixture unit remains loaded after cleanup'
printf 'watchdog real-systemd matrix: PASS (start missed-tick restart stale-replay corruption partial cleanup rollback zero-residuals)\n'
