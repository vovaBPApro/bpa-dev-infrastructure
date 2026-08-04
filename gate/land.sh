#!/usr/bin/env bash
# Fail-closed lane landing: guard, scan, merge, verify, push, and reap.
set -u
set -o pipefail

usage() {
  echo "usage: gate/land.sh --branch <ag-name> --item-id <mission/acceptance-id> --report <file> --repo <path> [--worktree <path>] [--no-push] [--run-verify] [--skip-review <reason>] [--target-branch <name>]" >&2
  exit 2
}

branch=""
item_id=""
report=""
repo=""
worktree=""
target_branch=""
no_push=false
run_verify=false
skip_review=false
skip_review_reason=""
merged=false
merge_sha="none"
pushed=false
landing_complete=false
review_verdict="not-required"
pre_merge_sha=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --branch|--item-id|--report|--repo|--worktree|--target-branch)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then usage; fi
      case "$1" in
        --branch) branch="$2" ;;
        --item-id) item_id="$2" ;;
        --report) report="$2" ;;
        --repo) repo="$2" ;;
        --worktree) worktree="$2" ;;
        --target-branch) target_branch="$2" ;;
      esac
      shift 2
      ;;
    --no-push) no_push=true; shift ;;
    --run-verify) run_verify=true; shift ;;
    --skip-review)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then usage; fi
      skip_review=true
      skip_review_reason="$2"
      shift 2
      ;;
    *) usage ;;
  esac
done

if [ -z "$branch" ] || [ -z "$item_id" ] || [ -z "$report" ] || [ -z "$repo" ]; then usage; fi
if [ "$skip_review" = true ] && [[ -z "${skip_review_reason//[[:space:]]/}" ]]; then usage; fi

land_pass() { echo "LAND step=$1 status=pass"; }
land_skip() { echo "LAND step=$1 status=skipped"; }
land_fail() {
  echo "LAND step=$1 status=fail" >&2
  echo "LAND verdict=aborted sha=$merge_sha" >&2
  exit "${2:-1}"
}
# Used only when a post-merge abort's own rollback attempt (land_force_reset)
# could not verify that $default_branch was restored. "aborted" is reserved
# for the case where the ref provably did not move; this path exists so the
# gate never prints that word when it cannot back it up.
land_fail_rollback() {
  echo "LAND step=$1 status=fail" >&2
  echo "LAND rollback-failed target=$default_branch expected=$2 actual=$3" >&2
  echo "LAND verdict=rollback-failed sha=$merge_sha" >&2
  exit "${4:-3}"
}
land_reap_fail() {
  echo "LAND step=reap status=${1:-fail}" >&2
  if [ "$pushed" = true ]; then
    echo "LAND verdict=landed-reap-failed sha=$merge_sha" >&2
    exit 1
  fi
  if [ "$merged" = true ]; then
    echo "LAND verdict=landed-local-reap-failed sha=$merge_sha" >&2
    exit 1
  fi
  land_fail reap
}

script_dir=$(CDPATH='' cd "$(dirname "$0")" && pwd)
# shellcheck source=gate/land-lib.sh
# shellcheck disable=SC1091
source "$script_dir/land-lib.sh"
if ! land_resolve_bun; then exit 2; fi

# Extract the pinned origin URL from an instance/params.yaml stream: the first
# `git_remote:` value, with any trailing ` # comment` stripped. That key's one
# home is instance/params.yaml (instruction-layers: reference, never copy), so
# this is a reader of that home, not a second copy of the value.
land_origin_pin() {
  sed -n 's/^[[:space:]]*git_remote:[[:space:]]*//p' | head -n 1 | sed 's/[[:space:]]#.*$//; s/[[:space:]]*$//'
}

if ! git -C "$repo" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  land_fail repo 2
fi

