#!/usr/bin/env bash
# Fail-closed lane landing: guard, scan, merge, verify, push, and reap.
set -u
set -o pipefail

usage() {
  echo "usage: gate/land.sh --branch <ag-name> --report <file> --repo <path> [--worktree <path>] [--no-push] [--run-verify] [--skip-review]" >&2
  exit 2
}

branch=""
report=""
repo=""
worktree=""
no_push=false
run_verify=false
skip_review=false
merged=false
merge_sha="none"
pushed=false
review_verdict="not-required"

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
    --skip-review) skip_review=true; shift ;;
    *) usage ;;
  esac
done

if [ -z "$branch" ] || [ -z "$report" ] || [ -z "$repo" ]; then usage; fi

land_pass() { echo "LAND step=$1 status=pass"; }
land_skip() { echo "LAND step=$1 status=skipped"; }
land_fail() {
  echo "LAND step=$1 status=fail" >&2
  echo "LAND verdict=aborted sha=$merge_sha" >&2
  exit "${2:-1}"
}
land_reap_fail() {
  echo "LAND step=reap status=fail" >&2
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

script_dir=$(CDPATH='' cd "$(dirname "$0")" && pwd)
guard_args=("$script_dir/completion-guard.ts" --report "$report" --repo "$repo" --branch "$branch")
if [ "$run_verify" = true ]; then guard_args+=(--run-verify); fi
if ! bun "${guard_args[@]}"; then
  land_fail completion-guard 2
fi
land_pass completion-guard

merge_base=$(git -C "$repo" merge-base "$default_branch" "$branch") || land_fail secret-scan 2
policy_file="$script_dir/review-policy.conf"
review_required=false
if [ ! -r "$policy_file" ]; then
  echo "ERROR review-required policy-unreadable file=$policy_file" >&2
  land_fail review 2
fi
while IFS= read -r -d '' changed_file; do
  [ -n "$changed_file" ] || continue
  while IFS= read -r policy_prefix; do
    [ -n "$policy_prefix" ] || continue
    case "$changed_file" in
      "$policy_prefix"*)
        review_required=true
        break
        ;;
    esac
  done < <(sed -e 's/[[:space:]]*#.*$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' "$policy_file")
  [ "$review_required" = true ] && break
done < <(git -C "$repo" -c core.quotepath=false diff --name-only -z --diff-filter=ACMRT "$merge_base..$branch")

if [ "$review_required" = true ]; then
  review_artifact="$(dirname "$report")/$branch.review.md"
  if [ "$skip_review" = true ]; then
    review_verdict="skipped"
    echo "WARN review-skipped branch=$branch artifact=$review_artifact" >&2
  elif [ ! -r "$review_artifact" ]; then
    echo "ERROR review-required missing-artifact file=$review_artifact" >&2
    land_fail review 2
  else
    review_verdict_value=$(sed -n 's/^verdict:[[:space:]]*//p' "$review_artifact")
    reviewer_value=$(sed -n 's/^reviewer:[[:space:]]*//p' "$review_artifact")
    review_verdict_count=$(grep -c '^verdict:' "$review_artifact" || true)
    reviewer_count=$(grep -c '^reviewer:' "$review_artifact" || true)
    if [ "$review_verdict_value" = "REJECT" ]; then
      echo "ERROR review-rejected file=$review_artifact" >&2
      land_fail review 2
    fi
    if [ "$review_verdict_count" -ne 1 ] || \
      [ "$review_verdict_value" != "ACCEPT" ] || \
      [ "$reviewer_count" -ne 1 ] || \
      [ -z "$reviewer_value" ] || [ "$reviewer_value" = "$branch" ]; then
      echo "ERROR review-required malformed-artifact file=$review_artifact" >&2
      land_fail review 2
    fi
    review_verdict="accepted"
  fi
fi
land_pass review

secret_pattern=$(printf '%s%s%s%s%s%s%s%s%s' '[0-9]{8,10}:AA|' 'gh' 'p_|github' '_pat|client' '_secret|PRIVATE ' 'KEY|AK' 'IA[0-9A-Z]{16}|' 'sk' '-ant-')
secret_hits=0
while IFS= read -r -d '' changed_file; do
  [ -n "$changed_file" ] || continue
  # Scan branch blobs directly: reports may contain binary or unusual filenames.
  # `-a` makes grep inspect binary bytes rather than treating them as a clean skip.
  if ! git -C "$repo" cat-file -e "$branch:$changed_file"; then
    echo "LAND secret-scan unreadable file=$changed_file" >&2
    land_fail secret-scan 2
  fi
  # Preserve both pipeline statuses without allocating a file for each blob.
  scan_result=$(
    git -C "$repo" show "$branch:$changed_file" | LC_ALL=C grep -aE -c "$secret_pattern"
    scan_status=("${PIPESTATUS[@]}")
    printf '__LAND_SCAN_STATUS__ %s %s\n' "${scan_status[0]}" "${scan_status[1]}"
  )
  scan_status_line=${scan_result##*$'\n'}
  line_count=${scan_result%$'\n'*}
  read -r scan_marker scan_show_status scan_grep_status <<< "$scan_status_line"
  if [ "$scan_marker" != '__LAND_SCAN_STATUS__' ] || [ "$scan_show_status" -ne 0 ] || { [ "$scan_grep_status" -ne 0 ] && [ "$scan_grep_status" -ne 1 ]; }; then
    echo "LAND secret-scan unreadable file=$changed_file" >&2
    land_fail secret-scan 2
  fi
  if [ "$line_count" -gt 0 ]; then
    echo "LAND secret-scan match file=$changed_file lines=$line_count" >&2
    secret_hits=$((secret_hits + line_count))
  fi
done < <(git -C "$repo" -c core.quotepath=false diff --name-only -z --diff-filter=ACMRT "$merge_base..$branch")
if [ "$secret_hits" -ne 0 ]; then
  land_fail secret-scan 2
fi
land_pass secret-scan

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
  if [ -z "$verify_command" ] || ! (cd "$repo" && sh -c "$verify_command"); then
    git -C "$repo" reset --hard ORIG_HEAD >/dev/null
    echo "LAND post-merge-verify failure: merge reset to ORIG_HEAD" >&2
    land_fail post-merge-verify
  fi
  land_pass post-merge-verify
else
  land_skip post-merge-verify
fi

if [ "$no_push" = false ]; then
  if ! git -C "$repo" push origin "$default_branch"; then
    echo "LAND push failure: merge retained for inspection" >&2
    land_fail push
  fi
  pushed=true
  land_pass push
else
  land_skip push
fi

if [ "$merged" != true ]; then
  land_reap_fail
fi
if [ -n "$worktree" ] && ! git -C "$repo" worktree remove "$worktree"; then
  land_reap_fail
fi
if ! git -C "$repo" branch -d "$branch"; then
  land_reap_fail
fi
land_pass reap
echo "LAND verdict=landed sha=$merge_sha review=$review_verdict"
