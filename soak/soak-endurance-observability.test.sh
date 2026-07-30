#!/usr/bin/env bash
set -euo pipefail

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
test_root=$(mktemp -d "${TMPDIR:-/tmp}/bpa-endurance-observability.XXXXXX")
[ -n "$test_root" ] || {
  echo 'test run directory is empty' >&2
  exit 1
}
round_pid_file="$test_root/round.pid"
harness_pid=''

cleanup() {
  if [ -n "$harness_pid" ]; then
    kill -TERM "$harness_pid" 2>/dev/null || true
    wait "$harness_pid" 2>/dev/null || true
  fi
  if [ -f "$round_pid_file" ]; then
    kill -KILL "$(cat "$round_pid_file")" 2>/dev/null || true
  fi
  rm -rf -- "$test_root"
}
trap cleanup EXIT

cat >"$test_root/hung-round" <<'EOF'
#!/bin/sh
echo "$$" >"$SOAK_TEST_ROOT/round.pid"
echo 'overall: PASS'
while :; do sleep 1; done
EOF
chmod +x "$test_root/hung-round"

cat >"$test_root/zero-probe" <<'EOF'
#!/bin/sh
echo 0
EOF
chmod +x "$test_root/zero-probe"

wait_for_file_text() {
  local file=$1 text=$2 attempts=${3:-50}
  while [ "$attempts" -gt 0 ]; do
    [ -f "$file" ] && grep -Fq "$text" "$file" && return 0
    attempts=$((attempts - 1))
    sleep 0.05
  done
  return 1
}

wait_for_live_round() {
  local attempts=100 candidate=''
  while [ "$attempts" -gt 0 ]; do
    if [ -s "$round_pid_file" ]; then
      IFS= read -r candidate <"$round_pid_file" || candidate=''
      case "$candidate" in
        *[!0-9]* | '') candidate='' ;;
      esac
      if [ -n "$candidate" ] && kill -0 "$candidate" 2>/dev/null; then
        round_pid=$candidate
        return 0
      fi
    fi
    attempts=$((attempts - 1))
    sleep 0.05
  done
  echo "round pid did not become live: $round_pid_file" >&2
  return 1
}

run_harness() {
  local report=$1 output=$2 timeout=$3
  SOAK_TEST_ROOT="$test_root" SOAK_ROUND_COMMAND="$test_root/hung-round" \
    SOAK_ROUND_TIMEOUT_SECONDS="$timeout" SOAK_DOCKER_PROBE=/bin/true \
    SOAK_EXTERNAL_PROBE=/bin/true SOAK_RSS_PROBE="$test_root/zero-probe" \
    SOAK_LEASE_PROBE="$test_root/zero-probe" \
    bash "$root/soak/soak-endurance.sh" --rounds 2 --lanes 6 --report "$report" >"$output" 2>&1 &
  harness_pid=$!
}

# Case A: progress and a partial report precede the timeout; timeout is bounded
# and cleans the round's owned process group.
timeout_report="$test_root/timeout-report"
timeout_output="$test_root/timeout-output"
run_harness "$timeout_report" "$timeout_output" 2
wait_for_file_text "$timeout_output" 'round 1 started' 20
wait_for_file_text "$timeout_report" 'last-verdict: started' 20
wait_for_live_round
set +e
wait "$harness_pid"
timeout_status=$?
set -e
harness_pid=''
[ "$timeout_status" -ne 0 ]
grep -Fq 'round 1 FAIL (round timeout)' "$timeout_output"
grep -Fq 'first-failure: 1 (round timeout)' "$timeout_report"
grep -Fq 'rounds: run=1 passed=0 failed=1' "$timeout_report"
grep -Fq 'overall: FAIL' "$timeout_report"
if kill -0 "$round_pid" 2>/dev/null; then
  echo "round process survived timeout: $round_pid" >&2
  exit 1
fi

# Case B: TERM during a controlled hung round leaves explicit interrupted,
# incomplete evidence with the last completed-round count.
rm -f -- "$round_pid_file"
term_report="$test_root/term-report"
term_output="$test_root/term-output"
run_harness "$term_report" "$term_output" 30
wait_for_file_text "$term_output" 'round 1 started' 20
wait_for_file_text "$term_report" 'last-verdict: started' 20
wait_for_live_round
kill -TERM "$harness_pid"
set +e
wait "$harness_pid"
term_status=$?
set -e
harness_pid=''
[ "$term_status" -ne 0 ]
grep -Fq 'state: incomplete' "$term_report"
grep -Fq 'interrupted: TERM' "$term_report"
grep -Fq 'rounds: run=0 passed=0 failed=0' "$term_report"
if kill -0 "$round_pid" 2>/dev/null; then
  echo "round process survived harness TERM: $round_pid" >&2
  exit 1
fi

echo 'soak endurance observability: PASS'