git_dir=$(git -C "$repo" rev-parse --git-dir) || land_fail repo 2
git_common_dir=$(git -C "$repo" rev-parse --git-common-dir) || land_fail repo 2
case "$git_common_dir" in
  /*) review_round_state="$git_common_dir/bpa-review-rounds.json" ;;
  *) review_round_state="$repo/$git_common_dir/bpa-review-rounds.json" ;;
esac
review_round_history_rel=".bpa/review-rounds.json"
review_round_history="$repo/$review_round_history_rel"
operator_unpark_candidate_trust_rel="instance/operator-unpark.allowed-signers"
review_attempt_namespace="refs/bpa-review-attempts"
review_attempt_mirror_namespace="refs/bpa-review-attempt-mirrors"
review_unpark_namespace="refs/bpa-review-unparks"
review_unpark_mirror_namespace="refs/bpa-review-unpark-mirrors"
case "$git_dir" in
  /*) lock_file="$git_dir/bpa-land.lock" ;;
  *) lock_file="$repo/$git_dir/bpa-land.lock" ;;
esac
exec 9>"$lock_file"
if ! flock -n 9; then land_fail lock 2; fi
land_rollback_on_exit() {
  status=$?
  trap - EXIT TERM INT HUP
  if [ "$landing_complete" != true ] && [ -n "$pre_merge_sha" ]; then
    if git -C "$repo" rev-parse --verify -q MERGE_HEAD >/dev/null 2>&1; then
      git -C "$repo" merge --abort >/dev/null 2>&1 || true
    fi
    git -C "$repo" checkout -q "$default_branch" >/dev/null 2>&1 || true
    if ! land_force_reset "$repo" "$pre_merge_sha"; then
      echo "LAND rollback-failed target=$default_branch expected=$pre_merge_sha actual=$(git -C "$repo" rev-parse HEAD 2>/dev/null || echo unknown)" >&2
      echo "LAND verdict=rollback-failed sha=$merge_sha" >&2
      status=3
    fi
  fi
  exit "$status"
}
trap land_rollback_on_exit EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
trap 'exit 129' HUP

default_ref=$(git -C "$repo" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)
if [ -n "$default_ref" ]; then
  default_branch=${default_ref#origin/}
elif git -C "$repo" show-ref --verify --quiet refs/heads/main; then
  default_branch=main
elif git -C "$repo" show-ref --verify --quiet refs/heads/master; then
  default_branch=master
else
  land_fail default-branch 2
fi

# --target-branch never opens a second code path: it only substitutes the
# value bound to $default_branch before any guard below reads it. Every check
# that follows (checked-out-branch equality, freshness, review/secret/payload
# merge-base via LAND_DEFAULT_BRANCH, merge, push, rollback-on-exit) already
# reads $default_branch and nothing else, so once this substitution happens
# every one of those checks is automatically retargeted together -- there is
# no separate "skip this guard for a custom target" branch to add or forget.
# The validation below only narrows which substitution values are accepted;
# it cannot be used to skip a guard, only to redirect all of them in lockstep.
if [ -n "$target_branch" ]; then
  if [ "$target_branch" = "$branch" ]; then
    echo "LAND target-branch same-as-candidate target=$target_branch branch=$branch" >&2
    land_fail target-branch 2
  fi
  if ! git -C "$repo" show-ref --verify --quiet "refs/heads/$target_branch"; then
    echo "LAND target-branch missing-local target=$target_branch" >&2
    land_fail target-branch 2
  fi
  if ! git -C "$repo" show-ref --verify --quiet "refs/remotes/origin/$target_branch"; then
    echo "LAND target-branch missing-origin target=$target_branch" >&2
    land_fail target-branch 2
  fi
  # A lane branch can exist on origin, so it is not an authority root: only an
  # integration branch reaches origin through this gate's review requirement,
  # which is the whole reason a decision tracked there means anything. This
  # check lives here because this is the only layer that still sees a branch
  # NAME -- the unpark authority itself now takes an immutable SHA and refuses
  # ref names outright.
  case "$target_branch" in
    ag-*)
      echo "LAND target-branch lane-branch-not-an-authority-root target=$target_branch" >&2
      land_fail target-branch 2
      ;;
  esac
  default_branch="$target_branch"
fi

# The same refusal for the default-branch detection path: refs/remotes/origin/HEAD
# is a symbolic ref in the lane-writable common directory, so without this a lane
# could nominate a lane branch as the integration target by repointing it -- no
# --target-branch needed. Whatever named the target, it is never a lane branch.
case "$default_branch" in
  ag-*)
    echo "LAND default-branch lane-branch-not-an-integration-target target=$default_branch" >&2
    land_fail default-branch 2
    ;;
esac

current_branch=$(git -C "$repo" branch --show-current)
if [ "$current_branch" != "$default_branch" ]; then
  echo "LAND default-branch expected=$default_branch current=${current_branch:-detached}" >&2
  land_fail default-branch 2
fi
if [ "$branch" = "$default_branch" ]; then
  land_fail branch 2
fi
if ! git -C "$repo" rev-parse --verify "${branch}^{commit}" >/dev/null 2>&1; then
  land_fail branch 2
fi
if [ -n "$(git -C "$repo" status --porcelain)" ]; then
  land_fail working-tree 2
fi
if [ "$skip_review" = true ]; then
  branch_sha=$(git -C "$repo" rev-parse "$branch") || land_fail branch 2
  if ! land_record_review_skip "$repo" "$branch" "$branch_sha" "$skip_review_reason"; then land_fail review 2; fi
fi
# What `origin` MEANS is shared mutable state too. `remote.origin.url` lives in
# the Git common directory every lane worktree shares, and Git honors extra
# `pushurl` values -- which is how three plain `git config` writes from a lane
# worktree once pointed this gate's reads (ls-remote, fetch) at a forged
# repository while its writes still reached the real one, landing a self-authored
# authorization (round-4 review, F1). The gate therefore resolves ONE origin URL
# and uses that explicit URL for every remote read and write in this landing:
# with a single URL there is no read/write split left to exploit -- either it
# names the real origin and the authority read from it is real, or it does not
# and nothing this landing does ever reaches the real integration branch. A
# second url or any pushurl is refused outright, and the URL must equal the pin
# the target branch itself tracks (instance/params.yaml: repos.git_remote, one
# home, checked below once origin has answered) -- so redirecting a clone means
# forging durable tracked content on a forged remote, not an invisible config
# edit.
origin_url=$(git -C "$repo" config --get-all remote.origin.url) || origin_url=""
if [ -z "$origin_url" ] || [ "$(printf '%s\n' "$origin_url" | wc -l)" -ne 1 ]; then
  echo "LAND freshness origin-url-not-single configured=$(printf '%s' "$origin_url" | tr '\n' ' ')" >&2
  land_fail freshness 2
fi
origin_pushurls=$(git -C "$repo" config --get-all remote.origin.pushurl 2>/dev/null || true)
if [ -n "$origin_pushurls" ]; then
  echo "LAND freshness origin-pushurl-refused pushurl=$(printf '%s' "$origin_pushurls" | tr '\n' ' ')" >&2
  land_fail freshness 2
fi
if ! git -C "$repo" fetch origin; then land_fail freshness 2; fi
if [ "$(git -C "$repo" rev-parse "$default_branch")" != "$(git -C "$repo" rev-parse "origin/$default_branch")" ]; then
  land_fail freshness 2
fi
pre_merge_sha=$(git -C "$repo" rev-parse "$default_branch")
# The one commit origin actually holds, asked of origin at the single verified
# URL. Local refs -- including refs/remotes/origin/* -- are writable by any lane
# sharing this Git common directory, so they are not evidence of what origin
# carries. This SHA is the trust root for the tracked-decision unpark authority
# below, and it is immutable once resolved: nothing a lane writes afterwards can
# substitute it.
target_authority_sha=$(git -C "$repo" ls-remote --refs "$origin_url" "refs/heads/$default_branch" 2>/dev/null | awk 'NR == 1 { print $1 }')
if [ -z "$target_authority_sha" ] || [ "$target_authority_sha" != "$pre_merge_sha" ]; then
  echo "LAND freshness origin-target-mismatch target=$default_branch origin=${target_authority_sha:-missing} local=$pre_merge_sha" >&2
  land_fail freshness 2
fi
if ! git -C "$repo" rev-parse --verify --quiet "${target_authority_sha}^{commit}" >/dev/null; then
  echo "LAND freshness origin-target-object-missing sha=$target_authority_sha" >&2
  land_fail freshness 2
fi
# The pin's one home is instance/params.yaml (repos.git_remote), read from the
# SHA origin itself answered with. A repo that tracks no pin (minimal fixture
# and product repos) falls back to the single configured URL enforced above; a
# repo that tracks one must be configured to match it exactly, and the payload
# guard below refuses any candidate that changes the pinned value.
pinned_origin_url=$(git -C "$repo" show "$target_authority_sha:instance/params.yaml" 2>/dev/null | land_origin_pin)
if [ -n "$pinned_origin_url" ] && [ "$pinned_origin_url" != "$origin_url" ]; then
  echo "LAND freshness origin-redirected pinned=$pinned_origin_url configured=$origin_url" >&2
  land_fail freshness 2
fi
land_pass freshness

# Bind caller input to tracked authority on the target branch. Instance repos
# register a stable branch root for each work item; disposable -rN recuts map
# back to that root. Minimal fixture/product repos without the registry retain
# the strict legacy invariant that the item id must equal the branch name.
registry=$(git -C "$repo" show "$default_branch:instance/review-items.tsv" 2>/dev/null || true)
if [ -n "$registry" ]; then
  canonical_branch=$(printf '%s\n' "$branch" | sed -E 's/-r[0-9]+$//')
  registered_branch=$(printf '%s\n' "$registry" | awk -F '\t' -v id="$item_id" '$1 == id { print $2 }')
  registry_matches=$(printf '%s\n' "$registry" | awk -F '\t' -v id="$item_id" '$1 == id { count++ } END { print count+0 }')
  if [ "$registry_matches" -ne 1 ] || [ "$registered_branch" != "$canonical_branch" ]; then
    echo "LAND review-item unknown-or-mismatched item=$item_id branch=$branch" >&2
    land_fail review-item 2
  fi
elif [ "$item_id" != "$branch" ]; then
  echo "LAND review-item unregistered item=$item_id branch=$branch" >&2
  land_fail review-item 2
fi
land_pass review-item

# The target branch is the durable authority. Reconstruct the writable,
# clone-local copy from it on every attempt, so deleting .git or rebuilding the
# host cannot reset an exhausted item. Absence is accepted only when the target
# branch has never carried review-round history; deletion is fail-closed.
review_history_present=false
if git -C "$repo" cat-file -e "$default_branch:$review_round_history_rel" 2>/dev/null; then
  review_history_present=true
  rm -f "$review_round_state"
  if ! git -C "$repo" show "$default_branch:$review_round_history_rel" > "$review_round_state"; then
    land_fail review-rounds 2
  fi
  chmod 600 "$review_round_state" || land_fail review-rounds 2
elif git -C "$repo" log --format=%H --all -- "$review_round_history_rel" | grep -q .; then
  echo "LAND review-rounds durable-history-missing path=$review_round_history_rel" >&2
  land_fail review-rounds 2
fi

# A genuinely new repository has no durable history yet. Bootstrap it under
# the serialized landing lock; malformed/non-regular existing state is never
# replaced.
if [ ! -e "$review_round_state" ]; then
  if ! "$BUN_BIN" "$script_dir/review-rounds.ts" init --state "$review_round_state" --cap 3 --no-progress-limit 3; then
    land_fail review-rounds 2
  fi
fi

# Attempt refs are the origin-visible source of truth for reviewed attempts
# which did not land. The target-branch JSON is only a reconstructable cache:
# replay every later ref in strict sequence after a clone or host rebuild.
item_key=$(printf '%s' "$item_id" | git -C "$repo" hash-object --stdin) || land_fail review-rounds 2
attempt_prefix="$review_attempt_namespace/$item_key"
attempt_mirror_prefix="$review_attempt_mirror_namespace/$item_key"
attempt_refs=$(git -C "$repo" ls-remote --refs "$origin_url" "$attempt_prefix/*") || land_fail review-rounds 2
attempt_mirror_refs=$(git -C "$repo" ls-remote --refs "$origin_url" "$attempt_mirror_prefix/*") || land_fail review-rounds 2
# The mirror is deliberately a separate remote namespace. A lane can mutate
# either namespace today, but a forged or suppressed record in only one is
# detectable. Coordinated root mutation of both is outside this mechanism's
# authority and is documented as such in review-policy.
normalized_attempt_refs=$(printf '%s\n' "$attempt_refs" | sed "s#refs/bpa-review-attempts/#refs/bpa-review-attempt-mirrors/#")
if [ "$normalized_attempt_refs" != "$attempt_mirror_refs" ]; then
  echo "LAND review-rounds attempt-mirror-mismatch item=$item_id" >&2
  land_fail review-rounds 2
fi
if [ "$review_history_present" = false ] && [ -n "$attempt_refs" ]; then
  rm -f "$review_round_state"
  if ! "$BUN_BIN" "$script_dir/review-rounds.ts" init --state "$review_round_state" --cap 3 --no-progress-limit 3 >/dev/null; then
    land_fail review-rounds 2
  fi
fi
rounds=$("$BUN_BIN" "$script_dir/review-rounds.ts" round --state "$review_round_state" --item-id "$item_id") || land_fail review-rounds 2
while IFS=$'\t' read -r attempt_sha attempt_ref; do
  [ -n "$attempt_ref" ] || continue
  attempt_leaf=${attempt_ref#"$attempt_prefix/"}
  if [[ ! "$attempt_leaf" =~ ^([1-9][0-9]*)-([0-9a-f]{40})$ ]] || [ "$attempt_sha" != "${BASH_REMATCH[2]}" ]; then
    echo "LAND review-rounds malformed-attempt-ref ref=$attempt_ref" >&2
    land_fail review-rounds 2
  fi
  attempt_round=${BASH_REMATCH[1]}
  if [ "$attempt_round" -le "$rounds" ]; then continue; fi
  if [ "$attempt_round" -ne $((rounds + 1)) ]; then
    echo "LAND review-rounds nonsequential-attempt-ref expected=$((rounds + 1)) found=$attempt_round" >&2
    land_fail review-rounds 2
  fi
  # --replay: this ref proves the round happened, so reconstruct it instead of
  # re-admitting it. A parked reconstructed state is not a refusal here -- the
  # operator authorities below have not run yet, and dying at this point is what
  # made one aborted landing strand a one-time decision forever. The park is
  # carried forward untouched; if nothing releases it, the attempt and check
  # steps further down still refuse the landing.
  if ! "$BUN_BIN" "$script_dir/review-rounds.ts" attempt --replay --defer-park-exit --state "$review_round_state" --item-id "$item_id" >/dev/null; then
    land_fail review-rounds 2
  fi
  rounds=$attempt_round
done <<< "$attempt_refs"

unpark_prefix="$review_unpark_namespace/$item_key"
unpark_mirror_prefix="$review_unpark_mirror_namespace/$item_key"
unpark_refs=$(git -C "$repo" ls-remote --refs "$origin_url" "$unpark_prefix/*") || land_fail review-rounds 2
unpark_mirror_refs=$(git -C "$repo" ls-remote --refs "$origin_url" "$unpark_mirror_prefix/*") || land_fail review-rounds 2
normalized_unpark_refs=$(printf '%s\n' "$unpark_refs" | sed "s#refs/bpa-review-unparks/#refs/bpa-review-unpark-mirrors/#")
if [ "$normalized_unpark_refs" != "$unpark_mirror_refs" ]; then
  echo "LAND review-rounds unpark-mirror-mismatch item=$item_id" >&2
  land_fail review-rounds 2
fi
while IFS=$'\t' read -r unpark_sha unpark_ref; do
  [ -n "$unpark_ref" ] || continue
  git -C "$repo" fetch -q "$origin_url" "$unpark_ref" || land_fail review-rounds 2
  unpark_tmp=$(mktemp -d)
  if ! git -C "$repo" show FETCH_HEAD:authorization > "$unpark_tmp/authorization" ||
     ! git -C "$repo" show FETCH_HEAD:signature > "$unpark_tmp/signature"; then
    rm -rf "$unpark_tmp"; land_fail review-rounds 2
  fi
  decision_id=$(sed -n 's/^decision-id=//p' "$unpark_tmp/authorization")
  authorized_by=$(sed -n 's/^authorized-by=//p' "$unpark_tmp/authorization")
  authorized_at=$(sed -n 's/^authorized-at=//p' "$unpark_tmp/authorization")
  if ! "$BUN_BIN" "$script_dir/review-rounds.ts" operator-unpark --state "$review_round_state" --item-id "$item_id" \
      --decision-id "$decision_id" --authorized-by "$authorized_by" --authorized-at "$authorized_at" \
      --authorization "$unpark_tmp/authorization" --signature "$unpark_tmp/signature" >/dev/null; then
    rm -rf "$unpark_tmp"; land_fail review-rounds 2
  fi
  rm -rf "$unpark_tmp"
done <<< "$unpark_refs"

# Second operator authority: a decision file tracked on the integration branch.
# The signature path above stays available because HR-2109 gives the eventual
# administrator bot a signing role; this one exists because the operator is
# usually not at a computer (HR-2103) and decides over Telegram. What a tracked
# decision proves is write access to the integration branch on the real origin
# -- on this installation the orchestrator pushes decision captures there
# directly (see review-policy) -- and this gate's own contribution is narrower:
# nothing a LANE can write may mint or redirect that authority. The item id
# passed here is the same tracked-authority id the review-item guard already
# bound above; the content root is the immutable SHA the single verified origin
# URL answered with, never a ref name, the working tree, or $branch; and the
# candidate rev can only make a decision file inert (one it deletes), never
# make one grant.
if ! "$BUN_BIN" "$script_dir/review-rounds.ts" operator-unpark-decision \
    --state "$review_round_state" --item-id "$item_id" --repo "$repo" --target-sha "$target_authority_sha" \
    --candidate "$branch"; then
  land_fail review-rounds 2
fi

export LAND_DEFAULT_BRANCH="$default_branch"
guard_args=("$script_dir/completion-guard.ts" --report "$report" --repo "$repo" --branch "$branch")
if [ "$run_verify" = true ]; then guard_args+=(--defer-verify); fi
if ! "$BUN_BIN" "${guard_args[@]}"; then
  land_fail completion-guard 2
fi
land_pass completion-guard

policy_file="$script_dir/review-policy.conf"
if ! land_review_check "$repo" "$branch" "$report" "$policy_file" "$skip_review"; then land_fail review 2; fi
review_verdict="$LAND_REVIEW_VERDICT"
land_pass review
if [ "$skip_review" = true ]; then echo "LAND review=SKIPPED reason=$skip_review_reason"; fi

# Never publish a candidate object into the durable attempt namespace before
# the canonical signature scan has accepted it.
if ! land_secret_scan "$repo" "$branch"; then land_fail secret-scan 2; fi
land_pass secret-scan

# The item identity is supplied by durable mission/acceptance identity, never
# inferred from the disposable branch name. The repository-wide landing lock
# also serializes this read-modify-write with every other landing attempt.
if ! "$BUN_BIN" "$script_dir/review-rounds.ts" attempt --defer-park-exit --state "$review_round_state" --item-id "$item_id"; then
  land_fail review-rounds 2
fi
rounds=$((rounds + 1))
branch_sha=$(git -C "$repo" rev-parse --verify "${branch}^{commit}") || land_fail branch-tip 2
attempt_ref="$attempt_prefix/$rounds-$branch_sha"
attempt_mirror_ref="$attempt_mirror_prefix/$rounds-$branch_sha"
if ! git -C "$repo" push --atomic "$origin_url" "$branch_sha:$attempt_ref" "$branch_sha:$attempt_mirror_ref" >/dev/null; then
  echo "LAND review-rounds attempt-persist-failed ref=$attempt_ref" >&2
  land_fail review-rounds 2
fi
persisted_attempt_sha=$(git -C "$repo" ls-remote --refs "$origin_url" "$attempt_ref" 2>/dev/null | awk 'NR == 1 { print $1 }')
persisted_attempt_mirror_sha=$(git -C "$repo" ls-remote --refs "$origin_url" "$attempt_mirror_ref" 2>/dev/null | awk 'NR == 1 { print $1 }')
remote_target_sha=$(git -C "$repo" ls-remote --refs "$origin_url" "refs/heads/$default_branch" 2>/dev/null | awk 'NR == 1 { print $1 }')
if [ "$persisted_attempt_sha" != "$branch_sha" ] || [ "$persisted_attempt_mirror_sha" != "$branch_sha" ] || [ "$remote_target_sha" != "$pre_merge_sha" ]; then
  echo "LAND review-rounds attempt-persist-mismatch ref=$attempt_ref found=${persisted_attempt_sha:-missing} target=${remote_target_sha:-missing} expected-target=$pre_merge_sha" >&2
  land_fail review-rounds 2
fi
if ! "$BUN_BIN" "$script_dir/review-rounds.ts" check --state "$review_round_state" --item-id "$item_id" >/dev/null; then
  land_fail review-rounds 2
fi
land_pass review-rounds

report_sha=$(sed -n 's/^commit:[[:space:]]*\([0-9a-fA-F]\{40\}\).*/\1/p' "$report" | head -n 1)
branch_sha=$(git -C "$repo" rev-parse --verify "${branch}^{commit}") || land_fail branch-tip 2
if [ -z "$report_sha" ] || [ "${report_sha,,}" != "${branch_sha,,}" ]; then
  echo "LAND branch-tip mismatch report=${report_sha:-missing} branch=$branch_sha" >&2
  land_fail branch-tip 2
