#!/usr/bin/env bash
set -euo pipefail

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
report=""
cleanup() { [ -z "$report" ] || rm -f "$report"; }
trap cleanup EXIT

assert_soak() {
  local lanes=$1 good_count landed_count
  report=$(mktemp "${TMPDIR:-/tmp}/bpa-soak-test-report.XXXXXX")
  SOAK_REPORT_FILE="$report" bash "$root/soak/soak.sh" "$lanes"
  good_count=$((lanes - 2))
  landed_count=$(grep -c '| [0-9][0-9]* | [0-9][0-9]* | landed |' "$report")
  [ "$landed_count" -eq "$good_count" ]
  grep -Fq 'refused | secret-scan' "$report"
  grep -Fq 'refused | completion-guard' "$report"
  grep -Fq 'cleanup: worktrees=0 branches=0 processes=0' "$report"
  grep -Fq 'overall: PASS' "$report"
}

assert_soak 3
rm -f "$report"
report=""
# This concurrent case regression-locks freshness rebase/retry: pre-fix it
# lands only one of these four good lanes.
assert_soak 6
