#!/usr/bin/env bash
# One parser for both the trusted landing gate and the clean-machine runner.
set -euo pipefail

usage() {
  printf 'Usage: meteorite/budget.sh --total <stage-budgets.tsv> [--require-exact <stage> ...]\n' >&2
}

[[ "${1:-}" == "--total" && -n "${2:-}" ]] || { usage; exit 2; }
budget_file="$2"
shift 2

required=()
if (($#)); then
  [[ "$1" == "--require-exact" ]] || { usage; exit 2; }
  shift
  (($#)) || { usage; exit 2; }
  required=("$@")
fi

[[ -r "$budget_file" ]] || {
  printf 'ERROR: meteorite stage budget is unreadable: %s\n' "$budget_file" >&2
  exit 1
}

awk -F '\t' -v required="${required[*]:-}" '
  function reject(message) {
    print "ERROR: invalid meteorite stage budget: " message > "/dev/stderr"
    bad = 1
  }
  /^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
  {
    if (NF != 2) { reject("line " NR " must contain stage<TAB>seconds"); next }
    stage = $1
    seconds = $2
    if (stage !~ /^(_overhead|[a-z0-9]+(-[a-z0-9]+)*)$/) {
      reject("unsupported stage name on line " NR ": " stage)
      next
    }
    if (seconds !~ /^[1-9][0-9]*$/) {
      reject("seconds must be a positive integer on line " NR ": " seconds)
      next
    }
    if (seen[stage]++) { reject("duplicate stage: " stage); next }
    budget[stage] = seconds + 0
    total += seconds
    count++
  }
  END {
    if (!count) reject("no stage rows")
    if (required != "") {
      required_count = split(required, names, " ")
      for (i = 1; i <= required_count; i++) {
        if (required_seen[names[i]]++) reject("required stage repeated by runner: " names[i])
        if (!(names[i] in budget)) reject("runner stage has no tracked budget: " names[i])
      }
      for (stage in budget) {
        if (stage != "_overhead" && !(stage in required_seen)) {
          reject("tracked stage is not executed by runner: " stage)
        }
      }
      if (!("_overhead" in budget)) reject("missing _overhead row")
    }
    if (bad) exit 1
    printf "%d\n", total
  }
' "$budget_file"
