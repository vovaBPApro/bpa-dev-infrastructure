#!/usr/bin/env bash
set -euo pipefail

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
report=$(mktemp "${TMPDIR:-/tmp}/bpa-soak-endurance-test-report.XXXXXX")
cleanup() { rm -f "$report"; }
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
