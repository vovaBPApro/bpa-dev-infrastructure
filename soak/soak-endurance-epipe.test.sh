#!/usr/bin/env bash
set -euo pipefail

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
test_root=$(mktemp -d "${TMPDIR:-/tmp}/bpa-endurance-epipe.XXXXXX")
trap 'rm -rf -- "$test_root"' EXIT

cat >"$test_root/round" <<'EOF'
#!/bin/sh
echo "$SOAK_RUN_TOKEN" >>"$SOAK_TEST_ROUNDS"
echo 'overall: PASS'
EOF
cat >"$test_root/zero-probe" <<'EOF'
#!/bin/sh
echo 0
EOF
chmod +x "$test_root/round" "$test_root/zero-probe"

report="$test_root/report"
round_log="$test_root/rounds"
set +e
SOAK_TEST_ROUNDS="$round_log" SOAK_ROUND_COMMAND="$test_root/round" \
  SOAK_DOCKER_PROBE=/bin/true SOAK_EXTERNAL_PROBE=/bin/true \
  SOAK_RSS_PROBE="$test_root/zero-probe" SOAK_LEASE_PROBE="$test_root/zero-probe" \
  SOAK_ROUND_TIMEOUT_SECONDS=2 \
  bash "$root/soak/soak-endurance.sh" --rounds 3 --lanes 6 --report "$report" |
  head -c 1 >/dev/null
harness_status=${PIPESTATUS[0]}
set -e

[ "$harness_status" -eq 0 ] || {
  echo "harness exited after stdout EPIPE: $harness_status" >&2
  exit 1
}
[ "$(wc -l <"$round_log")" -eq 3 ]
grep -Fq 'rounds: run=3 passed=3 failed=0' "$report"
grep -Fq 'overall: PASS' "$report"

stats_harness="$test_root/soak-endurance-stats"
sed '/^timings=()$/a mapfile -t timings < <(seq 1 20000)' \
  "$root/soak/soak-endurance.sh" >"$stats_harness"
chmod +x "$stats_harness"

stats_report="$test_root/stats-report"
stats_stderr="$test_root/stats-stderr"
set +e
SOAK_TEST_ROUNDS="$round_log" SOAK_ROUND_COMMAND="$test_root/round" \
  SOAK_DOCKER_PROBE=/bin/true SOAK_EXTERNAL_PROBE=/bin/true \
  SOAK_RSS_PROBE="$test_root/zero-probe" SOAK_LEASE_PROBE="$test_root/zero-probe" \
  SOAK_ROUND_TIMEOUT_SECONDS=2 \
  bash "$stats_harness" --rounds 1 --lanes 6 --report "$stats_report" \
  2>"$stats_stderr" | head -c 1 >/dev/null
stats_status=${PIPESTATUS[0]}
set -e

[ "$stats_status" -eq 0 ] || {
  cat "$stats_stderr" >&2
  echo "harness exited during large timing stats emission: $stats_status" >&2
  exit 1
}
if grep -Fq 'write error: Broken pipe' "$stats_stderr"; then
  cat "$stats_stderr" >&2
  echo 'harness reported EPIPE during large timing stats emission' >&2
  exit 1
fi
grep -Eq '^timing-ms: min=[0-9]+ median=[0-9]+ max=20000 last=[0-9]+$' "$stats_report"
grep -Fq 'rounds: run=1 passed=1 failed=0' "$stats_report"
grep -Fq 'overall: PASS' "$stats_report"

echo 'soak endurance EPIPE: PASS'
