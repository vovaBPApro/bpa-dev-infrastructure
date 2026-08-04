#!/usr/bin/env bash
# Publish orchestrator bookkeeping to the integration branch behind the same
# lock the landing gate holds.
#
# The defect this closes (V3-0.47). The orchestrator writes board rows, review
# item registrations and decision files straight to origin/<target>. The
# landing gate requires the target not to move between the freshness
# measurement and the push, and its walk takes ten minutes. On 2026-08-04 that
# collision cost four landings: one needed a hand-run fast-forward of the
# shared canonical checkout, one ran the full ten-minute chain and aborted at
# `push`, one died at `LAND step=freshness status=fail`, and one left the
# canonical checkout four commits behind origin.
#
# The gate is not at fault; the write pattern is. So bookkeeping writes take
# the landing lock. This script is the mechanism that replaces the manual
# `flock -n ... -c true && echo free || echo held` discipline the orchestrator
# adopted by hand -- a discipline living only in an operator's memory is a
# host-only mechanism, which Hard Floor 5 calls a defect.
#
# Why serialise rather than teach the gate to tolerate a content-neutral move:
# see instructions/landing-and-merge.md. Short version -- the gate's declared
# checks run EVERY tracked test file and the meteorite runs the full suite in a
# clean container, and the paths bookkeeping writes (`instance/`) are read by
# 22 tracked test files plus tools/check-decision-ledger-drift.sh and
# tools/instructions/check.ts. "The move does not touch the paths it guards"
# is therefore false for exactly the writes in question.
#
# Cost of this trade, stated plainly: a bookkeeping write can wait behind one
# in-flight landing. Landings are already serialised against each other by this
# same lock, so the wait is bounded by ONE walk, not by the fleet size. Nothing
# blocks on a workboard row reaching origin within ten minutes; a landing that
# loses the race discards ten minutes of container work. The cheap thing waits
# for the expensive thing.
set -u
set -o pipefail

usage() {
  echo "usage: gate/bookkeeping-push.sh --repo <path> [--target-branch <name>] [--wait-seconds <n>] [--dry-run] [--print-wait-default]" >&2
  echo "       --dry-run is READ-ONLY: it never moves a ref in the checkout." >&2
  echo "       --wait-seconds defaults to land_bookkeeping_wait_default (derived)." >&2
  exit 2
}

repo=""
target_branch=""
wait_seconds=""
dry_run=false
print_wait_default=false

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo|--target-branch|--wait-seconds)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then usage; fi
      case "$1" in
        --repo) repo="$2" ;;
        --target-branch) target_branch="$2" ;;
        --wait-seconds) wait_seconds="$2" ;;
      esac
      shift 2
      ;;
    --dry-run) dry_run=true; shift ;;
    --print-wait-default) print_wait_default=true; shift ;;
    *) usage ;;
  esac
done

if [ -n "$wait_seconds" ] && [[ ! "$wait_seconds" =~ ^[0-9]+$ ]]; then usage; fi

book_fail() {
  echo "BOOKKEEPING step=$1 status=fail${2:+ $2}" >&2
  echo "BOOKKEEPING verdict=refused" >&2
  exit "${3:-2}"
}
book_pass() { echo "BOOKKEEPING step=$1 status=pass${2:+ $2}"; }

script_dir=$(CDPATH='' cd "$(dirname "$0")" && pwd)
# shellcheck source=gate/land-lib.sh
# shellcheck disable=SC1091
source "$script_dir/land-lib.sh"

# Derived from the landing hold, never a literal (land-lib.sh, F5). Exposed as
# a flag so a test can assert the derivation instead of asserting a number --
# a test that only checked a number would go green again the moment someone
# re-hardcoded the same number.
[ -n "$wait_seconds" ] || wait_seconds=$(land_bookkeeping_wait_default)
if [ "$print_wait_default" = true ]; then
  printf '%s\n' "$wait_seconds"
  exit 0
fi

if [ -z "$repo" ]; then usage; fi

if ! git -C "$repo" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  book_fail repo "detail=not-a-work-tree repo=$repo"
fi