fi
land_pass branch-tip

payload_base=$(land_changed_base "$repo" "$branch") || land_fail payload-guard 2
if ! git -C "$repo" diff --quiet "$payload_base..$branch" -- "$review_round_history_rel"; then
  echo "LAND step=payload-guard status=fail detail=reserved-path path=$review_round_history_rel" >&2
  land_fail payload-guard 2
fi
if ! git -C "$repo" diff --quiet "$payload_base..$branch" -- "$operator_unpark_candidate_trust_rel"; then
  echo "LAND step=payload-guard status=fail detail=reserved-path path=$operator_unpark_candidate_trust_rel" >&2
  land_fail payload-guard 2
fi
# The origin pin is authority-adjacent for the same reason as the files above:
# a candidate that rewrites repos.git_remote redirects every later landing's
# trust root, and one that introduces a pin chooses it. The VALUE is reserved,
# not the file -- instance/params.yaml stays ordinary, heavily edited instance
# state. Reserved means "this candidate does not CHANGE it", measured against
# the same merge-base every other payload check uses: a lane that never touched
# the file is not refused for being behind main on it, because the merge takes
# main's version anyway.
base_origin_pin=$(git -C "$repo" show "$payload_base:instance/params.yaml" 2>/dev/null | land_origin_pin)
candidate_origin_pin=$(git -C "$repo" show "$branch:instance/params.yaml" 2>/dev/null | land_origin_pin)
if [ "$candidate_origin_pin" != "$base_origin_pin" ]; then
  echo "LAND step=payload-guard status=fail detail=reserved-origin-pin base=${base_origin_pin:-none} candidate=${candidate_origin_pin:-none}" >&2
  land_fail payload-guard 2
