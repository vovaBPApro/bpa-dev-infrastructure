#!/usr/bin/env bash
# Pre-push guard: refuse a push the landing gate's baseline step would refuse.
#
# WHY THIS EXISTS
# Twice on 2026-08-05 the orchestrator pushed a red `main`. The second time it
# changed the fleet cap, verified with three targeted commands -- check-fleet-cap.ts,
# the ledger checker, fleet-nudge.test.sh -- and every one was green.
# daemon/autonomy-keepalive.test.ts asserted the old cap number and was red. `main`
# stayed broken until a landing hit `LAND BASELINE framework-check=test status=fail`,
# and that landing aborted for a defect in neither the lane nor its work.
#
# The pattern, stated precisely: a targeted check is a hint, and it was treated as
# verification of a commit. The landing gate already knows the difference. This moves
# that knowledge earlier, to before the push.
#
# WHAT IT RUNS -- and it is deliberately not cheaper
# Exactly land_run_declared_checks(), the function gate/land.sh:629 calls for its
# BASELINE step, with the same arguments the gate passes there:
#   1. `bun build --no-bundle` over every tracked .js/.jsx/.mjs/.cjs/.ts/.tsx (parse)
#   2. `bun test` over every tracked *.test.* / *.spec.* / *_test.* / *_spec.* file,
#      through an immutable explicit file list and an empty config outside the tree
#   3. the root package.json `lint` and `test` scripts, if declared
# It is NOT a reimplementation and NOT a subset. A guard with its own idea of "the
# suite" drifts from the gate and becomes another thing that passes while the gate
# refuses -- the exact defect class this repository has spent the week cataloguing.
#
# So it costs what the gate's baseline costs: on this repository, minutes, not
# seconds. That is a real trade and it is stated rather than hidden, because the
# faster-but-weaker check is precisely the mistake being guarded against. Do not
# run it on every commit; run it before a push, which is what it is named for.
#
# It also refuses a dirty tracked tree, because the checks run the working tree
# while the push sends HEAD; see the tree section below for why that is a
# correctness requirement and not a tidiness one.
#
# Usage:
#   gate/push-guard.sh [--repo <path>]                  # check only
#   gate/push-guard.sh [--repo <path>] -- <command...>  # run <command> only if it passes
#
# The second form is the one to use, so that "guarded" and "pushed" are a single
# command rather than two the orchestrator has to remember to pair:
#   gate/push-guard.sh -- git push origin main
#
# This is a command the orchestrator invokes. It is deliberately NOT a git hook:
# the operator must be able to see what ran.
#
# Break-glass: PUSH_GUARD_OVERRIDE=<reason> skips the checks. Mirrors
# dispatch-check.ts's DISPATCH_OVERRIDE and launch.sh's ORCH_SKIP_SESSION_HOOK --
# one explicit greppable variable, refused when set-but-empty, journaled to
# orchestrator/runtime/ops-journal.log on every use, announced on stderr. It exists
# because there are legitimate pushes that cannot wait for a full suite -- a hotfix
# to an already-broken `main` being the obvious one -- and a guard with no escape
# gets disabled rather than used.
#
# Exit codes:
#   0  allowed (or, with `-- <command>`, the command's own status)
#   1  refused: a baseline check failed (the failing check is named)
#   2  usage error
#   3  refused: preflight could not run the checks at all
#   4  refused: break-glass was set but empty, or could not be journaled
set -u
set -o pipefail

usage() {
  echo "usage: gate/push-guard.sh [--repo <path>] [-- <command> [args...]]" >&2
  exit 2
}

repo=""
declare -a run_command=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then usage; fi
      repo="$2"
      shift 2
      ;;
    --)
      shift
      run_command=("$@")
      break
      ;;
    -h|--help) usage ;;
    *) usage ;;
  esac
done

script_dir=$(CDPATH='' cd "$(dirname "$0")" && pwd)
if [ -z "$repo" ]; then repo=$(CDPATH='' cd "$script_dir/.." && pwd); fi
if [ ! -d "$repo" ] || ! git -C "$repo" rev-parse --git-dir >/dev/null 2>&1; then
  echo "PUSH-GUARD verdict=refused reason=preflight detail=not-a-git-repository repo=$repo" >&2
  exit 3
fi
repo=$(CDPATH='' cd "$repo" && pwd)