allow_file="$script_dir/bookkeeping-paths.conf"
policy_file="$script_dir/review-policy.conf"
[ -r "$allow_file" ] || book_fail preflight "detail=allowlist-unreadable file=$allow_file"
[ -r "$policy_file" ] || book_fail preflight "detail=review-policy-unreadable file=$policy_file"

read_prefixes() {
  sed -e 's/[[:space:]]*#.*$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' "$1" | grep -v '^$'
}

mapfile -t allow_prefixes < <(read_prefixes "$allow_file")
mapfile -t policy_prefixes < <(read_prefixes "$policy_file")
[ "${#allow_prefixes[@]}" -gt 0 ] || book_fail preflight "detail=allowlist-empty file=$allow_file"

# Structural, not documentary: if a bookkeeping prefix ever came to overlap a
# review-required prefix, this path would become a way to publish a change to
# the integration branch without the independent review the landing gate
# demands. Refuse to run at all rather than push under a broken invariant.
for allow_prefix in "${allow_prefixes[@]}"; do
  for policy_prefix in "${policy_prefixes[@]}"; do
    case "$allow_prefix" in "$policy_prefix"*) book_fail preflight "detail=allowlist-overlaps-review-policy allow=$allow_prefix review=$policy_prefix" ;; esac
    case "$policy_prefix" in "$allow_prefix"*) book_fail preflight "detail=allowlist-overlaps-review-policy allow=$allow_prefix review=$policy_prefix" ;; esac
  done
done
book_pass preflight