fi
# A candidate may still record decisions -- that is ordinary governance work --
# but it may not land one that carries an unpark authorization, because that is
# the authorization this same gate reads back as authority. "Carries an
# authorization" is decided by review-rounds.ts's OWN predicate, through its
# `reserved-blob` command, over the raw blob bytes -- the same function the
# authority reader runs. It used to be a second awk implementation fed through
# a command substitution, and bash silently deletes NUL bytes from $(...): one
# NUL in a fake close line ended the frontmatter for that copy while the reader
# kept the grant inside the block, and a lane landed its own authorization
# (round-4 review, F8). The blob therefore reaches the predicate through a file
# redirect, byte-exact. One predicate, one home: reserving less than the reader
# grants lets a lane land its own authority; reserving more blocks the
# operator's verbatim words whenever they quote the format.
# -z keeps path bytes raw. Without it Git C-quotes any non-ASCII or special
# path, `cat-file -e` on the quoted string fails, and the && short-circuited the
# whole check into "not a reserved path" -- so naming the file HR-9999<eacute>.md
# walked a self-authored authorization straight past this guard.
operator_unpark_decision_dir="instance/decisions"
while IFS= read -r -d '' decision_path; do
  [ -n "$decision_path" ] || continue
  git -C "$repo" cat-file -e "$branch:$decision_path" 2>/dev/null || continue
  decision_blob_file=$(mktemp) || land_fail payload-guard 2
  if ! git -C "$repo" show "$branch:$decision_path" > "$decision_blob_file"; then
    rm -f "$decision_blob_file"
    land_fail payload-guard 2
  fi
  "$BUN_BIN" "$script_dir/review-rounds.ts" reserved-blob --blob "$decision_blob_file" >/dev/null
  decision_blob_verdict=$?
  rm -f "$decision_blob_file"
  case "$decision_blob_verdict" in
    0) ;;
    3)
      echo "LAND step=payload-guard status=fail detail=reserved-path path=$decision_path" >&2
      land_fail payload-guard 2
      ;;
    *) land_fail payload-guard 2 ;;
  esac
