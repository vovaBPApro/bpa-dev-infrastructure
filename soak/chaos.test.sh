#!/usr/bin/env bash
set -euo pipefail

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
report=$(mktemp "${TMPDIR:-/tmp}/bpa-chaos-test.XXXXXX")
trap 'rm -f -- "$report"' EXIT

CHAOS_SCENARIOS='dead-lane-no-report,conflict-in-batch,duplicate-contract-report,secret-mid-batch,disk-pressure-nudge,lease-fencing-under-restart' CHAOS_REPORT_FILE="$report" bash "$root/soak/chaos.sh"
grep -Fq 'CHAOS scenario=dead-lane-no-report verdict=PASS' "$report"
grep -Fq 'CHAOS scenario=conflict-in-batch verdict=PASS' "$report"
grep -Fq 'CHAOS scenario=lease-fencing-under-restart verdict=PASS' "$report"
grep -Fq 'CHAOS total=6 pass=6 fail=0' "$report"
