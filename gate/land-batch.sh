#!/usr/bin/env bash
# Fail-closed landing of a small reviewed branch batch with one integration verify.
set -u
set -o pipefail

usage() {
  echo "usage: gate/land-batch.sh --branches <b1,b2,b3> --reports <r1,r2,r3> --repo <path> [--no-push] [--run-verify] [--skip-review <reason>]" >&2
  exit 2
}

branches_arg="" reports_arg="" repo="" no_push=false run_verify=false skip_review=false skip_review_reason=""
pre_merge_sha=""
default_branch=""
integration_branch=""
batch_complete=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --branches|--reports|--repo)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then usage; fi
      case "$1" in --branches) branches_arg="$2" ;; --reports) reports_arg="$2" ;; --repo) repo="$2" ;; esac
      shift 2 ;;
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
if [ -z "$branches_arg" ] || [ -z "$reports_arg" ] || [ -z "$repo" ]; then usage; fi
if [ "$skip_review" = true ] && [[ -z "${skip_review_reason//[[:space:]]/}" ]]; then usage; fi

IFS=',' read -r -a branches <<< "$branches_arg"
IFS=',' read -r -a reports <<< "$reports_arg"
branch_count=${#branches[@]}
if [ "$branch_count" -lt 2 ] || [ "$branch_count" -gt 3 ] || [ "$branch_count" -ne "${#reports[@]}" ]; then usage; fi
for branch in "${branches[@]}"; do [ -n "$branch" ] || usage; done
for report in "${reports[@]}"; do [ -n "$report" ] || usage; done

batch_fail() { echo "BATCH step=$1 status=fail" >&2; echo "BATCH verdict=aborted" >&2; exit "${2:-1}"; }
batch_pass() { echo "BATCH step=$1 status=pass"; }
batch_skip() { echo "BATCH step=$1 status=skipped"; }

script_dir=$(CDPATH='' cd "$(dirname "$0")" && pwd)
# shellcheck source=gate/land-lib.sh
# shellcheck disable=SC1091
source "$script_dir/land-lib.sh"
if ! land_resolve_bun; then exit 2; fi

if ! git -C "$repo" rev-parse --is-inside-work-tree >/dev/null 2>&1; then batch_fail repo 2; fi
git_dir=$(git -C "$repo" rev-parse --git-dir) || batch_fail repo 2
case "$git_dir" in
  /*) lock_file="$git_dir/bpa-land.lock" ;;
  *) lock_file="$repo/$git_dir/bpa-land.lock" ;;
esac
exec 9>"$lock_file"
if ! flock -n 9; then batch_fail lock 2; fi
batch_cleanup() {
  local exit_status=$?
  if [ "$batch_complete" != true ] && [ -n "$integration_branch" ] && [ -n "$default_branch" ] && [ -n "$pre_merge_sha" ]; then
    git -C "$repo" merge --abort >/dev/null 2>&1 || true
    git -C "$repo" checkout "$default_branch" >/dev/null 2>&1 || true
    git -C "$repo" reset --hard "$pre_merge_sha" >/dev/null 2>&1 || true
    git -C "$repo" branch -D "$integration_branch" >/dev/null 2>&1 || true
  fi
  return "$exit_status"
}
trap batch_cleanup EXIT
trap 'exit 143' TERM
default_ref=$(git -C "$repo" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)
if [ -n "$default_ref" ]; then default_branch=${default_ref#origin/}
elif git -C "$repo" show-ref --verify --quiet refs/heads/main; then default_branch=main
elif git -C "$repo" show-ref --verify --quiet refs/heads/master; then default_branch=master
else batch_fail default-branch 2; fi
if [ "$(git -C "$repo" branch --show-current)" != "$default_branch" ]; then batch_fail default-branch 2; fi
if [ -n "$(git -C "$repo" status --porcelain)" ]; then batch_fail working-tree 2; fi
if ! git -C "$repo" fetch origin; then batch_fail freshness 2; fi
if [ "$(git -C "$repo" rev-parse "$default_branch")" != "$(git -C "$repo" rev-parse "origin/$default_branch")" ]; then batch_fail freshness 2; fi
pre_merge_sha=$(git -C "$repo" rev-parse "$default_branch")
batch_pass freshness

export LAND_DEFAULT_BRANCH="$default_branch"
policy_file="$script_dir/review-policy.conf"
review_summary=""
for index in "${!branches[@]}"; do
  branch=${branches[$index]}
  report=${reports[$index]}
  if [ "$branch" = "$default_branch" ] || ! git -C "$repo" rev-parse --verify "${branch}^{commit}" >/dev/null 2>&1; then batch_fail branch 2; fi
  if [ "$skip_review" = true ]; then
    branch_sha=$(git -C "$repo" rev-parse "$branch") || batch_fail branch 2
    if ! land_record_review_skip "$repo" "$branch" "$branch_sha" "$skip_review_reason"; then batch_fail "review branch=$branch" 2; fi
  fi
  guard_args=("$script_dir/completion-guard.ts" --report "$report" --repo "$repo" --branch "$branch")
  if [ "$run_verify" = true ]; then guard_args+=(--defer-verify); fi
  if ! "$BUN_BIN" "${guard_args[@]}"; then batch_fail completion-guard 2; fi
  batch_pass "completion-guard branch=$branch"
  if ! land_secret_scan "$repo" "$branch"; then batch_fail "secret-scan branch=$branch" 2; fi
  batch_pass "secret-scan branch=$branch"
  if ! land_payload_guard "$repo" "$branch"; then
    echo "BATCH verdict=aborted" >&2
    exit 2
  fi
  batch_pass "payload-guard branch=$branch"
  if ! land_review_check "$repo" "$branch" "$report" "$policy_file" "$skip_review"; then batch_fail "review branch=$branch" 2; fi
  batch_pass "review branch=$branch"
  if [ -n "$review_summary" ]; then review_summary+=","; fi
  review_summary+="$branch:$LAND_REVIEW_VERDICT"
done
if [ "$skip_review" = true ]; then echo "BATCH review=SKIPPED reason=$skip_review_reason"; fi

declare -A changed_path_owner=()
for branch in "${branches[@]}"; do
  merge_base=$(git -C "$repo" merge-base "$default_branch" "$branch") || batch_fail "changed-paths branch=$branch" 2
  while IFS= read -r -d '' status; do
    IFS= read -r -d '' path || batch_fail "changed-paths branch=$branch" 2
    paths=("$path")
    case "$status" in
      R*|C*)
        IFS= read -r -d '' path || batch_fail "changed-paths branch=$branch" 2
        paths+=("$path")
        ;;
    esac
    for path in "${paths[@]}"; do
      if [ -n "${changed_path_owner[$path]+set}" ]; then
        echo "BATCH overlap path=$path branches=${changed_path_owner[$path]},$branch" >&2
        echo "BATCH verdict=conflict pair=$branch" >&2
        batch_fail disjoint-paths 2
      fi
      changed_path_owner["$path"]="$branch"
    done
  done < <(git -C "$repo" diff --name-status -z --find-renames "$merge_base" "$branch")
done
batch_pass disjoint-paths

if ! land_run_declared_checks "$repo" 'BATCH BASELINE'; then
  batch_fail baseline-checks
fi
baseline_test_count="$LAND_FRAMEWORK_TEST_COUNT"
batch_pass baseline-checks

integration_branch="batch-integration-$$"
if ! git -C "$repo" checkout -b "$integration_branch" "$default_branch" >/dev/null; then batch_fail integration-branch; fi
integration_cleanup() {
  git -C "$repo" merge --abort >/dev/null 2>&1 || true
  git -C "$repo" checkout "$default_branch" >/dev/null 2>&1 || true
  git -C "$repo" branch -D "$integration_branch" >/dev/null 2>&1 || true
}
for branch in "${branches[@]}"; do
  if ! git -C "$repo" merge --no-ff "$branch" -m "[ORCH] batch land lane $branch" -m "secret-scan: clean"; then
    integration_cleanup
    echo "BATCH verdict=conflict pair=$branch" >&2
    exit 1
  fi
done
merge_sha=$(git -C "$repo" rev-parse HEAD)
batch_pass merge

if ! land_run_declared_checks "$repo" BATCH "$baseline_test_count"; then
  integration_cleanup
  batch_fail declared-checks
fi
batch_pass declared-checks

if [ "$run_verify" = true ]; then
  for index in "${!reports[@]}"; do
    verify_command=$(sed -n 's/^verify:[[:space:]]*//p' "${reports[$index]}" | head -n 1)
    verify_output=$(mktemp)
    if [ -z "$verify_command" ] || ! (cd "$repo" && sh -c "$verify_command") >"$verify_output" 2>&1; then
      cat "$verify_output"
      rm -f "$verify_output"
      integration_cleanup
      batch_fail "post-merge-verify branch=${branches[$index]}"
    fi
    cat "$verify_output"
    if ! land_verify_count "${reports[$index]}" "$verify_output"; then
      rm -f "$verify_output"
      integration_cleanup
      batch_fail "post-merge-verify branch=${branches[$index]}"
    fi
    rm -f "$verify_output"
    batch_pass "post-merge-verify branch=${branches[$index]}"
  done
  batch_pass post-merge-verify
else
  batch_skip post-merge-verify
fi
if ! git -C "$repo" checkout "$default_branch" >/dev/null || ! git -C "$repo" merge --ff-only "$integration_branch" >/dev/null; then
  batch_fail land-default
fi
if [ "$no_push" = false ]; then
  if ! git -C "$repo" push origin "$default_branch"; then
    if git -C "$repo" fetch origin >/dev/null 2>&1; then
      rollback_sha=$(git -C "$repo" rev-parse "origin/$default_branch")
    else
      rollback_sha="$pre_merge_sha"
    fi
    git -C "$repo" reset --hard "$rollback_sha" >/dev/null || batch_fail rollback
    git -C "$repo" branch -D "$integration_branch" >/dev/null 2>&1 || true
    echo "BATCH push failure: main reset to origin/main" >&2
    batch_fail push
  fi
  batch_pass push
else
  batch_skip push
fi

reap_failed=false
reap_local_only=false
allow_remote_delete=true
if [ "$no_push" = true ]; then allow_remote_delete=false; fi
for branch in "${branches[@]}" "$integration_branch"; do
  if ! land_assert_reap_safe "$repo" "$branch" "$merge_sha" BATCH; then
    reap_failed=true
    continue
  fi
  if ! git -C "$repo" branch -d "$branch"; then
    echo "BATCH reap failure branch=$branch" >&2
    reap_failed=true
    continue
  fi
  # The reap is only done when origin no longer has the ref: delete it and
  # verify absence with ls-remote. A local-only delete must never report pass.
  if ! land_remote_reap "$repo" "$branch" BATCH "$allow_remote_delete"; then
    reap_local_only=true
  fi
done
if [ "$reap_failed" = true ] || [ "$reap_local_only" = true ]; then
  if [ "$reap_failed" = true ]; then echo "BATCH step=reap status=fail" >&2; else echo "BATCH step=reap status=local-only" >&2; fi
  if [ "$no_push" = true ]; then echo "BATCH verdict=landed-local-reap-failed sha=$merge_sha" >&2; else echo "BATCH verdict=landed-reap-failed sha=$merge_sha" >&2; fi
  exit 1
fi
batch_pass reap
batch_complete=true
trap - EXIT TERM
echo "BATCH verdict=landed sha=$merge_sha branches=$branch_count review=$review_summary"