done < <(git -C "$repo" diff -z --name-only "$payload_base..$branch" -- "$operator_unpark_decision_dir/")
if ! land_payload_guard "$repo" "$branch"; then
  echo "LAND verdict=aborted sha=$merge_sha" >&2
  exit 2
fi
land_pass payload-guard

if ! land_run_declared_checks "$repo" 'LAND BASELINE'; then
  land_fail baseline-checks
fi
baseline_test_count="$LAND_FRAMEWORK_TEST_COUNT"
land_pass baseline-checks

# Measure the candidate range before main moves. After the merge, using main as
# the merge-base would collapse the range to empty and silently skip proof.
meteorite_required=false
if land_meteorite_required "$repo" "$branch"; then
  meteorite_required=true
else
  meteorite_required_status=$?
  if [ "$meteorite_required_status" -ne 1 ]; then
    land_fail meteorite-trigger 2
  fi
fi

if ! git -C "$repo" merge --no-ff "$branch" -m "[ORCH] land lane $branch" -m "secret-scan: clean"; then
  git -C "$repo" merge --abort >/dev/null 2>&1 || true
  land_fail merge
fi
merged=true
merge_sha=$(git -C "$repo" rev-parse HEAD)

# Record the successful round in tracked target-branch history. The candidate
# SHA is used as the progress marker because the merge SHA cannot be known
# before the state embedded in that merge is committed.
if ! "$BUN_BIN" "$script_dir/review-rounds.ts" landed --state "$review_round_state" --item-id "$item_id" --sha "$branch_sha"; then
  land_fail review-rounds 2
