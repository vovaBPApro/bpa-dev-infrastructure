#!/usr/bin/env bash
# Fail-closed lane landing: guard, scan, merge, verify, push, and reap.
set -u
set -o pipefail

usage() {
  echo "usage: gate/land.sh --branch <ag-name> --report <file> --repo <path> [--worktree <path>] [--no-push] [--run-verify] [--skip-review <reason>]" >&2
  exit 2
}

branch=""
report=""
repo=""
worktree=""
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
    --branch|--report|--repo|--worktree)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then usage; fi
      case "$1" in
        --branch) branch="$2" ;;
        --report) report="$2" ;;
        --repo) repo="$2" ;;
        --worktree) worktree="$2" ;;
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

if [ -z "$branch" ] || [ -z "$report" ] || [ -z "$repo" ]; then usage; fi
if [ "$skip_review" = true ] && [[ -z "${skip_review_reason//[[:space:]]/}" ]]; then usage; fi

land_pass() { echo "LAND step=$1 status=pass"; }
land_skip() { echo "LAND step=$1 status=skipped"; }
land_fail() {
  echo "LAND step=$1 status=fail" >&2
  echo "LAND verdict=aborted sha=$merge_sha" >&2
  exit "${2:-1}"
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

if ! git -C "$repo" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  land_fail repo 2
fi

git_dir=$(git -C "$repo" rev-parse --git-dir) || land_fail repo 2
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
    git -C "$repo" reset --hard "$pre_merge_sha" >/dev/null 2>&1 || true
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
if ! git -C "$repo" fetch origin; then land_fail freshness 2; fi
if [ "$(git -C "$repo" rev-parse "$default_branch")" != "$(git -C "$repo" rev-parse "origin/$default_branch")" ]; then
  land_fail freshness 2
fi
pre_merge_sha=$(git -C "$repo" rev-parse "$default_branch")
land_pass freshness

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

if ! land_secret_scan "$repo" "$branch"; then land_fail secret-scan 2; fi
land_pass secret-scan

report_sha=$(sed -n 's/^commit:[[:space:]]*\([0-9a-fA-F]\{40\}\).*/\1/p' "$report" | head -n 1)
branch_sha=$(git -C "$repo" rev-parse --verify "${branch}^{commit}") || land_fail branch-tip 2
if [ -z "$report_sha" ] || [ "${report_sha,,}" != "${branch_sha,,}" ]; then
  echo "LAND branch-tip mismatch report=${report_sha:-missing} branch=$branch_sha" >&2
  land_fail branch-tip 2
fi
land_pass branch-tip

if ! land_payload_guard "$repo" "$branch"; then
  echo "LAND verdict=aborted sha=$merge_sha" >&2
  exit 2
fi
land_pass payload-guard

if ! git -C "$repo" merge --no-ff "$branch" -m "[ORCH] land lane $branch" -m "secret-scan: clean"; then
  git -C "$repo" merge --abort >/dev/null 2>&1 || true
  land_fail merge
fi
merged=true
merge_sha=$(git -C "$repo" rev-parse HEAD)
land_pass merge

if [ "$run_verify" = true ]; then
  # Trust model: report verify commands are coder-authored and guard-validated.
  verify_command=$(sed -n 's/^verify:[[:space:]]*//p' "$report" | head -n 1)
  verify_output=$(mktemp)
  if [ -z "$verify_command" ] || ! (cd "$repo" && sh -c "$verify_command") >"$verify_output" 2>&1; then
    cat "$verify_output"
    rm -f "$verify_output"
    git -C "$repo" reset --hard ORIG_HEAD >/dev/null
    echo "LAND post-merge-verify failure: merge reset to ORIG_HEAD" >&2
    land_fail post-merge-verify
  fi
  cat "$verify_output"
  if ! land_verify_count "$report" "$verify_output"; then
    rm -f "$verify_output"
    git -C "$repo" reset --hard ORIG_HEAD >/dev/null
    echo "LAND post-merge-verify count mismatch: merge reset to ORIG_HEAD" >&2
    land_fail post-merge-verify
  fi
  rm -f "$verify_output"
  land_pass post-merge-verify
else
  land_skip post-merge-verify
fi

if [ "$no_push" = false ]; then
  if ! git -C "$repo" push origin "$default_branch"; then
    if git -C "$repo" fetch origin >/dev/null 2>&1; then
      rollback_sha=$(git -C "$repo" rev-parse "origin/$default_branch")
    else
      rollback_sha="$pre_merge_sha"
    fi
    git -C "$repo" reset --hard "$rollback_sha" >/dev/null || land_fail rollback
    merged=false
    merge_sha="none"
    echo "LAND push failure: main reset to origin/main" >&2
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
