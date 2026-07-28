#!/usr/bin/env bash
# Fail-closed landing of a small reviewed branch batch with one integration verify.
set -u
set -o pipefail

usage() {
  echo "usage: gate/land-batch.sh --branches <b1,b2,b3> --reports <r1,r2,r3> --repo <path> [--no-push] [--run-verify] [--skip-review]" >&2
  exit 2
}

branches_arg="" reports_arg="" repo="" no_push=false run_verify=false skip_review=false
pre_merge_sha=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --branches|--reports|--repo)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then usage; fi
      case "$1" in --branches) branches_arg="$2" ;; --reports) reports_arg="$2" ;; --repo) repo="$2" ;; esac
      shift 2 ;;
    --no-push) no_push=true; shift ;;
    --run-verify) run_verify=true; shift ;;
    --skip-review) skip_review=true; shift ;;
    *) usage ;;
  esac
done
if [ -z "$branches_arg" ] || [ -z "$reports_arg" ] || [ -z "$repo" ]; then usage; fi

IFS=',' read -r -a branches <<< "$branches_arg"
IFS=',' read -r -a reports <<< "$reports_arg"
branch_count=${#branches[@]}
if [ "$branch_count" -lt 2 ] || [ "$branch_count" -gt 3 ] || [ "$branch_count" -ne "${#reports[@]}" ]; then usage; fi
for branch in "${branches[@]}"; do [ -n "$branch" ] || usage; done
for report in "${reports[@]}"; do [ -n "$report" ] || usage; done

batch_fail() { echo "BATCH step=$1 status=fail" >&2; echo "BATCH verdict=aborted" >&2; exit "${2:-1}"; }
batch_pass() { echo "BATCH step=$1 status=pass"; }
batch_skip() { echo "BATCH step=$1 status=skipped"; }

if ! git -C "$repo" rev-parse --is-inside-work-tree >/dev/null 2>&1; then batch_fail repo 2; fi
git_dir=$(git -C "$repo" rev-parse --git-dir) || batch_fail repo 2
case "$git_dir" in
  /*) lock_file="$git_dir/bpa-land.lock" ;;
  *) lock_file="$repo/$git_dir/bpa-land.lock" ;;
esac
exec 9>"$lock_file"
if ! flock -n 9; then batch_fail lock 2; fi
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

script_dir=$(CDPATH='' cd "$(dirname "$0")" && pwd)
# shellcheck source=gate/land-lib.sh
source "$script_dir/land-lib.sh"
export LAND_DEFAULT_BRANCH="$default_branch"
policy_file="$script_dir/review-policy.conf"
review_summary=""
for index in "${!branches[@]}"; do
  branch=${branches[$index]}
  report=${reports[$index]}
  if [ "$branch" = "$default_branch" ] || ! git -C "$repo" rev-parse --verify "${branch}^{commit}" >/dev/null 2>&1; then batch_fail branch 2; fi
  guard_args=("$script_dir/completion-guard.ts" --report "$report" --repo "$repo" --branch "$branch")
  if ! bun "${guard_args[@]}"; then batch_fail completion-guard 2; fi
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

if [ "$run_verify" = true ]; then
  verify_command=$(sed -n 's/^verify:[[:space:]]*//p' "${reports[0]}" | head -n 1)
  if [ -z "$verify_command" ] || ! (cd "$repo" && sh -c "$verify_command"); then
    integration_cleanup
    batch_fail post-merge-verify
  fi
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
for branch in "${branches[@]}" "$integration_branch"; do
  if ! git -C "$repo" branch -d "$branch"; then
    echo "BATCH reap failure branch=$branch" >&2
    reap_failed=true
  fi
done
if [ "$reap_failed" = true ]; then
  if [ "$no_push" = true ]; then echo "BATCH verdict=landed-local-reap-failed sha=$merge_sha" >&2; else echo "BATCH verdict=landed-reap-failed sha=$merge_sha" >&2; fi
  exit 1
fi
batch_pass reap
echo "BATCH verdict=landed sha=$merge_sha branches=$branch_count review=$review_summary"
