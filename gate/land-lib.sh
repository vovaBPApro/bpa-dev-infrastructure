#!/usr/bin/env bash
# Shared fail-closed checks for individual and batch landing.

land_resolve_bun() {
  local candidate candidate_dir
  if [ -n "${BUN_BIN:-}" ]; then
    candidate="$BUN_BIN"
  elif [ -n "${HOME:-}" ] && [ -x "$HOME/.bun/bin/bun" ]; then
    candidate="$HOME/.bun/bin/bun"
  else
    candidate=$(command -v bun 2>/dev/null || true)
  fi

  if [ -z "$candidate" ] || [ ! -x "$candidate" ]; then
    echo "LAND step=preflight status=fail detail=bun-not-found" >&2
    return 1
  fi

  case "$candidate" in
    /*) ;;
    *)
      candidate_dir=$(CDPATH='' cd -- "$(dirname -- "$candidate")" && pwd -P) || return 1
      candidate="$candidate_dir/$(basename -- "$candidate")"
      ;;
  esac
  BUN_BIN="$candidate"
  export BUN_BIN
}

land_review_check() {
  local repo="$1" branch="$2" report="$3" policy_file="$4" skip_review="$5"
  local merge_base candidate_path policy_prefix change_status old_path new_path
  local review_artifact review_verdict_value reviewer_value reviewed_sha_value independence_value
  local review_verdict_count reviewer_count reviewed_sha_count independence_count report_sha
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
      reviewed_sha_value=$(sed -n 's/^reviewed-sha:[[:space:]]*//p' "$review_artifact" | sed 's/[[:space:]]*$//')
      independence_value=$(sed -n 's/^independence:[[:space:]]*//p' "$review_artifact" | sed 's/[[:space:]]*$//')
      review_verdict_count=$(grep -c '^verdict:' "$review_artifact" || true)
      reviewer_count=$(grep -c '^reviewer:' "$review_artifact" || true)
      reviewed_sha_count=$(grep -c '^reviewed-sha:' "$review_artifact" || true)
      independence_count=$(grep -c '^independence:' "$review_artifact" || true)
      if [ "$review_verdict_value" = "REJECT" ]; then echo "ERROR review-rejected file=$review_artifact" >&2; return 2; fi
      if [ "$review_verdict_count" -ne 1 ] || [ "$review_verdict_value" != "ACCEPT" ] || [ "$reviewer_count" -ne 1 ] || [ -z "$reviewer_value" ] || [ "$reviewer_value" = "$branch" ]; then
        echo "ERROR review-required malformed-artifact file=$review_artifact" >&2
        return 2
      fi
      if [ "$reviewed_sha_count" -ne 1 ] || ! [[ "$reviewed_sha_value" =~ ^[0-9a-fA-F]{40}$ ]]; then
        echo "ERROR review-required stale-artifact missing-reviewed-sha line='reviewed-sha: <40-hex>' file=$review_artifact" >&2
        return 2
      fi
      report_sha=$(sed -n 's/^commit:[[:space:]]*\([0-9a-fA-F]\{40\}\).*/\1/p' "$report" | head -n 1)
      if [ -z "$report_sha" ] || [ "${reviewed_sha_value,,}" != "${report_sha,,}" ]; then
        echo "ERROR review-required stale-artifact reviewed-sha-mismatch line='reviewed-sha: <40-hex>' expected=${report_sha:-missing-report-sha} actual=$reviewed_sha_value file=$review_artifact" >&2
        return 2
      fi
      if [ "$independence_count" -ne 1 ] || [ -z "$independence_value" ]; then
        echo "ERROR review-required malformed-artifact missing-independence line='independence: <text>' file=$review_artifact" >&2
        return 2
      fi
      export LAND_REVIEW_VERDICT="accepted"
    fi
  fi
}

land_record_review_skip() {
  local repo="$1" branch="$2" sha="$3" reason="$4" audit_file timestamp
  audit_file="$repo/orchestrator/runtime/review-skips.log"
  timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ) || return 2
  reason=${reason//$'\n'/ }
  reason=${reason//$'\r'/ }
  reason=${reason//$'\t'/ }
  if ! mkdir -p "$(dirname "$audit_file")" || ! printf '%s\tbranch=%s\tsha=%s\treason=%s\n' "$timestamp" "$branch" "$sha" "$reason" >> "$audit_file"; then
    echo "ERROR review-skipped audit-write-failed file=$audit_file" >&2
    return 2
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

land_payload_guard() {
  local repo="$1" branch="$2" merge_base raw_entry changed_file
  local old_mode new_mode change_status
  merge_base=$(git -C "$repo" merge-base "$LAND_DEFAULT_BRANCH" "$branch") || return 2
  while IFS= read -r -d '' raw_entry; do
    IFS= read -r -d '' changed_file || return 2
    read -r old_mode new_mode _ _ change_status <<< "${raw_entry#:}"
    case "$change_status" in
      A|M|T)
        case "$new_mode" in
          120000|160000)
            echo "LAND step=payload-guard status=fail detail=mode-$new_mode path=$changed_file" >&2
            return 1
            ;;
          100755)
            if [ "$old_mode" != "100755" ] && [[ "$changed_file" != *.sh ]] && ! git -C "$repo" show "$branch:$changed_file" | head -c 2 | grep -Fqx '#!'; then
              echo "LAND step=payload-guard status=fail detail=unexpected-executable path=$changed_file" >&2
              return 1
            fi
            ;;
        esac
        ;;
    esac
  done < <(git -C "$repo" -c core.quotepath=false diff --raw -z --no-renames --diff-filter=AMT "$merge_base..$branch")
}
