#!/usr/bin/env bash
# Lane-exit gate: the exit-side mirror of orchestrator/dispatch-lane.sh.
#
# dispatch-lane.sh refuses to LAUNCH a lane whose prompt lacks the compose.ts
# pack marker. This script refuses to let a lane, or the orchestrator
# collecting its report, treat a lane as FINISHED while its terminal report
# is not contract-valid per gate/completion-guard.ts.
#
# Why this exists (instance/workboard.md V3-0.2, instance/decisions and the
# 2026-08-03 measurement): gate/completion-guard.ts previously ran ONLY from
# gate/land.sh, i.e. at landing time -- sessions or days after the lane that
# could have fixed its own report is gone. Of 1314 unmerged branches measured
# that day, exactly 6 satisfied the landing gate's own precondition (report
# `commit:` equal to the branch tip). This script moves the same check to the
# moment a lane declares itself done, so a bad report is caught while the
# lane (or the orchestrator right after it) can still fix it.
#
# This is a thin, honest forwarding wrapper: it does not weaken or duplicate
# completion-guard.ts's checks, it only resolves a trusted `bun` the same way
# gate/land.sh does (land_resolve_bun) and forwards the exit code unchanged:
#   0  report is contract-valid and clean               -> lane may end
#   2  contract violation (missing report, wrong shape,  -> lane is NOT done;
#      commit != branch tip, ...)                           fix and rerun
#   3  report is contract-valid and honestly NO-GO       -> lane may end
#      (a legitimate parked row per Hard Rule 13, not a violation)
#
# A lane's ROLE decides which contract applies. Without it this wrapper applied
# the coder contract to everything, so every reviewer lane -- which by design
# commits nothing and writes a review record instead of a coder report -- ended
# `state: failed reason: report-invalid` no matter how good its review was. The
# role is known at launch (orchestrator/fleet/launch-lane.sh --role) and was
# simply being dropped before the guard ran. Default stays `coder`, so an
# existing caller that passes no --role is unaffected.
#
# Usage: gate/lane-exit.sh --report <file> --repo <path> --branch <branch> [--role <role>]
set -u
set -o pipefail

usage() {
  echo "usage: gate/lane-exit.sh --report <file> --repo <path> --branch <branch> [--role coder|reviewer]" >&2
  exit 2
}

report=""
repo=""
branch=""
role="coder"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --report|--repo|--branch|--role)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then usage; fi
      case "$1" in
        --report) report="$2" ;;
        --repo) repo="$2" ;;
        --branch) branch="$2" ;;
        --role) role="$2" ;;
      esac
      shift 2
      ;;
    -h|--help) usage ;;
    *) usage ;;
  esac
done

# The launcher's role vocabulary is wider than the guard's; a lane that is not a
# reviewer is held to the coder contract, which is the pre-existing behaviour.
case "$role" in
  reviewer) ;;
  coder|orchestrator|manager) role="coder" ;;
  *) usage ;;
esac

if [ -z "$report" ] || [ -z "$repo" ] || [ -z "$branch" ]; then usage; fi

script_dir=$(CDPATH='' cd "$(dirname "$0")" && pwd)
# shellcheck source=gate/land-lib.sh
# shellcheck disable=SC1091
source "$script_dir/land-lib.sh"
if ! land_resolve_bun; then
  echo "LANE-EXIT verdict=blocked step=preflight" >&2
  exit 2
fi

# Decisions-ledger state (V3-3.1). The same check gate/land.sh runs, moved to
# the moment a lane declares itself done -- the same reasoning that put
# completion-guard.ts here rather than only at landing time: a red ledger is
# cheapest to fix while the lane that reddened it still exists.
#
# Unpiped, and $? read directly, because a bounded or killed command behind a
# pipe reports the LAST element's status: `check | tail` would report tail's
# success and launder a failure into a pass.
#
# Scoped on `git ls-files`, not on `[[ -f ]]`. This gate is generic -- it must
# also land lanes in a product repo that never carried this control plane's
# instruction tooling -- but a filesystem-existence guard is the fail-open shape
# this repository keeps getting burned by: deleting the checker would silently
# skip the check. Keyed on TRACKED-ness, removing it is a diff on evidence-gate
# logic, which needs Tier-A review; and a tracked-but-deleted file still runs
# and still fails.
if git -C "$repo" ls-files --error-unmatch tools/instructions/check.ts >/dev/null 2>&1; then
  "$BUN_BIN" "$repo/tools/instructions/check.ts" --repo "$repo" --strict
  ledger_status=$?
  if [ "$ledger_status" -ne 0 ]; then
    echo "LANE-EXIT verdict=blocked role=$role step=ledger-state repo=$repo exit=$ledger_status" >&2
    exit 2
  fi
else
  echo "LANE-EXIT step=ledger-state status=not-applicable reason=repo-does-not-track-tools/instructions/check.ts"
fi

"$BUN_BIN" "$script_dir/completion-guard.ts" --report "$report" --repo "$repo" --branch "$branch" --role "$role"
status=$?

if [ "$status" -eq 0 ] || [ "$status" -eq 3 ]; then
  echo "LANE-EXIT verdict=clear role=$role report=$report branch=$branch exit=$status"
  exit "$status"
fi

echo "LANE-EXIT verdict=blocked role=$role report=$report branch=$branch exit=$status" >&2
exit "$status"
