#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DISPATCHER="${MISSION_QUEUE_DISPATCH_UNDER_TEST:-$ROOT/tools/orchestrator/mission-queue-dispatch.sh}"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

pass() { printf 'PASS %s\n' "$1"; }
fail() { printf 'FAIL %s\n%s\n' "$1" "${2:-}" >&2; exit 1; }
assert_file() { [ -f "$1" ] || fail "$2" "missing $1"; }
assert_missing() { [ ! -e "$1" ] || fail "$2" "unexpected $1"; }
assert_equals() { [ "$1" = "$2" ] || fail "$3" "expected=$2 actual=$1"; }

runtime="$tmpdir/runtime"
bin="$tmpdir/bin"
launch_log="$tmpdir/launch.log"
mkdir -p "$runtime/manager-mission-queue" "$bin"

cat > "$bin/active-count" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "${TEST_ACTIVE_COUNT:-0}"
SH
cat > "$bin/active-coder-lane-count" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "${TEST_ACTIVE_CODER_LANES:-0}"
SH
cat > "$bin/launcher" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$1" >> "${TEST_LAUNCH_LOG:?}"
if [ "${TEST_CAP_REFUSED_MISSION:-}" = "$1" ]; then
  exit 75
fi
if [ "${TEST_FAIL_MISSION:-}" = "$1" ]; then
  exit 1
fi
if [ -n "${TEST_LAUNCH_SLEEP:-}" ]; then
  sleep "$TEST_LAUNCH_SLEEP"
fi
SH
chmod +x "$bin/active-count" "$bin/active-coder-lane-count" "$bin/launcher"

run_dispatcher() {
  env \
    DISPATCH_RUNTIME_DIR="$runtime" \
    MANAGER_LAUNCHER="$bin/launcher" \
    MANAGER_ACTIVE_COUNT_COMMAND="$bin/active-count" \
    CODER_LANE_ACTIVE_COUNT_COMMAND="$bin/active-coder-lane-count" \
    TEST_LAUNCH_LOG="$launch_log" \
    "$DISPATCHER" "$@"
}

printf 'z\n' > "$runtime/manager-mission-queue/20-zeta.md"
printf 'a\n' > "$runtime/manager-mission-queue/10-alpha.md"
printf 'plain\n' > "$runtime/manager-mission-queue/plain.md"
BPA_QUEUE_CAP=3 run_dispatcher
assert_equals "$(tr '\n' ' ' < "$launch_log")" 'alpha zeta plain ' 'numeric prefixes order launches and are stripped from mission ids'
assert_file "$runtime/manager-missions/alpha.md" 'prefixed first mission moves under its stripped mission id'
assert_file "$runtime/manager-missions/zeta.md" 'prefixed second mission moves under its stripped mission id'
assert_file "$runtime/manager-missions/plain.md" 'plain mission filename remains unchanged'
assert_missing "$runtime/manager-missions/10-alpha.md" 'manager missions do not retain numeric prefixes'
pass 'numeric-prefix-ordering-and-plain-filenames'

: > "$launch_log"
BPA_QUEUE_CAP=2 run_dispatcher
assert_equals "$(wc -c < "$launch_log" | tr -d ' ')" '0' 'empty queue does not launch'
pass 'empty-queue-noop'

printf 'bad\n' > "$runtime/manager-mission-queue/10-bad.md"
printf 'good\n' > "$runtime/manager-mission-queue/20-good.md"
: > "$launch_log"
TEST_FAIL_MISSION=bad BPA_QUEUE_CAP=2 run_dispatcher
assert_file "$runtime/manager-mission-failed/10-bad.md" 'failed launcher quarantines mission'
assert_file "$runtime/manager-missions/good.md" 'launch continues after failed mission'
assert_equals "$(tr '\n' ' ' < "$launch_log")" 'bad good ' 'failed mission does not stop ordered continuation'
pass 'failed-launch-quarantine-and-continuation'

printf 'retry\n' > "$runtime/manager-mission-queue/10-cap-refused.md"
: > "$launch_log"
TEST_CAP_REFUSED_MISSION=cap-refused BPA_QUEUE_CAP=1 run_dispatcher
assert_file "$runtime/manager-mission-queue/10-cap-refused.md" 'cap refusal requeues mission'
assert_missing "$runtime/manager-missions/cap-refused.md" 'cap refusal clears manager mission claim'
assert_missing "$runtime/manager-mission-failed/10-cap-refused.md" 'cap refusal never quarantines mission'
pass 'cap-refusal-requeues-without-quarantine'

for mission_number in $(seq -w 1 13); do
  printf '%s\n' "$mission_number" > "$runtime/manager-mission-queue/30-default-$mission_number.md"
done
: > "$launch_log"
unset BPA_QUEUE_CAP
run_dispatcher
assert_equals "$(wc -l < "$launch_log" | tr -d ' ')" '12' 'default queue cap launches twelve missions'
assert_file "$runtime/manager-mission-queue/30-default-13.md" 'default queue cap leaves thirteenth mission queued'
pass 'default-queue-cap-is-twelve'

width_status="$(TEST_ACTIVE_CODER_LANES=5 BPA_QUEUE_CAP=1 run_dispatcher --status)"
assert_equals "$(printf '%s\n' "$width_status" | head -n 1)" 'active=0 cap=1 queued=2 claimed=0 missions=16 failed=1 active_coder_lanes=5' 'status reports active coder lanes'
assert_equals "$(printf '%s\n' "$width_status" | tail -n 1)" 'WIDTH-LOW active_coder_lanes=5 floor=6 queued=2 claimed=0 missions=16' 'status warns when work exists below coder floor'
pass 'status-emits-width-low-below-coder-floor'

printf 'race\n' > "$runtime/manager-mission-queue/10-race.md"
: > "$launch_log"
(TEST_LAUNCH_SLEEP=1 BPA_QUEUE_CAP=1 run_dispatcher) &
first_pid=$!
sleep 0.1
BPA_QUEUE_CAP=1 run_dispatcher
wait "$first_pid"
assert_equals "$(wc -l < "$launch_log" | tr -d ' ')" '1' 'concurrent flock prevents double launch'
pass 'concurrent-flock-no-double-launch'

printf 'claim\n' > "$runtime/manager-mission-queue/10-claim.md"
: > "$launch_log"
(TEST_LAUNCH_SLEEP=1 BPA_QUEUE_CAP=1 run_dispatcher) &
claim_pid=$!
for _ in $(seq 1 50); do
  [ ! -e "$runtime/manager-mission-queue/10-claim.md" ] && break
  sleep 0.02
done
assert_missing "$runtime/manager-mission-queue/10-claim.md" 'claimed entry disappears atomically from queue'
for _ in $(seq 1 50); do
  [ -f "$runtime/manager-missions/claim.md" ] && break
  sleep 0.02
done
assert_file "$runtime/manager-missions/claim.md" 'claimed entry is available to launcher under its stripped mission id'
wait "$claim_pid"
pass 'atomic-claim-disappearance'
