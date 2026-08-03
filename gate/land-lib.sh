#!/usr/bin/env bash
# Shared fail-closed checks for individual and batch landing.

# Resolve the canonical changed-range base. Normal landings set
# LAND_DEFAULT_BRANCH to their integration branch; standalone family scans may
# set it to a remote ref such as origin/v3. An orphan family whose remote ref is
# not present is scanned from its own root commit instead of failing open.
land_changed_base() {
  local repo="$1" branch="$2" base_ref="${LAND_DEFAULT_BRANCH:-main}" merge_base
  if git -C "$repo" rev-parse --verify --quiet "${base_ref}^{commit}" >/dev/null; then
    merge_base=$(git -C "$repo" merge-base "$base_ref" "$branch") || return 2
    printf '%s\n' "$merge_base"
    return 0
  fi
  git -C "$repo" rev-list --max-parents=0 --reverse "$branch" | head -n 1
}

# A lock file is "stale" only when no live process holds an OPEN FILE
# DESCRIPTOR on it, matched by resolved path (not name, so a deleted and
# recreated file at the same path is never conflated with the file a live
# process actually has open) by scanning every /proc/<pid>/fd entry on the
# host. This is the check that closes the TOCTOU a plain unconditional
# `rm -f` had: a coder-authored `verify:` command can spawn a git subprocess
# that is killed OR still running when the gate reads the command's exit
# status. If it is still running and later writes into the index, deleting
# its lock out from under it would let it clobber the checkout again after
# land_force_reset has already verified it clean.
#
# Fail-closed: if liveness cannot be determined at all (e.g. /proc is
# unavailable on this host), the lock is NOT considered stale -- land_force_reset
# must then fail through to the caller's land_fail_rollback rather than guess.
#
# Candidate pids are walked one directory at a time rather than through the
# single combined glob `/proc/[0-9]*/fd/*`: when a candidate's own fd/
# directory is unreadable (mode 0700, owned by a UID this scanner is not
# running as -- e.g. a root-owned process left behind by a verify: step that
# used sudo or Docker, scanned by a non-root land.sh, or the reverse), bash's
# default glob expansion silently contributes NOTHING for that pid -- no
# error, no non-zero status, no indication anything was skipped. The loop
# would then finish having never inspected that holder and report "stale"
# for a lock that is genuinely live. Inability to inspect a candidate is
# inability to prove it is not the holder, so an unreadable fd/ directory
# fails the whole check closed instead of being globbed away.
#
# The readability requirement only applies to pids that could plausibly HOLD
# this lock in the first place: opening a file inside this repo's .git
# directory requires either matching the repo owner's uid (this scanner's own
# EUID) or root's blanket write access (e.g. via sudo or Docker, per the
# comment above). A pid owned by any other uid cannot be the holder no matter
# what its fd/ directory contains, so an unreadable fd/ for a foreign,
# non-root, non-self uid is skipped rather than treated as an inspection
# failure -- on a real host, most pids belong to other users, and requiring
# visibility into all of them turned the recovery branch into dead code for
# every non-root invocation. The owning uid itself is read from the pid
# directory's own stat, which -- unlike fd/ -- stays world-readable.
land_lock_is_stale() {
  local lock_file="$1" real self_uid pid_dir pid_uid fd_dir fd_link fd_target
  [ -e "$lock_file" ] || return 0
  [ -d /proc ] || return 1
  real=$(readlink -f -- "$lock_file" 2>/dev/null) || return 1
  [ -n "$real" ] || return 1
  self_uid=$(id -u) || return 1
  for pid_dir in /proc/[0-9]*; do
    [ -d "$pid_dir" ] || continue
    pid_uid=$(stat -c '%u' "$pid_dir" 2>/dev/null) || continue
    case "$pid_uid" in
      0|"$self_uid") ;;
      *) continue ;;
    esac
    fd_dir="$pid_dir/fd"
    [ -r "$fd_dir" ] || return 1
    for fd_link in "$fd_dir"/*; do
      [ -e "$fd_link" ] || continue
      fd_target=$(readlink -f -- "$fd_link" 2>/dev/null) || continue
      if [ "$fd_target" = "$real" ]; then
        return 1
      fi
    done
  done
  return 0
}

# Hard-reset $repo's checked-out branch to $target and PROVE it landed there
# -- both the ref position AND a clean tree -- before returning success.
# `git reset --hard` can fail without `set -e` noticing (this repo's scripts
# intentionally don't set -e), and a plain `git reset --hard ORIG_HEAD
# >/dev/null` swallowed that failure completely: the caller printed "reset to
# ORIG_HEAD" and reported an aborted landing while the ref sat wherever the
# merge left it. Observed cause: a coder-authored `verify:` command (or a
# declared package.json script) that spawns a git process which is killed or
# still running when the gate reads its exit status leaves a stale
# $GIT_DIR/index.lock behind, and every subsequent `git reset --hard` in that
# worktree fails the same way.
#
# land.sh holds an exclusive flock on this repo's own bpa-land.lock for its
# entire runtime (see the `exec 9>"$lock_file"` / `flock -n 9` pair near the
# top of gate/land.sh), so no *other* land.sh invocation can be concurrently
# mutating this checkout -- that hazard is closed structurally. What is NOT
# closed structurally is a lock some other live process (e.g. the verify
# command's own still-running child) legitimately holds; land_lock_is_stale
# is what tells the two apart, and a live lock is left untouched rather than
# deleted.
#
# Returns 0 only when $repo's HEAD is verified to equal the resolved commit
# for $target AND `git status --porcelain` is empty afterward -- ref position
# alone is not proof of a restored tree; reset --hard never removes untracked
# debris a failed verify/declared-check left behind, and a live writer could
# still leave the index dirty even after HEAD looks right. A caller that gets
# a non-zero return MUST NOT report a plain "aborted" verdict: local state may
# not have been restored, and the report contract requires "aborted" to mean
# the ref did not move and the tree is clean.
land_force_reset() {
  local repo="$1" target="$2" git_dir lock_file target_sha actual_sha status_output
  git_dir=$(git -C "$repo" rev-parse --git-dir 2>/dev/null) || return 1
  case "$git_dir" in
    /*) lock_file="$git_dir/index.lock" ;;
    *) lock_file="$repo/$git_dir/index.lock" ;;
  esac
  target_sha=$(git -C "$repo" rev-parse --verify -q "${target}^{commit}" 2>/dev/null) || return 1
  if ! git -C "$repo" reset --hard "$target_sha" >/dev/null 2>&1; then
    if land_lock_is_stale "$lock_file"; then
      rm -f "$lock_file" 2>/dev/null || true
      git -C "$repo" reset --hard "$target_sha" >/dev/null 2>&1 || true
    fi
  fi
  actual_sha=$(git -C "$repo" rev-parse -q --verify HEAD 2>/dev/null) || return 1
  [ "$actual_sha" = "$target_sha" ] || return 1
  status_output=$(git -C "$repo" status --porcelain 2>/dev/null) || return 1
  [ -z "$status_output" ]
}

land_resolve_bun() {
  local name candidate resolved trusted_path='/usr/local/bin:/usr/bin:/bin'
  if [ -n "${BUN_BIN:-}" ]; then
    echo "LAND step=preflight status=fail detail=caller-bun-override-refused" >&2
    return 1
  fi

  candidate=$(PATH="$trusted_path" command -v bun 2>/dev/null || true)
  resolved=$(readlink -f -- "$candidate" 2>/dev/null || true)
  if [ -z "$resolved" ] || [ ! -f "$resolved" ] || [ ! -x "$resolved" ]; then
    echo "LAND step=preflight status=fail detail=bun-not-found" >&2
    return 1
  fi

  BUN_BIN="$resolved"
  export BUN_BIN

  # Declared checks are an untrusted boundary. Resolve only from the fixed host
  # baseline, canonicalize symlinks, and discard every caller binary selector.
  LAND_CHECK_PATH="$trusted_path"
  for name in node pnpm npx tsc; do
    candidate=$(PATH="$trusted_path" command -v "$name" 2>/dev/null || true)
    [ -z "$candidate" ] && continue
    resolved=$(readlink -f -- "$candidate" 2>/dev/null || true)
    if [ -z "$resolved" ] || [ ! -f "$resolved" ] || [ ! -x "$resolved" ]; then
      echo "LAND step=preflight status=fail detail=invalid-verifier verifier=$name" >&2
      return 1
    fi
  done
  export LAND_CHECK_PATH
}

# Run every root quality script whose declaration makes it part of the landing
# contract. A missing package.json means there are no root package checks; an
# unreadable/malformed manifest or a declared script that cannot run is a hard
# failure. The gate never installs dependencies: changing dependency state is
# outside landing authority, and a non-reproducible checkout must be refused.
land_run_declared_checks() {
  local repo="$1" prefix="$2" minimum_test_count="${3:-0}" manifest="$repo/package.json" scripts_file script parse_dir bun_config test_output test_count pass_count
  local -a source_files=() test_files=()
  parse_dir=$(mktemp -d "${TMPDIR:-/tmp}/bpa-land-parse.XXXXXX") || return 1
  echo "$prefix declared-check=parse status=running"
  mapfile -d '' -t source_files < <(git -C "$repo" ls-files -z -- '*.js' '*.jsx' '*.mjs' '*.cjs' '*.ts' '*.tsx')
  for script in "${source_files[@]}"; do
    if ! (cd "$repo" && "$BUN_BIN" build --no-bundle --outfile="$parse_dir/output" -- "$script") >/dev/null 2>&1; then
      rm -rf "$parse_dir"
      echo "$prefix declared-check=parse status=fail" >&2
      return 1
    fi
  done
  rm -rf "$parse_dir"
  echo "$prefix declared-check=parse status=pass"

  # A package script is candidate-controlled orchestration, not test evidence.
  # Corroborate it first by giving the pinned framework an explicit immutable
  # list of tracked tests and an empty config outside the candidate tree. This
  # happens before any declared wrapper can rewrite the checkout.
  while IFS= read -r -d '' script; do
    case "$script" in
      *.test.js|*.test.jsx|*.test.mjs|*.test.cjs|*.test.ts|*.test.tsx|*.spec.js|*.spec.jsx|*.spec.mjs|*.spec.cjs|*.spec.ts|*.spec.tsx|*_test.js|*_test.jsx|*_test.mjs|*_test.cjs|*_test.ts|*_test.tsx|*_spec.js|*_spec.jsx|*_spec.mjs|*_spec.cjs|*_spec.ts|*_spec.tsx)
        test_files+=("$script")
        ;;
    esac
  done < <(git -C "$repo" ls-files -z)
  if [ "${#test_files[@]}" -gt 0 ]; then
    bun_config=$(mktemp "${TMPDIR:-/tmp}/bpa-land-bunfig.XXXXXX.toml") || return 1
    test_output=$(mktemp "${TMPDIR:-/tmp}/bpa-land-test-output.XXXXXX") || { rm -f "$bun_config"; return 1; }
    echo "$prefix framework-check=test status=running"
    if ! (cd "$repo" && env -i HOME="${HOME:-/nonexistent}" CI=1 PATH="$LAND_CHECK_PATH" \
      "$BUN_BIN" test --config "$bun_config" -- "${test_files[@]}") >"$test_output" 2>&1; then
      cat "$test_output"
      rm -f "$bun_config" "$test_output"
      echo "$prefix framework-check=test status=fail" >&2
      return 1
    fi
    cat "$test_output"
    test_count=$(sed -nE 's/^Ran ([0-9]+) tests? across .*/\1/p' "$test_output" | tail -n 1)
    pass_count=$(sed -nE 's/^[[:space:]]*([0-9]+) pass$/\1/p' "$test_output" | tail -n 1)
    rm -f "$bun_config" "$test_output"
    if [[ ! "$test_count" =~ ^[0-9]+$ ]] || [ "$test_count" -eq 0 ]; then
      echo "$prefix framework-check=test status=fail tests=${test_count:-unknown} detail=no-tests-collected" >&2
      return 1
    fi
    if [[ ! "$pass_count" =~ ^[0-9]+$ ]] || [ "$pass_count" -eq 0 ]; then
      echo "$prefix framework-check=test status=fail tests=$test_count passed=${pass_count:-unknown} detail=no-tests-passed" >&2
      return 1
    fi
    LAND_FRAMEWORK_TEST_COUNT="$test_count"
    if [ "$test_count" -lt "$minimum_test_count" ]; then
      echo "$prefix framework-check=test status=fail tests=$test_count baseline=$minimum_test_count detail=test-count-regressed" >&2
      return 1
    fi
    echo "$prefix framework-check=test status=pass tests=$test_count passed=$pass_count"
  else
    echo "$prefix framework-check=test status=fail tests=0 detail=no-tests-tracked" >&2
    return 1
  fi
  if [ ! -e "$manifest" ]; then
    echo "$prefix declared-checks=none"
    return 0
  fi
  if [ ! -f "$manifest" ] || [ ! -r "$manifest" ]; then
    echo "$prefix declared-checks=refused detail=manifest-unreadable" >&2
    return 1
  fi
  scripts_file=$(mktemp "${TMPDIR:-/tmp}/bpa-land-scripts.XXXXXX") || return 1
  if ! "$BUN_BIN" -e '
    const manifest = await Bun.file(process.argv[1]).json();
    if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) process.exit(2);
    if (manifest.scripts !== undefined && (manifest.scripts === null || typeof manifest.scripts !== "object" || Array.isArray(manifest.scripts))) process.exit(2);
    for (const name of ["lint", "test"]) {
      if (Object.prototype.hasOwnProperty.call(manifest.scripts ?? {}, name)) {
        if (typeof manifest.scripts[name] !== "string" || manifest.scripts[name].trim() === "") process.exit(2);
        if (/(^|[^A-Za-z0-9_])(PATH|BUN_BIN|NODE(?:_BIN)?|PNPM(?:_BIN)?|NPX(?:_BIN)?|TSC(?:_BIN)?)\s*=/.test(manifest.scripts[name])) process.exit(2);
        console.log(name);
      }
    }
  ' "$manifest" >"$scripts_file"; then
    rm -f "$scripts_file"
    echo "$prefix declared-checks=refused detail=manifest-invalid" >&2
    return 1
  fi
  if [ ! -s "$scripts_file" ]; then
    rm -f "$scripts_file"
    echo "$prefix declared-checks=none"
    return 0
  fi
  while IFS= read -r script; do
    echo "$prefix declared-check=$script status=running"
    if ! (cd "$repo" && env -i HOME="${HOME:-/nonexistent}" CI=1 \
      PATH="$LAND_CHECK_PATH" "$BUN_BIN" run "$script"); then
      rm -f "$scripts_file"
      echo "$prefix declared-check=$script status=fail" >&2
      return 1
    fi
    echo "$prefix declared-check=$script status=pass"
  done < "$scripts_file"
  rm -f "$scripts_file"
}