if [ "${#run_command[@]}" -gt 0 ] && [ -z "${run_command[0]//[[:space:]]/}" ]; then usage; fi

prefix='PUSH-GUARD BASELINE'

# Runs $command when one was given, and otherwise just reports. Called on every
# allowed path so that "allowed" has exactly one meaning.
guard_allow() {
  if [ "${#run_command[@]}" -eq 0 ]; then
    exit 0
  fi
  echo "PUSH-GUARD running: ${run_command[*]}"
  exec "${run_command[@]}"
}

# --- break-glass -------------------------------------------------------------
# Handled before the checks: its whole purpose is to work when they cannot.
OPS_JOURNAL="${ORCH_OPS_JOURNAL:-$repo/orchestrator/runtime/ops-journal.log}"

journal_override() {
  local reason="$1" ts encoded
  mkdir -p "$(dirname "$OPS_JOURNAL")" 2>/dev/null || return 1
  ts="$(date --iso-8601=seconds)" || return 1
  # JSON-escape the reason so a newline in it cannot forge a second journal row.
  encoded="$(printf '%s' "$reason" | "$BUN_BIN" -e '
process.stdout.write(JSON.stringify(await Bun.stdin.text()));
')" || return 1
  [ -n "$encoded" ] || return 1
  printf '%s\tPUSH_GUARD_OVERRIDE\trepo=%s\tcommand=%s\treason=%s\n' \
    "$ts" "$repo" "${run_command[*]:-none}" "$encoded" >> "$OPS_JOURNAL" || return 1
  return 0
}

# --- preflight ---------------------------------------------------------------
# land_resolve_bun() exports BUN_BIN and LAND_CHECK_PATH from a fixed host
# baseline and refuses a caller-supplied BUN_BIN. Both the checks and the
# override journal need it, so it runs before either.
# shellcheck source=gate/land-lib.sh
# shellcheck disable=SC1091
source "$script_dir/land-lib.sh"

preflight_log=$(mktemp "${TMPDIR:-/tmp}/bpa-push-guard-preflight.XXXXXX") || {
  echo "PUSH-GUARD verdict=refused reason=preflight detail=scratch-allocation-failed" >&2
  exit 3
}
land_resolve_bun 2>"$preflight_log"
preflight_status=$?
cat "$preflight_log" >&2
if [ "$preflight_status" -ne 0 ]; then
  detail=$(sed -nE 's/.*[[:space:]]detail=([^[:space:]]+).*/\1/p' "$preflight_log" | tail -n 1)
  rm -f "$preflight_log"
  echo "PUSH-GUARD verdict=refused reason=preflight detail=${detail:-bun-unresolvable}" >&2
  exit 3
fi
rm -f "$preflight_log"

if [ -n "${PUSH_GUARD_OVERRIDE+set}" ]; then
  override_reason="$PUSH_GUARD_OVERRIDE"
  if [ -z "${override_reason//[[:space:]]/}" ]; then
    echo "PUSH-GUARD verdict=refused reason=override-empty" >&2
    echo "hint: PUSH_GUARD_OVERRIDE is set but empty — a break-glass override MUST carry a reason." >&2
    exit 4
  fi
  if ! journal_override "$override_reason"; then
    echo "PUSH-GUARD verdict=refused reason=override-unjournalable journal=$OPS_JOURNAL" >&2
    echo "hint: a break-glass use that cannot be recorded is refused, exactly as dispatch-check.ts refuses an unjournalable DISPATCH_OVERRIDE." >&2
    exit 4
  fi
  echo "WARN PUSH-GUARD baseline SKIPPED reason=$override_reason journal=$OPS_JOURNAL; this push carries NO gate-equivalent evidence and may leave the target branch red" >&2
  echo "PUSH-GUARD verdict=allowed reason=break-glass"
  guard_allow
fi

