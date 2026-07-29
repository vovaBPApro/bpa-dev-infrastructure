#!/usr/bin/env bash
set -euo pipefail

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
report=$(mktemp "${TMPDIR:-/tmp}/bpa-soak-endurance-test-report.XXXXXX")
failure_report=''
fakebin=''
cleanup() { rm -f "$report" "$failure_report"; [ -z "$fakebin" ] || rm -rf -- "$fakebin"; }
trap cleanup EXIT

bash "$root/soak/soak-endurance.sh" --rounds 3 --lanes 6 --report "$report"
grep -Fq 'rounds: run=3 passed=3 failed=0' "$report"
grep -Fq 'first-failure: none' "$report"
grep -Fq 'round 1 snapshot before:' "$report"
grep -Fq 'round 1 snapshot after:' "$report"
grep -Fq 'round 2 snapshot before:' "$report"
grep -Fq 'round 2 snapshot after:' "$report"
grep -Fq 'round 3 snapshot before:' "$report"
grep -Fq 'round 3 snapshot after:' "$report"
grep -Fq 'resource-delta:' "$report"
grep -Fq 'worktrees=0 branches=0 processes=0' "$report"
grep -Fq 'tmp_dirs=0 active_leases=0' "$report"
grep -Fq 'overall: PASS' "$report"

failure_report=$(mktemp "${TMPDIR:-/tmp}/bpa-soak-endurance-failure-report.XXXXXX")
fakebin=$(mktemp -d "${TMPDIR:-/tmp}/bpa-soak-endurance-fake-bin.XXXXXX")
printf '%s\n' '#!/bin/sh' "if [ \"\${1:-}\" = \"$root/soak/soak.sh\" ]; then" "  printf '%s\\n' 'overall: FAIL'" '  exit 73' 'fi' 'exec /bin/bash "$@"' > "$fakebin/bash"
chmod +x "$fakebin/bash"
if PATH="$fakebin:$PATH" bash "$root/soak/soak-endurance.sh" --rounds 3 --lanes 6 --report "$failure_report"; then
  exit 1
fi
grep -Fq 'rounds: run=1 passed=0 failed=1' "$failure_report"
grep -Fq 'first-failure: 1 (round did not reach overall PASS)' "$failure_report"
grep -Fq 'overall: FAIL' "$failure_report"