fi
mkdir -p "$(dirname "$review_round_history")" || land_fail review-rounds 2
if ! install -m 600 "$review_round_state" "$review_round_history" ||
   ! git -C "$repo" add -- "$review_round_history_rel" ||
   ! git -C "$repo" commit --amend --no-edit >/dev/null; then
  land_fail review-rounds 2
fi
merge_sha=$(git -C "$repo" rev-parse HEAD)
land_pass merge

if [ "$meteorite_required" = true ]; then
  # The runner is read from the independently accepted pre-merge tree. The
  # candidate remains the tested SHA, but cannot replace its own observer.
  if ! land_run_meteorite "$repo" "$merge_sha" "$pre_merge_sha"; then
    if ! land_force_reset "$repo" "$pre_merge_sha"; then
      land_fail_rollback meteorite "$pre_merge_sha" "$(git -C "$repo" rev-parse HEAD 2>/dev/null || echo unknown)"
    fi
    merged=false
    merge_sha="none"
    land_fail meteorite
  fi
  land_pass meteorite
else
  land_skip meteorite
fi

if ! land_run_declared_checks "$repo" LAND "$baseline_test_count"; then
  if ! land_force_reset "$repo" "$pre_merge_sha"; then
    land_fail_rollback declared-checks "$pre_merge_sha" "$(git -C "$repo" rev-parse HEAD 2>/dev/null || echo unknown)"
  fi
  merged=false
  merge_sha="none"
  land_fail declared-checks