# --- the tree must be what the push will send ---------------------------------
# The checks read the WORKING TREE and the index: land_run_declared_checks
# collects paths with `git ls-files` and then runs the files as they exist on
# disk. A push sends HEAD. If the two differ, this guard verifies something other
# than what is about to be pushed -- the same shape as the defect it exists to
# catch, a green result standing in for a commit nobody checked. The landing gate
# never has this problem, because it runs its baseline against a checkout it has
# already asserted onto the target branch.
#
# Untracked files (`??`) are ignored deliberately: they are not pushed, and the
# orchestrator's tree legitimately carries scratch. Anything else -- a modified
# tracked file, a staged change, a deletion -- is refused. In the normal flow
# (edit, commit, push) the tree is clean at push time, so this costs nothing; it
# fires only where the guard would otherwise have lied.
#
# After the break-glass rather than before it, so PUSH_GUARD_OVERRIDE remains a
# complete escape from the guard rather than a partial one.
dirty=$(git -C "$repo" status --porcelain --untracked-files=no 2>/dev/null)
dirty_status=$?
if [ "$dirty_status" -ne 0 ]; then
  echo "PUSH-GUARD verdict=refused reason=preflight detail=status-unreadable repo=$repo" >&2
  exit 3
fi
if [ -n "$dirty" ]; then
  printf '%s\n' "$dirty" >&2
  echo "PUSH-GUARD verdict=refused reason=preflight detail=dirty-tree repo=$repo" >&2
  echo "hint: the checks would run your working tree while the push sends HEAD; commit or restore the listed paths first." >&2
  exit 3
fi

# --- the baseline itself -----------------------------------------------------
# Name the failing check from the gate's own terse fail line, so the caller is
# not left guessing which of parse / framework test / a declared script was the
# one that mattered.
guard_name_failure() {
  local log="$1" line name detail
  line=$(grep -aE 'status=fail|=refused' "$log" | tail -n 1 || true)
  if [[ "$line" =~ (^|[[:space:]])framework-check=([^[:space:]]+) ]]; then
    name="framework:${BASH_REMATCH[2]}"
  elif [[ "$line" =~ (^|[[:space:]])declared-check=([^[:space:]]+) ]]; then
    name="declared:${BASH_REMATCH[2]}"
  elif [[ "$line" =~ (^|[[:space:]])declared-checks=refused ]]; then
    name="declared:manifest"
  elif [[ "$line" =~ (^|[[:space:]])step=([^[:space:]]+) ]]; then
    name="preflight:${BASH_REMATCH[2]}"
  else
    name="unknown"
  fi
  # The gate carries a `detail=` only on its structured refusals. A plain
  # non-zero from the framework or a declared script arrives bare, and
  # "see-output" is not an answer -- the caller is standing in front of a
  # three-minute scrollback. Say which kind of failure it was; the specifics
  # (the failing test names, the script's own output) are printed immediately
  # above on stdout.
  if [[ "$line" =~ (^|[[:space:]])detail=([^[:space:]]+) ]]; then
    detail="${BASH_REMATCH[2]}"
  else
    case "$name" in
      framework:*) detail="tests-failed" ;;
      declared:parse) detail="unparseable-source" ;;
      declared:*) detail="script-exited-non-zero" ;;
      *) detail="check-failed" ;;
    esac
  fi
  printf '%s\t%s\n' "$name" "$detail"
}

fail_log=$(mktemp "${TMPDIR:-/tmp}/bpa-push-guard-checks.XXXXXX") || {
  echo "PUSH-GUARD verdict=refused reason=preflight detail=scratch-allocation-failed" >&2
  exit 3
}

# stderr goes to a file and is replayed immediately after, rather than through a
# `tee` pipeline: the terse `status=fail` lines are what names the failing check,
# and reading them back has to be deterministic. The verbose part -- the failing
# test's own output -- is on stdout and stays live. The status below is the
# function's own, read directly and never through a pipe ("a kill is not a pass").
land_run_declared_checks "$repo" "$prefix" 2>"$fail_log"
checks_status=$?
cat "$fail_log" >&2

if [ "$checks_status" -ne 0 ]; then
  IFS=$'\t' read -r failing_check failing_detail < <(guard_name_failure "$fail_log")
  rm -f "$fail_log"
  echo "PUSH-GUARD verdict=refused check=${failing_check} detail=${failing_detail}" >&2
  echo "hint: the landing gate's baseline step would refuse this too; fix the named check, or break glass with PUSH_GUARD_OVERRIDE=<reason>." >&2
  exit 1
fi
rm -f "$fail_log"

echo "PUSH-GUARD verdict=allowed checks=baseline tests=${LAND_FRAMEWORK_TEST_COUNT:-unknown} passed=${LAND_FRAMEWORK_PASS_COUNT:-unknown}"
guard_allow
