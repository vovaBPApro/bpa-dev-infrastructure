#!/usr/bin/env bash
# Shared fail-closed checks for individual and batch landing.

land_review_check() {
  local repo="$1" branch="$2" report="$3" policy_file="$4" skip_review="$5"
  local merge_base candidate_path policy_prefix change_status old_path new_path
  local review_artifact review_verdict_value reviewer_value review_verdict_count reviewer_count
  export LAND_REVIEW_VERDICT="not-required"
  merge_base=$(git -C "$repo" merge-base "$LAND_DEFAULT_BRANCH" "$branch") || return 2
  if [ ! -r "$policy_file" ]; then
    echo "ERROR review-required policy-unreadable file=$policy_file" >&2
    return 2
  fi
  land_is_policy_path() {
    candidate_path="$1"
    while IFS= read -r policy_prefix; do
      [ -n "$policy_prefix" ] || continue
      case "$candidate_path" in "$policy_prefix"*) return 0 ;; esac
    done < <(sed -e 's/[[:space:]]*#.*$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' "$policy_file")
    return 1
  }
  LAND_REVIEW_REQUIRED=false
  while IFS= read -r -d '' change_status; do
    case "$change_status" in
      R*|C*)
        IFS= read -r -d '' old_path || return 2
        IFS= read -r -d '' new_path || return 2
        if land_is_policy_path "$old_path" || land_is_policy_path "$new_path"; then LAND_REVIEW_REQUIRED=true; fi
        ;;
      *)
        IFS= read -r -d '' candidate_path || return 2
        if land_is_policy_path "$candidate_path"; then LAND_REVIEW_REQUIRED=true; fi
        ;;
    esac
    [ "$LAND_REVIEW_REQUIRED" = true ] && break
  done < <(git -C "$repo" -c core.quotepath=false diff --name-status -z --diff-filter=ACDMRT "$merge_base..$branch")
  if [ "$LAND_REVIEW_REQUIRED" = true ]; then
    review_artifact="$(dirname "$report")/$branch.review.md"
    if [ "$skip_review" = true ]; then
      export LAND_REVIEW_VERDICT="skipped"
      echo "WARN review-skipped branch=$branch artifact=$review_artifact" >&2
    elif [ ! -r "$review_artifact" ]; then
      echo "ERROR review-required missing-artifact file=$review_artifact" >&2
      return 2
    else
      review_verdict_value=$(sed -n 's/^verdict:[[:space:]]*//p' "$review_artifact" | sed 's/[[:space:]]*$//')
      reviewer_value=$(sed -n 's/^reviewer:[[:space:]]*//p' "$review_artifact" | sed 's/[[:space:]]*$//')
      review_verdict_count=$(grep -c '^verdict:' "$review_artifact" || true)
      reviewer_count=$(grep -c '^reviewer:' "$review_artifact" || true)
      if [ "$review_verdict_value" = "REJECT" ]; then echo "ERROR review-rejected file=$review_artifact" >&2; return 2; fi
      if [ "$review_verdict_count" -ne 1 ] || [ "$review_verdict_value" != "ACCEPT" ] || [ "$reviewer_count" -ne 1 ] || [ -z "$reviewer_value" ] || [ "$reviewer_value" = "$branch" ]; then
        echo "ERROR review-required malformed-artifact file=$review_artifact" >&2
        return 2
      fi
      export LAND_REVIEW_VERDICT="accepted"
    fi
  fi
}

land_secret_scan() {
  local repo="$1" branch="$2" merge_base changed_file scan_result scan_status_line line_count
  local scan_marker scan_show_status scan_grep_status secret_hits=0
  local secret_pattern
  merge_base=$(git -C "$repo" merge-base "$LAND_DEFAULT_BRANCH" "$branch") || return 2
  secret_pattern=$(printf '%s%s%s%s%s%s%s%s%s' '[0-9]{8,10}:AA|' 'gh' 'p_|github' '_pat|client' '_secret|PRIVATE ' 'KEY|AK' 'IA[0-9A-Z]{16}|' 'sk' '-ant-')
  while IFS= read -r -d '' changed_file; do
    [ -n "$changed_file" ] || continue
    if ! git -C "$repo" cat-file -e "$branch:$changed_file"; then echo "LAND secret-scan unreadable file=$changed_file" >&2; return 2; fi
    scan_result=$(git -C "$repo" show "$branch:$changed_file" | LC_ALL=C grep -aE -c "$secret_pattern"; scan_status=("${PIPESTATUS[@]}"); printf '__LAND_SCAN_STATUS__ %s %s\n' "${scan_status[0]}" "${scan_status[1]}")
    scan_status_line=${scan_result##*$'\n'}
    line_count=${scan_result%$'\n'*}
    read -r scan_marker scan_show_status scan_grep_status <<< "$scan_status_line"
    if [ "$scan_marker" != '__LAND_SCAN_STATUS__' ] || [ "$scan_show_status" -ne 0 ] || { [ "$scan_grep_status" -ne 0 ] && [ "$scan_grep_status" -ne 1 ]; }; then echo "LAND secret-scan unreadable file=$changed_file" >&2; return 2; fi
    if [ "$line_count" -gt 0 ]; then echo "LAND secret-scan match file=$changed_file lines=$line_count" >&2; secret_hits=$((secret_hits + line_count)); fi
  done < <(git -C "$repo" -c core.quotepath=false diff --name-only -z --diff-filter=ACMRT "$merge_base..$branch")
  [ "$secret_hits" -eq 0 ]
}
