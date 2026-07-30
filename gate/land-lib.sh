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
  local merge_base candidate_path policy_prefix change_status old_path new_path diff_file diff_fd
  local review_artifact review_verdict_value reviewer_value reviewed_sha_value independence_value
  local review_verdict_count reviewer_count reviewed_sha_count independence_count report_sha
  local commit_author_name commit_author_email reviewer_name reviewer_email reviewer_normalized
  local author_name_normalized author_email_normalized reviewer_name_tokens author_name_tokens
  local reviewer_name_sorted author_name_sorted nul_status
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
  diff_file=$(mktemp "${TMPDIR:-/tmp}/bpa-land-review-diff.XXXXXX") || return 2
  if ! git -C "$repo" -c core.quotepath=false diff --name-status -z --diff-filter=ACDMRT "$merge_base..$branch" > "$diff_file"; then
    rm -f "$diff_file"
    echo "ERROR review-required diff-unreadable branch=$branch" >&2
    return 2
  fi
  exec {diff_fd}< "$diff_file"
  rm -f "$diff_file"
  while IFS= read -r -d '' change_status; do
    case "$change_status" in
      R*|C*)
        IFS= read -r -d '' old_path || { exec {diff_fd}<&-; return 2; }
        IFS= read -r -d '' new_path || { exec {diff_fd}<&-; return 2; }
        if land_is_policy_path "$old_path" || land_is_policy_path "$new_path"; then LAND_REVIEW_REQUIRED=true; fi
        ;;
      *)
        IFS= read -r -d '' candidate_path || { exec {diff_fd}<&-; return 2; }
        if land_is_policy_path "$candidate_path"; then LAND_REVIEW_REQUIRED=true; fi
        ;;
    esac
    [ "$LAND_REVIEW_REQUIRED" = true ] && break
  done <&"$diff_fd"
  exec {diff_fd}<&-
  if [ "$LAND_REVIEW_REQUIRED" = true ]; then
    review_artifact="$(dirname "$report")/$branch.review.md"
    if [ "$skip_review" = true ]; then
      export LAND_REVIEW_VERDICT="skipped"
      echo "WARN review-skipped branch=$branch artifact=$review_artifact" >&2
    elif [ -L "$review_artifact" ] || { [ -e "$review_artifact" ] && [ ! -f "$review_artifact" ]; }; then
      echo "ERROR review-required invalid-artifact non-regular-file file=$review_artifact" >&2
      return 2
    elif [ ! -r "$review_artifact" ]; then
      echo "ERROR review-required missing-artifact file=$review_artifact" >&2
      return 2
    else
      # Check raw bytes before command substitution can discard a NUL from any field.
      if LC_ALL=C grep -aqP '\x00' "$review_artifact"; then
        echo "ERROR review-required invalid-artifact nul-byte file=$review_artifact" >&2
        return 2
      else
        nul_status=$?
        if [ "$nul_status" -ne 1 ]; then
          echo "ERROR review-required invalid-artifact unreadable file=$review_artifact" >&2
          return 2
        fi
      fi
      land_normalize_identity() {
        tr -d '\r' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//; s/[[:space:]][[:space:]]*/ /g'
      }
      review_verdict_value=$(sed -n 's/^verdict:[[:space:]]*//p' "$review_artifact" | land_normalize_identity)
      reviewer_value=$(sed -n 's/^reviewer:[[:space:]]*//p' "$review_artifact" | land_normalize_identity)
      reviewed_sha_value=$(sed -n 's/^reviewed-sha:[[:space:]]*//p' "$review_artifact" | land_normalize_identity)
      independence_value=$(sed -n 's/^independence:[[:space:]]*//p' "$review_artifact" | land_normalize_identity)
      review_verdict_count=$(grep -c '^verdict:' "$review_artifact" || true)
      reviewer_count=$(grep -c '^reviewer:' "$review_artifact" || true)
      reviewed_sha_count=$(grep -c '^reviewed-sha:' "$review_artifact" || true)
      independence_count=$(grep -c '^independence:' "$review_artifact" || true)
      if [ "$review_verdict_value" = "REJECT" ]; then echo "ERROR review-rejected file=$review_artifact" >&2; return 2; fi
      if [ "$review_verdict_count" -ne 1 ] || [ "$review_verdict_value" != "ACCEPT" ] || [ "$reviewer_count" -ne 1 ] || [ -z "$reviewer_value" ] || [ "$reviewer_value" = "$branch" ]; then
        echo "ERROR review-required malformed-artifact file=$review_artifact" >&2
        return 2
      fi
      # Reviewer and independence fields are restricted to printable ASCII to make identity checks unambiguous.
      if printf '%s' "$reviewer_value" | LC_ALL=C grep -q '[^ -~]' || printf '%s' "$independence_value" | LC_ALL=C grep -q '[^ -~]'; then
        echo "ERROR review-required malformed-artifact unsafe-identity-field file=$review_artifact" >&2
        return 2
      fi
      commit_author_name=$(git -C "$repo" log -1 --format='%an' "$branch" | land_normalize_identity) || return 2
      commit_author_email=$(git -C "$repo" log -1 --format='%ae' "$branch" | land_normalize_identity) || return 2
      reviewer_name=$(printf '%s' "$reviewer_value" | sed -E 's/[[:space:]]*<[^<>]*>[[:space:]]*$//' | land_normalize_identity)
      reviewer_email=$(printf '%s' "$reviewer_value" | sed -nE 's/^.*<([^<>]*)>[[:space:]]*$/\1/p' | land_normalize_identity)
      if [ -z "$reviewer_email" ] && [[ "$reviewer_value" == *'@'* ]]; then reviewer_email="$reviewer_value"; fi
      reviewer_normalized=${reviewer_value,,}
      author_name_normalized=${commit_author_name,,}
      author_email_normalized=${commit_author_email,,}
      reviewer_name_tokens=$(printf '%s' "$reviewer_normalized" | LC_ALL=C sed 's/[^[:alnum:] ]/ /g; s/[[:space:]][[:space:]]*/ /g')
      author_name_tokens=$(printf '%s' "$author_name_normalized" | LC_ALL=C sed 's/[^[:alnum:] ]/ /g; s/[[:space:]][[:space:]]*/ /g')
      reviewer_name_sorted=$(printf '%s\n' "${reviewer_name,,}" | tr ' ' '\n' | LC_ALL=C sort | paste -sd ' ' -)
      author_name_sorted=$(printf '%s\n' "$author_name_normalized" | tr ' ' '\n' | LC_ALL=C sort | paste -sd ' ' -)
      if [ "${reviewer_name,,}" = "$author_name_normalized" ] || { [ -n "$author_name_sorted" ] && [ "$reviewer_name_sorted" = "$author_name_sorted" ]; } || { [ -n "$reviewer_email" ] && [ "${reviewer_email,,}" = "$author_email_normalized" ]; } || [[ "$reviewer_normalized" == *"$author_email_normalized"* ]] || { [ -n "$author_name_tokens" ] && [[ " $reviewer_name_tokens " == *" $author_name_tokens "* ]]; }; then
        echo "ERROR review-required self-authored-review file=$review_artifact" >&2
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
  local repo="$1" branch="$2" merge_base changed_file scan_result scan_status_line line_count diff_file diff_fd
  local scan_marker scan_show_status scan_grep_status secret_hits=0
  local secret_pattern added_diff_file candidate_file decoded_file candidate
  merge_base=$(git -C "$repo" merge-base "$LAND_DEFAULT_BRANCH" "$branch") || return 2
  secret_pattern=$(printf '%s%s%s%s%s%s%s%s%s%s%s' '[0-9]{8,10}:AA|' 'gh' 'p_|github' '_pat|client' '_secret|PRIVATE ' 'KEY|AK' 'IA[0-9A-Z]{16}|' 'sk' '-ant-|' '(^|[^0-9A-Za-z_-])AIza[0-9A-Za-z_-]{35}([^0-9A-Za-z_-]|$)|' '(^|[^0-9A-Za-z])xox[baprs]-[0-9A-Za-z-]{10,}([^0-9A-Za-z]|$)')
  diff_file=$(mktemp "${TMPDIR:-/tmp}/bpa-land-secret-diff.XXXXXX") || return 2
  if ! git -C "$repo" -c core.quotepath=false diff --name-only -z "$merge_base..$branch" > "$diff_file"; then
    rm -f "$diff_file"
    echo "LAND secret-scan unreadable path-list" >&2
    return 2
  fi
  exec {diff_fd}< "$diff_file"
  rm -f "$diff_file"
  while IFS= read -r -d '' changed_file; do
    scan_result=$(printf '%s' "$changed_file" | LC_ALL=C grep -aE -c "$secret_pattern"; scan_status=("${PIPESTATUS[@]}"); printf '__LAND_SCAN_STATUS__ %s %s\n' "${scan_status[0]}" "${scan_status[1]}")
    scan_status_line=${scan_result##*$'\n'}
    line_count=${scan_result%$'\n'*}
    read -r scan_marker scan_show_status scan_grep_status <<< "$scan_status_line"
    if [ "$scan_marker" != '__LAND_SCAN_STATUS__' ] || [ "$scan_show_status" -ne 0 ] || { [ "$scan_grep_status" -ne 0 ] && [ "$scan_grep_status" -ne 1 ]; }; then echo "LAND secret-scan unreadable path-list" >&2; exec {diff_fd}<&-; return 2; fi
    if [ "$line_count" -gt 0 ]; then echo "LAND secret-scan match path-name" >&2; secret_hits=$((secret_hits + line_count)); fi
  done <&"$diff_fd"
  exec {diff_fd}<&-
  diff_file=$(mktemp "${TMPDIR:-/tmp}/bpa-land-secret-content-diff.XXXXXX") || return 2
  if ! git -C "$repo" -c core.quotepath=false diff --name-only -z --diff-filter=ACMRT "$merge_base..$branch" > "$diff_file"; then
    rm -f "$diff_file"
    echo "LAND secret-scan unreadable path-list" >&2
    return 2
  fi
  exec {diff_fd}< "$diff_file"
  rm -f "$diff_file"
  while IFS= read -r -d '' changed_file; do
    [ -n "$changed_file" ] || continue
    if ! git -C "$repo" cat-file -e "$branch:$changed_file"; then echo "LAND secret-scan unreadable file=$changed_file" >&2; exec {diff_fd}<&-; return 2; fi
    scan_result=$(git -C "$repo" show "$branch:$changed_file" | LC_ALL=C grep -aE -c "$secret_pattern"; scan_status=("${PIPESTATUS[@]}"); printf '__LAND_SCAN_STATUS__ %s %s\n' "${scan_status[0]}" "${scan_status[1]}")
    scan_status_line=${scan_result##*$'\n'}
    line_count=${scan_result%$'\n'*}
    read -r scan_marker scan_show_status scan_grep_status <<< "$scan_status_line"
    if [ "$scan_marker" != '__LAND_SCAN_STATUS__' ] || [ "$scan_show_status" -ne 0 ] || { [ "$scan_grep_status" -ne 0 ] && [ "$scan_grep_status" -ne 1 ]; }; then echo "LAND secret-scan unreadable file=$changed_file" >&2; exec {diff_fd}<&-; return 2; fi
    if [ "$line_count" -gt 0 ]; then echo "LAND secret-scan match file=$changed_file lines=$line_count" >&2; secret_hits=$((secret_hits + line_count)); fi

    added_diff_file=$(mktemp "${TMPDIR:-/tmp}/bpa-land-secret-added.XXXXXX") || { exec {diff_fd}<&-; return 2; }
    candidate_file=$(mktemp "${TMPDIR:-/tmp}/bpa-land-secret-candidates.XXXXXX") || { rm -f "$added_diff_file"; exec {diff_fd}<&-; return 2; }
    decoded_file=$(mktemp "${TMPDIR:-/tmp}/bpa-land-secret-decoded.XXXXXX") || { rm -f "$added_diff_file" "$candidate_file"; exec {diff_fd}<&-; return 2; }
    if ! git -C "$repo" -c core.quotepath=false diff --no-ext-diff --unified=0 "$merge_base..$branch" -- "$changed_file" > "$added_diff_file"; then
      rm -f "$added_diff_file" "$candidate_file" "$decoded_file"
      echo "LAND secret-scan unreadable file=$changed_file" >&2
      exec {diff_fd}<&-
      return 2
    fi
    # Bound decoding to 1 MiB of added text and the first 64 candidate runs per file.
    sed -n '/^+++/d; s/^+//p' "$added_diff_file" |
      head -c 1048576 |
      LC_ALL=C grep -aoE '[A-Za-z0-9+/=]{16,}' |
      head -n 64 > "$candidate_file" || true
    while IFS= read -r candidate; do
      printf '%s' "$candidate" | base64 -d >> "$decoded_file" 2>/dev/null || true
      printf '\n' >> "$decoded_file"
    done < "$candidate_file"
    scan_result=$(LC_ALL=C grep -aE -c "$secret_pattern" "$decoded_file"; scan_grep_status=$?; printf '__LAND_SCAN_STATUS__ 0 %s\n' "$scan_grep_status")
    rm -f "$added_diff_file" "$candidate_file" "$decoded_file"
    scan_status_line=${scan_result##*$'\n'}
    line_count=${scan_result%$'\n'*}
    read -r scan_marker scan_show_status scan_grep_status <<< "$scan_status_line"
    if [ "$scan_marker" != '__LAND_SCAN_STATUS__' ] || [ "$scan_show_status" -ne 0 ] || { [ "$scan_grep_status" -ne 0 ] && [ "$scan_grep_status" -ne 1 ]; }; then echo "LAND secret-scan unreadable file=$changed_file" >&2; exec {diff_fd}<&-; return 2; fi
    if [ "$line_count" -gt 0 ]; then echo "LAND secret-scan decoded-match file=$changed_file lines=$line_count" >&2; secret_hits=$((secret_hits + line_count)); fi
  done <&"$diff_fd"
  exec {diff_fd}<&-
  [ "$secret_hits" -eq 0 ]
}

# Remote half of the reap: delete refs/heads/<branch> on origin and verify the
# absence with ls-remote before allowing a pass. Returns 0 only when ls-remote
# confirms the ref is absent on origin — either deleted now, or it never
# existed there (reported explicitly). Any push failure, lookup failure, or a
# ref still present after deletion returns 1 so the caller reports
# local-only/fail, never pass. allow_delete=false (no-push landings) refuses to
# delete a present remote ref: origin/main does not contain the merge yet, so
# deleting the remote lane ref could orphan the lane commits on origin.
land_remote_reap() {
  local repo="$1" branch="$2" prefix="$3" allow_delete="$4" listing
  if ! listing=$(git -C "$repo" ls-remote origin "refs/heads/$branch"); then
    echo "$prefix reap remote=unverified branch=$branch detail=ls-remote-failed" >&2
    return 1
  fi
  if [ -z "$listing" ]; then
    echo "$prefix reap remote=absent branch=$branch detail=never-on-origin-nothing-to-delete"
    return 0
  fi
  if [ "$allow_delete" != true ]; then
    echo "$prefix reap remote=present branch=$branch detail=no-push-remote-delete-refused" >&2
    return 1
  fi
  if ! git -C "$repo" push origin --delete "$branch"; then
    echo "$prefix reap remote=present branch=$branch detail=push-delete-failed" >&2
    return 1
  fi
  if ! listing=$(git -C "$repo" ls-remote origin "refs/heads/$branch"); then
    echo "$prefix reap remote=unverified branch=$branch detail=ls-remote-failed" >&2
    return 1
  fi
  if [ -n "$listing" ]; then
    echo "$prefix reap remote=present branch=$branch detail=still-on-origin-after-delete" >&2
    return 1
  fi
  echo "$prefix reap remote=deleted branch=$branch"
}

land_payload_guard() {
  local repo="$1" branch="$2" merge_base raw_entry changed_file diff_file diff_fd
  local old_mode new_mode change_status
  merge_base=$(git -C "$repo" merge-base "$LAND_DEFAULT_BRANCH" "$branch") || return 2
  diff_file=$(mktemp "${TMPDIR:-/tmp}/bpa-land-payload-diff.XXXXXX") || return 2
  if ! git -C "$repo" -c core.quotepath=false diff --raw -z --no-renames --diff-filter=AMT "$merge_base..$branch" > "$diff_file"; then
    rm -f "$diff_file"
    echo "LAND step=payload-guard status=fail detail=diff-unreadable branch=$branch" >&2
    return 2
  fi
  exec {diff_fd}< "$diff_file"
  rm -f "$diff_file"
  while IFS= read -r -d '' raw_entry; do
    IFS= read -r -d '' changed_file || { exec {diff_fd}<&-; return 2; }
    read -r old_mode new_mode _ _ change_status <<< "${raw_entry#:}"
    case "$change_status" in
      A|M|T)
        case "$new_mode" in
          120000|160000)
            echo "LAND step=payload-guard status=fail detail=mode-$new_mode path=$changed_file" >&2
            exec {diff_fd}<&-
            return 1
            ;;
          100755)
            if [ "$old_mode" != "100755" ] && [[ "$changed_file" != *.sh ]] && ! git -C "$repo" show "$branch:$changed_file" | head -c 2 | grep -Fqx '#!'; then
              echo "LAND step=payload-guard status=fail detail=unexpected-executable path=$changed_file" >&2
              exec {diff_fd}<&-
              return 1
            fi
            ;;
        esac
        ;;
    esac
  done <&"$diff_fd"
  exec {diff_fd}<&-
}