fi
land_pass declared-checks

# Retained evidence must reach origin before another landing can succeed. This
# intentionally favors durability over offline landing availability: ls-remote
# is operational evidence, while unit tests use a local bare remote.
if ! "$BUN_BIN" "$repo/hygiene/check-retained-branches.ts" --repo "$repo"; then
  if ! land_force_reset "$repo" "$pre_merge_sha"; then
    land_fail_rollback retained-branches "$pre_merge_sha" "$(git -C "$repo" rev-parse HEAD 2>/dev/null || echo unknown)"
  fi
  merged=false
  merge_sha="none"
  land_fail retained-branches
fi
land_pass retained-branches

# Hard Floor 5 requires host state that stays out of git to be enumerated
# instead. This is the fail-closed half of that: a change that teaches the
# running system to write somewhere instance/host-state.tsv does not name
# cannot land. Repository-level only -- it reads tracked sources and never the
# live host, so it behaves identically inside the meteorite container.
#
# A candidate with no enumeration at all is skipped rather than failed, because
# the gate also lands synthetic fixture repositories that have no installation
# to enumerate. That is not a hole in this repository: deleting the manifest
# fails one step earlier, where tools/check-host-state.test.ts reads it during
# the declared framework checks.
if [ -f "$repo/instance/host-state.tsv" ]; then
  if ! "$BUN_BIN" "$repo/tools/check-host-state.ts" --repo "$repo"; then
    if ! land_force_reset "$repo" "$pre_merge_sha"; then
      land_fail_rollback host-state "$pre_merge_sha" "$(git -C "$repo" rev-parse HEAD 2>/dev/null || echo unknown)"
    fi
    merged=false
    merge_sha="none"
    land_fail host-state
  fi
  land_pass host-state
else
  land_skip host-state
fi