# The meteorite installs this repository in a clean Ubuntu container and runs
# every tracked test. Consequently every tracked change can affect that proof.
# Only retained report artifacts and .gitignore are excluded: neither a Markdown
# suffix nor a rename is evidence that a file is content-only.
land_meteorite_required() {
  local repo="$1" branch="$2" base path
  base=$(land_changed_base "$repo" "$branch") || return 2
  while IFS= read -r path; do
    case "$path" in
      reports/*|.gitignore) ;;
      *) return 0 ;;
    esac
  done < <(git -C "$repo" diff --name-only "$base...$branch")
  return 1
}

land_validate_meteorite_report() {
  local report="$1" sha="$2"
  [ -s "$report" ] || return 1
  awk -v expected_sha="${sha,,}" '
    BEGIN {
      required["container-start"] = 1
      required["prerequisites"] = 1
      required["clone"] = 1
      required["sha-verification"] = 1
      required["bootstrap-test-prerequisites"] = 1
      required["bootstrap-dry-run"] = 1
      required["bootstrap-install"] = 1
      required["bootstrap-verify-source"] = 1
      required["test-prerequisites"] = 1
      required["full-test-suite"] = 1
      required["unit-drift"] = 1
    }
    /^- requested SHA: `/ {
      requested_count++
      value = $0; sub(/^- requested SHA: `/, "", value); sub(/`$/, "", value)
      requested = tolower(value)
      next
    }
    /^- tested SHA: `/ {
      tested_count++
      value = $0; sub(/^- tested SHA: `/, "", value); sub(/`$/, "", value)
      tested = tolower(value)
      next
    }
    /^- result: / { result_count++; result = substr($0, 11); next }
    /^- blocker: / { blocker_count++; blocker = substr($0, 12); next }
    /^## Stages$/ { stages_heading_count++; in_stages = 1; next }
    /^## / { in_stages = 0; next }
    in_stages && /^- [a-z0-9-]+: / {
      line = substr($0, 3)
      split(line, parts, ": ")
      stage_count[parts[1]]++
      stage_result[parts[1]] = parts[2]
    }
    END {
      if (requested_count != 1 || tested_count != 1 || result_count != 1 || blocker_count != 1 || stages_heading_count != 1) exit 1
      if (requested != expected_sha || tested != expected_sha || result != "clean" || blocker != "none") exit 1
      for (stage in required) if (stage_count[stage] != 1 || stage_result[stage] != "PASS") exit 1
    }
  ' "$report"
}

land_run_meteorite() {
  local repo="$1" sha="$2" report docker_bin timeout_seconds prover_status
  docker_bin=$(command -v docker 2>/dev/null || true)
  if [ -z "$docker_bin" ]; then
    echo "LAND meteorite blocker=docker-binary-unavailable" >&2
    return 1
  fi
  if ! "$docker_bin" info >/dev/null 2>&1; then
    echo "LAND meteorite blocker=docker-daemon-unavailable" >&2
    return 1
  fi
  if [ ! -r "$repo/meteorite/prove-candidate.sh" ]; then
    echo "LAND meteorite blocker=candidate-prover-unavailable" >&2
    return 1
  fi
  report=$(mktemp "${TMPDIR:-/tmp}/bpa-land-meteorite.XXXXXX.md") || {
    echo "LAND meteorite blocker=report-allocation-failed" >&2
    return 1
  }
  timeout_seconds="${LAND_METEORITE_TIMEOUT_SECONDS:-900}"
  if [[ ! "$timeout_seconds" =~ ^[1-9][0-9]*$ ]]; then
    rm -f "$report"
    echo "LAND meteorite blocker=invalid-timeout" >&2
    return 1
  fi
  echo "LAND meteorite status=running sha=$sha"
  prover_status=0
  METEORITE_REPORT="$report" timeout --foreground --kill-after=10 "$timeout_seconds" \
    bash "$repo/meteorite/prove-candidate.sh" --ref "$sha" || prover_status=$?
  if [ "$prover_status" -eq 124 ] || [ "$prover_status" -eq 137 ]; then
    rm -f "$report"
    echo "LAND meteorite blocker=rebuild-proof-timeout" >&2
    return 1
  fi
  if [ "$prover_status" -ne 0 ]; then
    rm -f "$report"
    echo "LAND meteorite blocker=rebuild-proof-failed" >&2
    return 1
  fi
  if ! land_validate_meteorite_report "$report" "$sha"; then
    rm -f "$report"
    echo "LAND meteorite blocker=rebuild-proof-evidence-invalid" >&2
    return 1
  fi
  rm -f "$report"
  echo "LAND meteorite status=pass sha=$sha"
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
  merge_base=$(land_changed_base "$repo" "$branch") || return 2
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
  merge_base=$(land_changed_base "$repo" "$branch") || return 2
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

# Ref deletion is allowed only after the landed integration tip contains every
# commit reachable from the lane. This is deliberately checked immediately
# before reap instead of being inferred from an earlier successful merge: a
# hook, interrupted retry, or future landing-flow change must not turn branch
# cleanup into loss of unmerged work.
#
# Coupling: hygiene/reap.sh's periodic branch sweep also calls this function
# for its own merge-safety judgment (in addition to its own, stricter,
# always-refuse-a-live-worktree rule). A change here changes both call sites.
land_assert_reap_safe() {
  local repo="$1" branch="$2" landed_tip="$3" prefix="$4" worktree_ref worktree_path
  local cherry_output dirty_output unique_merges worktrees
  if ! git -C "$repo" show-ref --verify --quiet "refs/heads/$branch"; then
    if git -C "$repo" ls-remote --exit-code origin "refs/heads/$branch" >/dev/null 2>&1; then
      echo "$prefix reap safety=refused branch=$branch detail=remote-only" >&2
    else
      echo "$prefix reap safety=refused branch=$branch detail=local-ref-missing" >&2
    fi
    return 1
  fi

  if ! worktrees=$(git -C "$repo" worktree list --porcelain); then
    echo "$prefix reap safety=refused branch=$branch detail=worktree-check-failed" >&2
    return 1
  fi
  worktree_path=""
  while IFS= read -r worktree_ref; do
    case "$worktree_ref" in
      worktree\ *) worktree_path=${worktree_ref#worktree } ;;
      "branch refs/heads/$branch")
        if [ -n "$worktree_path" ]; then
          if ! dirty_output=$(git -C "$worktree_path" status --porcelain --untracked-files=normal); then
            echo "$prefix reap safety=refused branch=$branch detail=worktree-check-failed worktree=$worktree_path" >&2
            return 1
          fi
          if [ -n "$dirty_output" ]; then
            echo "$prefix reap safety=refused branch=$branch detail=dirty-worktree worktree=$worktree_path" >&2
            return 1
          fi
        fi
        ;;
    esac
  done <<< "$worktrees"

  # `git cherry` compares stable patch ids, so a commit replayed or squashed
  # onto main is carried even when the lane tip is not its ancestor. A `+`
  # means that the lane still has a patch with no equivalent on the landed tip.
  if ! cherry_output=$(git -C "$repo" cherry "$landed_tip" "$branch"); then
    echo "$prefix reap safety=refused branch=$branch detail=content-check-failed" >&2
    return 1
  fi
  unique_merges=$(git -C "$repo" rev-list --merges "$landed_tip..$branch") || {
    echo "$prefix reap safety=refused branch=$branch detail=content-check-failed" >&2
    return 1
  }
  if [[ "$cherry_output" == *"+ "* ]] || [ -n "$unique_merges" ]; then
    echo "$prefix reap safety=refused branch=$branch detail=unique-content" >&2
    return 1
  fi
  echo "$prefix reap safety=pass branch=$branch carried-by=$landed_tip"
}

# Compare an optional report claim with the output of the verify command that
# the gate itself just ran. The completion guard validates the claim's syntax.
land_verify_count() {
  local report="$1" output_file="$2" claim passed failed
  claim=$(sed -n 's/^verify-count:[[:space:]]*//p' "$report")
  [ -n "$claim" ] || return 0
  passed=$(awk 'BEGIN { IGNORECASE=1 } /^[0-9]+ pass(ed)?$/ { count++; value=$1 } END { if (count == 1) print value }' "$output_file")
  failed=$(awk 'BEGIN { IGNORECASE=1 } /^[0-9]+ fail(ed)?$/ { count++; value=$1 } END { if (count == 1) print value }' "$output_file")
  if [ -z "$passed" ] || [ -z "$failed" ]; then
    echo "LAND verify-count output=missing-unambiguous-pass/fail-count" >&2
    return 1
  fi
  if [ "$claim" != "$passed/$failed" ]; then
    echo "LAND verify-count mismatch report=$claim actual=$passed/$failed" >&2
    return 1
  fi
  echo "LAND verify-count match=$passed/$failed"
}

land_payload_guard() {
  local repo="$1" branch="$2" merge_base raw_entry changed_file diff_file diff_fd
  local old_mode new_mode change_status
  merge_base=$(land_changed_base "$repo" "$branch") || return 2
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
