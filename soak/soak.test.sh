#!/usr/bin/env bash
set -euo pipefail

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
report=$(mktemp "${TMPDIR:-/tmp}/bpa-soak-test-report.XXXXXX")
trap 'rm -f "$report"' EXIT

SOAK_REPORT_FILE="$report" bash "$root/soak/soak.sh" 3
grep -Fq '| 1 |' "$report"
grep -Fq '| 2 |' "$report"
grep -Fq 'refused | secret-scan' "$report"
grep -Fq 'refused | completion-guard' "$report"
grep -Fq 'cleanup: worktrees=0 branches=0 processes=0' "$report"
grep -Fq 'overall: PASS' "$report"