if [ "$run_verify" = true ]; then
  # Trust model: report verify commands are coder-authored and guard-validated.
  verify_command=$(sed -n 's/^verify:[[:space:]]*//p' "$report" | head -n 1)
  verify_count_claim=$(sed -n 's/^verify-count:[[:space:]]*//p' "$report")
  if [ -n "$verify_count_claim" ]; then
    reviewed_verify_output=$(mktemp)
    if ! land_verify_reviewed_sha "$repo" "$branch_sha" "$reviewed_verify_output"; then
      cat "$reviewed_verify_output"
      rm -f "$reviewed_verify_output"
      if ! land_force_reset "$repo" "$pre_merge_sha"; then
        land_fail_rollback reviewed-verify "$pre_merge_sha" "$(git -C "$repo" rev-parse HEAD 2>/dev/null || echo unknown)"
      fi
      merged=false
      merge_sha="none"
      land_fail reviewed-verify
    fi
    if ! land_verify_count "$report" "$reviewed_verify_output" exact; then
      rm -f "$reviewed_verify_output"
      if ! land_force_reset "$repo" "$pre_merge_sha"; then
        land_fail_rollback reviewed-verify "$pre_merge_sha" "$(git -C "$repo" rev-parse HEAD 2>/dev/null || echo unknown)"
      fi
      merged=false
      merge_sha="none"
      land_fail reviewed-verify
    fi
    rm -f "$reviewed_verify_output"
    land_pass reviewed-verify
  fi
  verify_output=$(mktemp)
  if [ -z "$verify_command" ] || ! (cd "$repo" && sh -c "$verify_command") >"$verify_output" 2>&1; then
    cat "$verify_output"
    rm -f "$verify_output"
    if ! land_force_reset "$repo" "$pre_merge_sha"; then
      land_fail_rollback post-merge-verify "$pre_merge_sha" "$(git -C "$repo" rev-parse HEAD 2>/dev/null || echo unknown)"
    fi
    merged=false
    merge_sha="none"
    echo "LAND post-merge-verify failure: merge reset to ORIG_HEAD" >&2
    land_fail post-merge-verify
  fi
  cat "$verify_output"
  if ! land_verify_count "$report" "$verify_output" carry; then
    rm -f "$verify_output"
    if ! land_force_reset "$repo" "$pre_merge_sha"; then
      land_fail_rollback post-merge-verify "$pre_merge_sha" "$(git -C "$repo" rev-parse HEAD 2>/dev/null || echo unknown)"
    fi
    merged=false
    merge_sha="none"
    echo "LAND post-merge-verify count mismatch: merge reset to ORIG_HEAD" >&2
    land_fail post-merge-verify
  fi
  rm -f "$verify_output"
  land_pass post-merge-verify
else
  land_skip post-merge-verify
fi

if [ "$no_push" = false ]; then
  if ! git -C "$repo" push "$origin_url" "$default_branch"; then
    if git -C "$repo" fetch origin >/dev/null 2>&1; then
      rollback_sha=$(git -C "$repo" rev-parse "origin/$default_branch")
    else
      rollback_sha="$pre_merge_sha"
    fi
    if ! land_force_reset "$repo" "$rollback_sha"; then
      land_fail_rollback push "$rollback_sha" "$(git -C "$repo" rev-parse HEAD 2>/dev/null || echo unknown)"
    fi
    merged=false
    merge_sha="none"
    echo "LAND push failure: main reset to origin/main" >&2
    land_fail push
  fi
  remote_sha=$(git -C "$repo" ls-remote --refs "$origin_url" "refs/heads/$default_branch" 2>/dev/null | awk 'NR == 1 { print $1 }')
  if [ "$remote_sha" != "$merge_sha" ]; then
    echo "LAND push remote-mismatch target=$default_branch found=${remote_sha:-missing} expected=$merge_sha" >&2
    if git -C "$repo" fetch origin >/dev/null 2>&1; then
      rollback_sha=$(git -C "$repo" rev-parse "origin/$default_branch")
    else
      rollback_sha="$pre_merge_sha"
    fi
    if ! land_force_reset "$repo" "$rollback_sha"; then
      land_fail_rollback push "$rollback_sha" "$(git -C "$repo" rev-parse HEAD 2>/dev/null || echo unknown)"
    fi
    merged=false
    merge_sha="none"
    land_fail push
  fi
  pushed=true
  land_pass push
else
  land_skip push
fi

landing_complete=true
if [ "$merged" != true ]; then
  land_reap_fail
fi
land_pass review-progress
if ! land_assert_reap_safe "$repo" "$branch" "$merge_sha" LAND; then
  land_reap_fail
fi
if [ -n "$worktree" ] && ! git -C "$repo" worktree remove "$worktree"; then
  land_reap_fail
fi
if ! git -C "$repo" branch -d "$branch"; then
  land_reap_fail
fi
# The reap is only done when origin no longer has the lane ref: delete it and
# verify absence with ls-remote. A local-only delete must never report pass.
allow_remote_delete=true
if [ "$no_push" = true ]; then allow_remote_delete=false; fi
if ! land_remote_reap "$repo" "$branch" LAND "$allow_remote_delete"; then
  land_reap_fail local-only
fi
land_pass reap
echo "LAND verdict=landed sha=$merge_sha review=$review_verdict"