git_dir=$(git -C "$repo" rev-parse --git-dir) || book_fail repo "detail=git-dir-unresolved"
case "$git_dir" in
  /*) lock_file="$git_dir/bpa-land.lock" ;;
  *) lock_file="$repo/$git_dir/bpa-land.lock" ;;
esac

# The SAME file gate/land.sh takes with `exec 9>"$lock_file"; flock -n 9`. A
# different path here would look like a fence and serialise nothing.
exec 9>"$lock_file" || book_fail lock "detail=lock-unopenable file=$lock_file"
if ! flock -n 9; then
  echo "BOOKKEEPING lock held=yes detail=waiting-for-in-flight-landing seconds=$wait_seconds"
  if ! flock -w "$wait_seconds" 9; then
    book_fail lock "detail=lock-wait-timeout seconds=$wait_seconds file=$lock_file" 3
  fi
fi
book_pass lock

default_ref=$(git -C "$repo" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)
if [ -n "$target_branch" ]; then
  :
elif [ -n "$default_ref" ]; then
  target_branch=${default_ref#origin/}
elif git -C "$repo" show-ref --verify --quiet refs/heads/main; then
  target_branch=main
elif git -C "$repo" show-ref --verify --quiet refs/heads/master; then
  target_branch=master
else
  book_fail target-branch "detail=cannot-resolve-default-branch"
fi
git -C "$repo" show-ref --verify --quiet "refs/heads/$target_branch" ||
  book_fail target-branch "detail=missing-local target=$target_branch"

current_branch=$(git -C "$repo" branch --show-current)
[ "$current_branch" = "$target_branch" ] ||
  book_fail target-branch "detail=not-checked-out target=$target_branch current=${current_branch:-detached}"
[ -z "$(git -C "$repo" status --porcelain)" ] ||
  book_fail working-tree "detail=dirty repo=$repo"

if ! git -C "$repo" fetch origin; then book_fail fetch "detail=fetch-failed"; fi
git -C "$repo" show-ref --verify --quiet "refs/remotes/origin/$target_branch" ||
  book_fail target-branch "detail=missing-origin target=origin/$target_branch"

local_sha=$(git -C "$repo" rev-parse --verify -q "${target_branch}^{commit}") ||
  book_fail target-branch "detail=local-ref-unresolved target=$target_branch"
remote_sha=$(git -C "$repo" rev-parse --verify -q "origin/${target_branch}^{commit}") ||
  book_fail target-branch "detail=origin-ref-unresolved target=origin/$target_branch"

if [ "$local_sha" = "$remote_sha" ]; then
  echo "BOOKKEEPING verdict=nothing-to-push target=$target_branch sha=$local_sha"
  exit 0
fi

base_sha=$(git -C "$repo" merge-base "$local_sha" "$remote_sha") ||
  book_fail reconcile "detail=no-merge-base target=$target_branch local=$local_sha origin=$remote_sha"

# Behind with nothing local: absorb the move and stop. This is the state the
# canonical checkout is normally left in, and it is why an operator kept having
# to hand-run a fast-forward before a landing.
if [ "$base_sha" = "$local_sha" ]; then
  if [ "$dry_run" = true ]; then
    echo "BOOKKEEPING verdict=dry-run target=$target_branch would-fast-forward=$remote_sha over=$local_sha"
    exit 0
  fi
  if ! land_refresh_target "$repo" "$target_branch" BOOKKEEPING; then
    book_fail reconcile "detail=fast-forward-failed target=$target_branch"
  fi
  echo "BOOKKEEPING verdict=nothing-to-push target=$target_branch sha=$remote_sha"
  exit 0
fi

# ---------------------------------------------------------------------------
# READ-ONLY from here to the --dry-run exit. Nothing below moves a ref, and
# that ordering is load-bearing twice over.
#
# (F3) --dry-run must be read-only. Round 1 fast-forwarded and rebased BEFORE
# testing the flag, so an operator who reached for --dry-run on the shared
# canonical checkout to see what would happen had already rewritten it by the
# time the command returned.
#
# (F1) Entitlement must be decided on the commits AS THEY STAND. Round 1
# rebased first and inspected afterwards. In a state this row's own case 4
# calls real -- a canonical checkout holding an unpushed merge a previous
# landing left behind -- that flattened the merge and published the lane's
# commits to the integration branch with no walk, no declared checks, no
# review and no round, provided every path happened to sit under instance/.
# A plain `git push origin main` in that same state is refused by the remote
# as a non-fast-forward, so round 1 converted an existing fail-closed refusal
# into a successful publish, on the branch this row exists to protect. The
# merge-commit guard that catches it was already written; it sat on the wrong
# side of the rebase.
#
# `instance/` is not a low-value directory: it holds the decision ledger the
# unpark authority reads, review-items.tsv, and params.yaml including the
# origin-URL pin. A path prefix proves a location, never an authority.
# ---------------------------------------------------------------------------

# Shared by every payload check below. Reads NUL-separated paths on stdin and
# prints the ones no allowlist prefix covers.
paths_outside_allowlist() {
  local changed_path matched allow_prefix outside=""
  while IFS= read -r -d '' changed_path; do
    [ -n "$changed_path" ] || continue
    matched=false
    for allow_prefix in "${allow_prefixes[@]}"; do
      case "$changed_path" in "$allow_prefix"*) matched=true; break ;; esac
    done
    if [ "$matched" != true ]; then outside="$outside $changed_path"; fi
  done
  printf '%s' "${outside# }"
}

moved_commits=$(git -C "$repo" rev-list --reverse "$base_sha..$local_sha") ||
  book_fail entitlement "detail=rev-list-failed range=$base_sha..$local_sha"
[ -n "$moved_commits" ] ||
  book_fail entitlement "detail=no-local-commits range=$base_sha..$local_sha"
moved_count=$(printf '%s\n' "$moved_commits" | grep -c .)

# Guard 1: no merge commit. A merge on the target branch is a landing's output
# -- gate/land.sh merges --no-ff -- and republishing one is the gate's job, not
# the fence's. This is the guard round 1 ran after the rebase had already
# flattened the merge out of existence.
merge_commits=$(git -C "$repo" rev-list --merges "$base_sha..$local_sha") ||
  book_fail entitlement "detail=rev-list-merges-failed range=$base_sha..$local_sha"
if [ -n "$merge_commits" ]; then
  book_fail entitlement "detail=merge-commit-in-range range=$base_sha..$local_sha commit=$(printf '%s\n' "$merge_commits" | head -n 1)"
fi

while IFS= read -r moved_sha; do
  [ -n "$moved_sha" ] || continue

  # Guard 2: bookkeeping is [ORCH] work by definition (CLAUDE.md commit tags).
  # A [CODER] or [REVIEW] commit sitting unpublished on the canonical
  # checkout's target branch is lane output the gate has not published; the
  # fence must not launder it. In the F1 reproduction this refuses the lane's
  # own commit independently of guard 1 refusing the merge above it.
  subject=$(git -C "$repo" log -1 --format=%s "$moved_sha") ||
    book_fail entitlement "detail=subject-unreadable commit=$moved_sha"
  case "$subject" in
    '[ORCH]'*) : ;;
    *) book_fail entitlement "detail=not-an-orch-commit commit=$moved_sha subject=$subject" ;;
  esac

  # Guard 3: not reachable from any ref but the target itself. A commit that
  # also lives on a lane branch or a tag belongs to that lane's landing, not to
  # bookkeeping, whatever its subject says.
  foreign_ref=$(git -C "$repo" for-each-ref --contains "$moved_sha" --format='%(refname)' \
      refs/heads refs/remotes refs/tags 2>/dev/null |
    grep -v -x -e "refs/heads/$target_branch" -e "refs/remotes/origin/$target_branch" -e 'refs/remotes/origin/HEAD' |
    head -n 1) || true
  if [ -n "$foreign_ref" ]; then
    book_fail entitlement "detail=commit-reachable-from-other-ref commit=$moved_sha ref=$foreign_ref"
  fi

  # Guard 4: allowlisted paths PER COMMIT, so a commit touching gate/ cannot be
  # masked by a later commit reverting it out of the net diff.
  outside=$(git -C "$repo" -c core.quotepath=false diff-tree -r --no-commit-id --name-only -z "$moved_sha" | paths_outside_allowlist)
  if [ -n "$outside" ]; then
    book_fail payload "detail=path-outside-allowlist commit=$moved_sha paths=$outside allowlist=$allow_file"
  fi
done <<< "$moved_commits"
book_pass entitlement "commits=$moved_count range=$base_sha..$local_sha"

# The net diff as well as the per-commit diffs. This is what stops the fence
# from becoming a landing bypass: a change carrying gate/, core/, daemon/ or
# any other product path is refused here and must go through gate/land.sh.
range="$base_sha..$local_sha"
outside=$(git -C "$repo" -c core.quotepath=false diff --name-only -z "$range" | paths_outside_allowlist)
if [ -n "$outside" ]; then
  book_fail payload "detail=path-outside-allowlist paths=$outside allowlist=$allow_file"
fi
book_pass payload "range=$range"

# The canonical signature scan, from its one home in land-lib.sh. It resolves
# its own base as merge-base(LAND_DEFAULT_BRANCH, branch) = $base_sha, so it
# scans exactly the commits guarded above and needs no rebase to do it.
LAND_DEFAULT_BRANCH="origin/$target_branch"
export LAND_DEFAULT_BRANCH
if ! land_secret_scan "$repo" "$target_branch"; then
  book_fail secret-scan "detail=signature-match range=$range"
fi
book_pass secret-scan

if [ "$dry_run" = true ]; then
  if [ "$base_sha" = "$remote_sha" ]; then
    echo "BOOKKEEPING verdict=dry-run target=$target_branch would-push=$local_sha over=$remote_sha checkout=unmodified"
  else
    echo "BOOKKEEPING verdict=dry-run target=$target_branch would-rebase=$local_sha onto=$remote_sha checkout=unmodified"
  fi
  exit 0
fi

# ---- Mutation starts here. ------------------------------------------------
# Diverged: replay the local-only bookkeeping commits onto the published tip.
# Safe here and only here -- every commit being rewritten passed all four
# entitlement guards above, and the landing lock is held so no landing can
# observe the intermediate state.
if [ "$base_sha" != "$remote_sha" ]; then
  if ! git -C "$repo" rebase "origin/$target_branch" >/dev/null 2>&1; then
    git -C "$repo" rebase --abort >/dev/null 2>&1 || true
    book_fail rebase "detail=rebase-conflict target=$target_branch local=$local_sha origin=$remote_sha" 4
  fi
  local_sha=$(git -C "$repo" rev-parse --verify -q "${target_branch}^{commit}") ||
    book_fail rebase "detail=local-ref-unresolved-after-rebase target=$target_branch"
  git -C "$repo" merge-base --is-ancestor "$remote_sha" "$local_sha" ||
    book_fail rebase "detail=rebase-did-not-reach-origin target=$target_branch"

  # Re-prove the guarded properties on what the rebase actually produced. The
  # rebase is the one step between the decision and the push, so it is the one
  # step that could invalidate the decision.
  rebased_count=$(git -C "$repo" rev-list --count "$remote_sha..$local_sha") ||
    book_fail rebase "detail=rev-list-count-failed range=$remote_sha..$local_sha"
  [ "$rebased_count" = "$moved_count" ] ||
    book_fail rebase "detail=commit-count-changed expected=$moved_count actual=$rebased_count"
  [ -z "$(git -C "$repo" rev-list --merges "$remote_sha..$local_sha")" ] ||
    book_fail rebase "detail=merge-commit-after-rebase range=$remote_sha..$local_sha"
  outside=$(git -C "$repo" -c core.quotepath=false diff --name-only -z "$remote_sha..$local_sha" | paths_outside_allowlist)
  [ -z "$outside" ] ||
    book_fail rebase "detail=path-outside-allowlist-after-rebase paths=$outside"
  book_pass rebase "onto=$remote_sha tip=$local_sha commits=$moved_count"
fi

# The two cheap tracked checkers, on the reconciled tip, before it is published
# (F2). This row's own argument for serialising is that a malformed ledger row
# pushed as bookkeeping can turn a passing declared check red; having made that
# argument, the fence should not then publish those paths unchecked. The lock
# is already held and both checkers are ~0.1 s, so the next landing dies at
# `baseline-checks` instead of the fence catching it here only if the fence
# does not look. A checker absent from the tracked tree is reported as absent,
# never silently passed.
run_tracked_check() {
  local label="$1" path="$2"
  shift 2
  if ! git -C "$repo" cat-file -e "$local_sha:$path" 2>/dev/null; then
    book_pass checks "check=$label detail=absent-from-tree path=$path"
    return 0
  fi
  if ! ( cd "$repo" && "$@" ) >/dev/null 2>&1; then
    book_fail checks "detail=check-failed check=$label path=$path tip=$local_sha"
  fi
  book_pass checks "check=$label tip=$local_sha"
}
run_tracked_check ledger-drift tools/check-decision-ledger-drift.sh bash tools/check-decision-ledger-drift.sh
if git -C "$repo" cat-file -e "$local_sha:tools/instructions/check.ts" 2>/dev/null; then
  # land_resolve_bun refuses a caller-supplied BUN_BIN by design, so the fence
  # is invoked as `env -u BUN_BIN gate/bookkeeping-push.sh ...` exactly like a
  # landing. A bun this script cannot resolve is a refusal, not a skip.
  land_resolve_bun || book_fail checks "detail=bun-unresolved check=instructions"
  run_tracked_check instructions tools/instructions/check.ts "$BUN_BIN" tools/instructions/check.ts
else
  book_pass checks "check=instructions detail=absent-from-tree path=tools/instructions/check.ts"
fi

if ! git -C "$repo" push origin "$target_branch"; then
  book_fail push "detail=push-rejected target=$target_branch tip=$local_sha over=$remote_sha"
fi
pushed_sha=$(git -C "$repo" ls-remote --refs origin "refs/heads/$target_branch" 2>/dev/null | awk 'NR == 1 { print $1 }')
if [ "$pushed_sha" != "$local_sha" ]; then
  book_fail push "detail=remote-mismatch target=$target_branch found=${pushed_sha:-missing} expected=$local_sha"
fi
book_pass push "target=$target_branch sha=$local_sha"
echo "BOOKKEEPING verdict=published target=$target_branch sha=$local_sha over=$remote_sha"
