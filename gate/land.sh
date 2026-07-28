#!/usr/bin/env bash
# Fail-closed lane landing: guard, scan, merge, verify, push, and reap.
set -u
set -o pipefail

usage() {
  echo "usage: gate/land.sh --branch <ag-name> --report <file> --repo <path> [--worktree <path>] [--no-push] [--run-verify]" >&2
  exit 2
}

branch=""
report=""
repo=""
worktree=""
no_push=false
run_verify=false
merged=false
merge_sha="none"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --branch|--report|--repo|--worktree)
      [ "$#" -ge 2 ] && [ -n "$2" ] || usage
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
    *) usage ;;
  esac
done

[ -n "$branch" ] && [ -n "$report" ] && [ -n "$repo" ] || usage

land_pass() { echo "LAND step=$1 status=pass"; }
land_fail() {
  echo "LAND step=$1 status=fail" >&2
  echo "LAND verdict=aborted sha=$merge_sha" >&2
  exit "${2:-1}"
}

if ! git -C "$repo" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  land_fail repo 2
fi

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

guard_args=("$(dirname "$0")/completion-guard.ts" --report "$report" --repo "$repo" --branch "$branch")
if [ "$run_verify" = true ]; then guard_args+=(--run-verify); fi
if ! bun "${guard_args[@]}"; then
  land_fail completion-guard 2
fi
land_pass completion-guard

merge_base=$(git -C "$repo" merge-base "$default_branch" "$branch") || land_fail secret-scan 2
secret_pattern=$(printf '%s%s%s%s%s%s' '[0-9]{8,10}:AA|' 'gh' 'p_|github' '_pat|client' '_secret|PRIVATE ' 'KEY')
secret_hits=0
while IFS= read -r changed_file; do
  [ -n "$changed_file" ] || continue
  line_count=$(git -C "$repo" diff --no-ext-diff --unified=0 "$merge_base..$branch" -- "$changed_file" | grep '^+' | grep -E -c "$secret_pattern" || true)
  if [ "$line_count" -gt 0 ]; then
    echo "LAND secret-scan match file=$changed_file lines=$line_count" >&2
    secret_hits=$((secret_hits + line_count))
  fi
done < <(git -C "$repo" diff --name-only "$merge_base..$branch")
if [ "$secret_hits" -ne 0 ]; then
  land_fail secret-scan 2
fi
land_pass secret-scan

if ! git -C "$repo" merge --no-ff "$branch" -m "[ORCH] land lane $branch" -m "secret-scan: clean"; then
  land_fail merge
fi
merged=true
merge_sha=$(git -C "$repo" rev-parse HEAD)
land_pass merge

if [ "$run_verify" = true ]; then
  verify_command=$(sed -n 's/^verify:[[:space:]]*//p' "$report")
  if [ -z "$verify_command" ] || ! (cd "$repo" && sh -c "$verify_command"); then
    land_fail post-merge-verify
  fi
fi
land_pass post-merge-verify

if [ "$no_push" = false ]; then
  if ! git -C "$repo" push origin "$default_branch"; then
    echo "LAND push failure: merge retained for inspection" >&2
    land_fail push
  fi
fi
land_pass push

if [ "$merged" != true ]; then
  land_fail reap
fi
if [ -n "$worktree" ] && ! git -C "$repo" worktree remove "$worktree"; then
  land_fail reap
fi
if ! git -C "$repo" branch -d "$branch"; then
  land_fail reap
fi
land_pass reap
echo "LAND verdict=landed sha=$merge_sha"
