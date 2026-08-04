#!/usr/bin/env bash
# Reviewer-artifact contract check, as a command.
#
# This exists so gate/completion-guard.ts can apply the SAME review-artifact
# rules the landing gate applies, without owning a second copy of them. The
# rules live in one place -- land_review_artifact_contract() in
# gate/land-lib.sh -- and this script is a thin adapter that runs that function
# and prints its verdict in a stable, parseable form.
#
# Why a shell adapter rather than a TypeScript reimplementation: the landing
# gate is bash and the exit guard is TypeScript, and V3-0.39 / V3-0.50 record
# what happens when one contract grows two implementations that are never
# executed against each other. Crossing the language boundary once, here, is
# cheaper than keeping two copies honest forever.
#
# Usage: gate/review-artifact-check.sh --artifact <file> [--mode exit|landing]
#                                      [--repo <path>] [--branch <name>]
#                                      [--report-sha <sha>]
#
# Exit codes:
#   0  artifact satisfies the contract
#   2  artifact violates the contract (a code naming the violation is printed)
set -u
set -o pipefail

usage() {
  echo "usage: gate/review-artifact-check.sh --artifact <file> [--mode exit|landing] [--repo <path>] [--branch <name>] [--report-sha <sha>]" >&2
  exit 2
}

artifact=""
mode="exit"
repo=""
branch=""
report_sha=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --artifact|--mode|--repo|--branch|--report-sha)
      if [ "$#" -lt 2 ]; then usage; fi
      case "$1" in
        --artifact) artifact="$2" ;;
        --mode) mode="$2" ;;
        --repo) repo="$2" ;;
        --branch) branch="$2" ;;
        --report-sha) report_sha="$2" ;;
      esac
      shift 2
      ;;
    -h|--help) usage ;;
    *) usage ;;
  esac
done

if [ -z "$artifact" ]; then usage; fi
case "$mode" in
  exit|landing) ;;
  *) usage ;;
esac

script_dir=$(CDPATH='' cd "$(dirname "$0")" && pwd)
# shellcheck source=gate/land-lib.sh
# shellcheck disable=SC1091
source "$script_dir/land-lib.sh"

# Called directly, NOT through $(...): the contract publishes its result in
# globals, and a command substitution would run it in a subshell and lose them.
if land_review_artifact_contract "$artifact" "$mode" "$repo" "$branch" "$report_sha"; then
  printf 'REVIEW-ARTIFACT verdict=valid decision=%s file=%s\n' \
    "${LAND_REVIEW_FIELD_VERDICT:-unknown}" "$artifact"
  exit 0
fi

printf 'REVIEW-ARTIFACT verdict=invalid code=%s file=%s\n' "${LAND_REVIEW_CONTRACT_CODE:-unknown}" "$artifact"
exit 2
