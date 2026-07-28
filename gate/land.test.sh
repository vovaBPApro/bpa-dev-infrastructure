#!/usr/bin/env bash
set -euo pipefail

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
land="$root/gate/land.sh"
fixture_root=$(mktemp -d)
trap 'rm -rf "$fixture_root"' EXIT

assert() {
  if ! "$@"; then
    echo "assertion failed: $*" >&2
    exit 1
  fi
}

assert_not() {
  if "$@"; then
    echo "unexpected success: $*" >&2
    exit 1
  fi
}

make_fixture() {
  name="$1"
  bare="$fixture_root/$name-origin.git"
  repo="$fixture_root/$name-repo"
  git init --bare --initial-branch=main "$bare" >/dev/null
  git clone "$bare" "$repo" >/dev/null
  git -C "$repo" config user.email land@example.test
  git -C "$repo" config user.name Land
  printf 'base\n' > "$repo/base.txt"
  git -C "$repo" add base.txt
  git -C "$repo" commit -m base >/dev/null
  git -C "$repo" push -u origin main >/dev/null
  printf 'ref: refs/heads/main\n' > "$bare/HEAD"
}

make_lane() {
  repo="$1"
  lane="$2"
  git -C "$repo" checkout -b "$lane" >/dev/null
  printf 'lane\n' > "$repo/lane.txt"
  git -C "$repo" add lane.txt
  git -C "$repo" commit -m lane >/dev/null
  sha=$(git -C "$repo" rev-parse HEAD)
  git -C "$repo" checkout main >/dev/null
  printf '%s\n' "$sha"
}

report() {
  path="$1"
  sha="$2"
  printf 'commit: %s fixture\nverify: true\nresult: clean\nsecret-scan: clean\nremaining: none\n' "$sha" > "$path"
}

make_policy_lane() {
  repo="$1"
  lane="$2"
  git -C "$repo" checkout -b "$lane" >/dev/null
  mkdir -p "$repo/gate"
  printf 'policy change\n' > "$repo/gate/target.txt"
  git -C "$repo" add gate/target.txt
  git -C "$repo" commit -m policy-change >/dev/null
  sha=$(git -C "$repo" rev-parse HEAD)
  git -C "$repo" checkout main >/dev/null
  printf '%s\n' "$sha"
}

make_policy_deletion_lane() {
  repo="$1"
  lane="$2"
  mkdir -p "$repo/gate"
  printf 'policy base\n' > "$repo/gate/target.txt"
  git -C "$repo" add gate/target.txt
  git -C "$repo" commit -m policy-base >/dev/null
  git -C "$repo" push origin main >/dev/null
  git -C "$repo" checkout -b "$lane" >/dev/null
  git -C "$repo" rm gate/target.txt >/dev/null
  git -C "$repo" commit -m policy-delete >/dev/null
  sha=$(git -C "$repo" rev-parse HEAD)
  git -C "$repo" checkout main >/dev/null
  printf '%s\n' "$sha"
}

make_policy_rename_lane() {
  repo="$1"
  lane="$2"
  mkdir -p "$repo/gate"
  printf 'policy base\n' > "$repo/gate/target.txt"
  git -C "$repo" add gate/target.txt
  git -C "$repo" commit -m policy-base >/dev/null
  git -C "$repo" push origin main >/dev/null
  git -C "$repo" checkout -b "$lane" >/dev/null
  mkdir -p "$repo/safe"
  git -C "$repo" mv gate/target.txt safe/target.txt
  git -C "$repo" commit -m policy-rename >/dev/null
  sha=$(git -C "$repo" rev-parse HEAD)
  git -C "$repo" checkout main >/dev/null
  printf '%s\n' "$sha"
}

review() {
  path="$1"
  verdict="$2"
  reviewer="$3"
  printf 'verdict: %s\nreviewer: %s\n' "$verdict" "$reviewer" > "$path"
}

assert_output_has() {
  output="$1"
  expected="$2"
  assert grep -Fq "$expected" "$output"
}

assert_output_lacks() {
  output="$1"
  unexpected="$2"
  assert_not grep -Fq "$unexpected" "$output"
}

make_fixture review-missing
review_missing_sha=$(make_policy_lane "$fixture_root/review-missing-repo" ag-review-missing)
report "$fixture_root/review-missing-report.md" "$review_missing_sha"
review_missing_output="$fixture_root/review-missing-output.txt"
if "$land" --branch ag-review-missing --report "$fixture_root/review-missing-report.md" --repo "$fixture_root/review-missing-repo" >"$review_missing_output" 2>&1; then exit 1; fi
assert_output_has "$review_missing_output" 'ERROR review-required missing-artifact'
assert_output_lacks "$review_missing_output" 'LAND step=merge status=pass'
assert test "$(git -C "$fixture_root/review-missing-repo" rev-parse HEAD)" = "$(git -C "$fixture_root/review-missing-repo" rev-parse main)"

make_fixture review-malformed
review_malformed_sha=$(make_policy_lane "$fixture_root/review-malformed-repo" ag-review-malformed)
report "$fixture_root/review-malformed-report.md" "$review_malformed_sha"
printf 'verdict: ACCEPT\nreviewer:\n' > "$fixture_root/ag-review-malformed.review.md"
review_malformed_output="$fixture_root/review-malformed-output.txt"
if "$land" --branch ag-review-malformed --report "$fixture_root/review-malformed-report.md" --repo "$fixture_root/review-malformed-repo" >"$review_malformed_output" 2>&1; then exit 1; fi
assert_output_has "$review_malformed_output" 'ERROR review-required malformed-artifact'
assert_output_lacks "$review_malformed_output" 'LAND step=merge status=pass'

make_fixture review-rejected
review_rejected_sha=$(make_policy_lane "$fixture_root/review-rejected-repo" ag-review-rejected)
report "$fixture_root/review-rejected-report.md" "$review_rejected_sha"
review "$fixture_root/ag-review-rejected.review.md" REJECT independent-reviewer
review_rejected_output="$fixture_root/review-rejected-output.txt"
if "$land" --branch ag-review-rejected --report "$fixture_root/review-rejected-report.md" --repo "$fixture_root/review-rejected-repo" >"$review_rejected_output" 2>&1; then exit 1; fi
assert_output_has "$review_rejected_output" 'ERROR review-rejected'
assert_output_lacks "$review_rejected_output" 'LAND step=merge status=pass'

make_fixture review-self
review_self_sha=$(make_policy_lane "$fixture_root/review-self-repo" ag-review-self)
report "$fixture_root/review-self-report.md" "$review_self_sha"
review "$fixture_root/ag-review-self.review.md" ACCEPT ag-review-self
review_self_output="$fixture_root/review-self-output.txt"
if "$land" --branch ag-review-self --report "$fixture_root/review-self-report.md" --repo "$fixture_root/review-self-repo" >"$review_self_output" 2>&1; then exit 1; fi
assert_output_has "$review_self_output" 'ERROR review-required malformed-artifact'
assert_output_lacks "$review_self_output" 'LAND step=merge status=pass'

make_fixture review-self-trailing-space
review_self_trailing_space_sha=$(make_policy_lane "$fixture_root/review-self-trailing-space-repo" ag-review-self-trailing-space)
report "$fixture_root/review-self-trailing-space-report.md" "$review_self_trailing_space_sha"
printf 'verdict: ACCEPT\nreviewer: ag-review-self-trailing-space \n' > "$fixture_root/ag-review-self-trailing-space.review.md"
review_self_trailing_space_output="$fixture_root/review-self-trailing-space-output.txt"
if "$land" --branch ag-review-self-trailing-space --report "$fixture_root/review-self-trailing-space-report.md" --repo "$fixture_root/review-self-trailing-space-repo" >"$review_self_trailing_space_output" 2>&1; then exit 1; fi
assert_output_has "$review_self_trailing_space_output" 'ERROR review-required malformed-artifact'
assert_output_lacks "$review_self_trailing_space_output" 'LAND step=merge status=pass'

make_fixture review-policy-deletion
review_policy_deletion_sha=$(make_policy_deletion_lane "$fixture_root/review-policy-deletion-repo" ag-review-policy-deletion)
report "$fixture_root/review-policy-deletion-report.md" "$review_policy_deletion_sha"
review_policy_deletion_output="$fixture_root/review-policy-deletion-output.txt"
if "$land" --branch ag-review-policy-deletion --report "$fixture_root/review-policy-deletion-report.md" --repo "$fixture_root/review-policy-deletion-repo" >"$review_policy_deletion_output" 2>&1; then exit 1; fi
assert_output_has "$review_policy_deletion_output" 'ERROR review-required missing-artifact'
assert_output_lacks "$review_policy_deletion_output" 'LAND step=merge status=pass'
review "$fixture_root/ag-review-policy-deletion.review.md" ACCEPT independent-reviewer
"$land" --branch ag-review-policy-deletion --report "$fixture_root/review-policy-deletion-report.md" --repo "$fixture_root/review-policy-deletion-repo" --no-push >"$review_policy_deletion_output" 2>&1
assert_output_has "$review_policy_deletion_output" 'review=accepted'
assert git -C "$fixture_root/review-policy-deletion-repo" merge-base --is-ancestor "$review_policy_deletion_sha" HEAD

make_fixture review-policy-rename
review_policy_rename_sha=$(make_policy_rename_lane "$fixture_root/review-policy-rename-repo" ag-review-policy-rename)
report "$fixture_root/review-policy-rename-report.md" "$review_policy_rename_sha"
review_policy_rename_output="$fixture_root/review-policy-rename-output.txt"
if "$land" --branch ag-review-policy-rename --report "$fixture_root/review-policy-rename-report.md" --repo "$fixture_root/review-policy-rename-repo" >"$review_policy_rename_output" 2>&1; then exit 1; fi
assert_output_has "$review_policy_rename_output" 'ERROR review-required missing-artifact'
assert_output_lacks "$review_policy_rename_output" 'LAND step=merge status=pass'

make_fixture review-accepted
review_accepted_sha=$(make_policy_lane "$fixture_root/review-accepted-repo" ag-review-accepted)
report "$fixture_root/review-accepted-report.md" "$review_accepted_sha"
review "$fixture_root/ag-review-accepted.review.md" ACCEPT independent-reviewer
review_accepted_output="$fixture_root/review-accepted-output.txt"
"$land" --branch ag-review-accepted --report "$fixture_root/review-accepted-report.md" --repo "$fixture_root/review-accepted-repo" --no-push >"$review_accepted_output" 2>&1
assert_output_has "$review_accepted_output" 'LAND verdict=landed sha='
assert_output_has "$review_accepted_output" 'review=accepted'
assert git -C "$fixture_root/review-accepted-repo" merge-base --is-ancestor "$review_accepted_sha" HEAD

make_fixture review-skipped
review_skipped_sha=$(make_policy_lane "$fixture_root/review-skipped-repo" ag-review-skipped)
report "$fixture_root/review-skipped-report.md" "$review_skipped_sha"
review_skipped_output="$fixture_root/review-skipped-output.txt"
"$land" --branch ag-review-skipped --report "$fixture_root/review-skipped-report.md" --repo "$fixture_root/review-skipped-repo" --no-push --skip-review >"$review_skipped_output" 2>&1
assert_output_has "$review_skipped_output" 'WARN review-skipped'
assert_output_has "$review_skipped_output" 'review=skipped'
assert git -C "$fixture_root/review-skipped-repo" merge-base --is-ancestor "$review_skipped_sha" HEAD

make_fixture good
good_sha=$(make_lane "$fixture_root/good-repo" ag-good)
report "$fixture_root/good-report.md" "$good_sha"
"$land" --branch ag-good --report "$fixture_root/good-report.md" --repo "$fixture_root/good-repo" --run-verify
assert git -C "$fixture_root/good-repo" merge-base --is-ancestor "$good_sha" HEAD
assert test "$(git -C "$fixture_root/good-repo" rev-list --parents -n 1 HEAD | wc -w)" -eq 3
assert_not git -C "$fixture_root/good-repo" show-ref --verify --quiet refs/heads/ag-good
assert test "$(git --git-dir="$fixture_root/good-origin.git" rev-parse main)" = "$(git -C "$fixture_root/good-repo" rev-parse HEAD)"

make_fixture bun-home
bun_home_sha=$(make_lane "$fixture_root/bun-home-repo" ag-bun-home)
report "$fixture_root/bun-home-report.md" "$bun_home_sha"
bun_home="$fixture_root/bun-home"
mkdir -p "$bun_home/.bun/bin"
ln -s "$(command -v bun)" "$bun_home/.bun/bin/bun"
bun_home_output="$fixture_root/bun-home-output.txt"
env -i PATH=/usr/bin:/bin HOME="$bun_home" "$land" --branch ag-bun-home --report "$fixture_root/bun-home-report.md" --repo "$fixture_root/bun-home-repo" --no-push >"$bun_home_output" 2>&1
assert_output_has "$bun_home_output" 'LAND step=completion-guard status=pass'
assert_output_has "$bun_home_output" 'LAND verdict=landed sha='
assert git -C "$fixture_root/bun-home-repo" merge-base --is-ancestor "$bun_home_sha" HEAD

make_fixture bun-missing
bun_missing_sha=$(make_lane "$fixture_root/bun-missing-repo" ag-bun-missing)
report "$fixture_root/bun-missing-report.md" "$bun_missing_sha"
bun_missing_home="$fixture_root/bun-missing-home"
mkdir -p "$bun_missing_home"
bun_missing_output="$fixture_root/bun-missing-output.txt"
if env -i PATH=/usr/bin:/bin HOME="$bun_missing_home" "$land" --branch ag-bun-missing --report "$fixture_root/bun-missing-report.md" --repo "$fixture_root/bun-missing-repo" --no-push >"$bun_missing_output" 2>&1; then exit 1; fi
assert_output_has "$bun_missing_output" 'LAND step=preflight status=fail detail=bun-not-found'
assert_output_lacks "$bun_missing_output" 'LAND step=completion-guard status=fail'
assert test "$(git -C "$fixture_root/bun-missing-repo" rev-parse HEAD)" = "$(git -C "$fixture_root/bun-missing-repo" rev-parse main)"

make_fixture bad-sha
make_lane "$fixture_root/bad-sha-repo" ag-bad-sha >/dev/null
report "$fixture_root/bad-sha-report.md" "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
if "$land" --branch ag-bad-sha --report "$fixture_root/bad-sha-report.md" --repo "$fixture_root/bad-sha-repo"; then exit 1; fi
assert test "$(git -C "$fixture_root/bad-sha-repo" rev-parse HEAD)" = "$(git -C "$fixture_root/bad-sha-repo" rev-parse main)"
assert git -C "$fixture_root/bad-sha-repo" show-ref --verify --quiet refs/heads/ag-bad-sha

make_fixture secret
secret_sha=$(make_lane "$fixture_root/secret-repo" ag-secret)
secret_prefix=$(printf '%s%s' 'gh' 'p_')
secret_suffix=$(printf 'x%.0s' $(seq 1 36))
printf '%s%s\n' "$secret_prefix" "$secret_suffix" > "$fixture_root/secret-repo/secret.txt"
git -C "$fixture_root/secret-repo" checkout ag-secret >/dev/null
git -C "$fixture_root/secret-repo" add secret.txt
git -C "$fixture_root/secret-repo" commit -m secret >/dev/null
secret_sha=$(git -C "$fixture_root/secret-repo" rev-parse HEAD)
git -C "$fixture_root/secret-repo" checkout main >/dev/null
report "$fixture_root/secret-report.md" "$secret_sha"
secret_output="$fixture_root/secret-output.txt"
if "$land" --branch ag-secret --report "$fixture_root/secret-report.md" --repo "$fixture_root/secret-repo" >"$secret_output" 2>&1; then exit 1; fi
assert_output_has "$secret_output" 'LAND step=secret-scan status=fail'
assert_output_lacks "$secret_output" "${secret_prefix}${secret_suffix}"
assert test "$(git -C "$fixture_root/secret-repo" rev-parse HEAD)" = "$(git -C "$fixture_root/secret-repo" rev-parse main)"

make_fixture typechange-secret
printf 'public\n' > "$fixture_root/typechange-secret-repo/public.txt"
ln -s public.txt "$fixture_root/typechange-secret-repo/swap.txt"
git -C "$fixture_root/typechange-secret-repo" add public.txt swap.txt
git -C "$fixture_root/typechange-secret-repo" commit -m symlink-base >/dev/null
git -C "$fixture_root/typechange-secret-repo" push origin main >/dev/null
typechange_secret_sha=$(make_lane "$fixture_root/typechange-secret-repo" ag-typechange-secret)
typechange_secret_prefix=$(printf '%s%s' 'gh' 'p_')
typechange_secret_value="${typechange_secret_prefix}$(printf 't%.0s' $(seq 1 36))"
git -C "$fixture_root/typechange-secret-repo" checkout ag-typechange-secret >/dev/null
rm "$fixture_root/typechange-secret-repo/swap.txt"
printf '%s\n' "$typechange_secret_value" > "$fixture_root/typechange-secret-repo/swap.txt"
git -C "$fixture_root/typechange-secret-repo" add swap.txt
git -C "$fixture_root/typechange-secret-repo" commit -m typechange-secret >/dev/null
typechange_secret_sha=$(git -C "$fixture_root/typechange-secret-repo" rev-parse HEAD)
git -C "$fixture_root/typechange-secret-repo" checkout main >/dev/null
report "$fixture_root/typechange-secret-report.md" "$typechange_secret_sha"
typechange_secret_output="$fixture_root/typechange-secret-output.txt"
if "$land" --branch ag-typechange-secret --report "$fixture_root/typechange-secret-report.md" --repo "$fixture_root/typechange-secret-repo" >"$typechange_secret_output" 2>&1; then exit 1; fi
assert_output_has "$typechange_secret_output" 'LAND step=secret-scan status=fail'
assert_output_lacks "$typechange_secret_output" "$typechange_secret_value"
assert test "$(git -C "$fixture_root/typechange-secret-repo" rev-parse HEAD)" = "$(git -C "$fixture_root/typechange-secret-repo" rev-parse main)"

make_fixture binary-secret
binary_secret_sha=$(make_lane "$fixture_root/binary-secret-repo" ag-binary-secret)
binary_secret_prefix=$(printf '%s%s' 'gh' 'p_')
binary_secret_value="${binary_secret_prefix}$(printf 'b%.0s' $(seq 1 36))"
git -C "$fixture_root/binary-secret-repo" checkout ag-binary-secret >/dev/null
printf 'prefix\0%s\0suffix\n' "$binary_secret_value" > "$fixture_root/binary-secret-repo/blob.bin"
git -C "$fixture_root/binary-secret-repo" add blob.bin
git -C "$fixture_root/binary-secret-repo" commit -m binary-secret >/dev/null
binary_secret_sha=$(git -C "$fixture_root/binary-secret-repo" rev-parse HEAD)
git -C "$fixture_root/binary-secret-repo" checkout main >/dev/null
report "$fixture_root/binary-secret-report.md" "$binary_secret_sha"
binary_secret_output="$fixture_root/binary-secret-output.txt"
if "$land" --branch ag-binary-secret --report "$fixture_root/binary-secret-report.md" --repo "$fixture_root/binary-secret-repo" >"$binary_secret_output" 2>&1; then exit 1; fi
assert_output_has "$binary_secret_output" 'LAND step=secret-scan status=fail'
assert_output_lacks "$binary_secret_output" "$binary_secret_value"
assert test "$(git -C "$fixture_root/binary-secret-repo" rev-parse HEAD)" = "$(git -C "$fixture_root/binary-secret-repo" rev-parse main)"

make_fixture unicode-secret
unicode_secret_sha=$(make_lane "$fixture_root/unicode-secret-repo" ag-unicode-secret)
unicode_secret_prefix=$(printf '%s%s' 'gh' 'p_')
unicode_secret_value="${unicode_secret_prefix}$(printf 'u%.0s' $(seq 1 36))"
git -C "$fixture_root/unicode-secret-repo" checkout ag-unicode-secret >/dev/null
printf '%s\n' "$unicode_secret_value" > "$fixture_root/unicode-secret-repo/секрет.txt"
git -C "$fixture_root/unicode-secret-repo" add 'секрет.txt'
git -C "$fixture_root/unicode-secret-repo" commit -m unicode-secret >/dev/null
unicode_secret_sha=$(git -C "$fixture_root/unicode-secret-repo" rev-parse HEAD)
git -C "$fixture_root/unicode-secret-repo" checkout main >/dev/null
report "$fixture_root/unicode-secret-report.md" "$unicode_secret_sha"
unicode_secret_output="$fixture_root/unicode-secret-output.txt"
if "$land" --branch ag-unicode-secret --report "$fixture_root/unicode-secret-report.md" --repo "$fixture_root/unicode-secret-repo" >"$unicode_secret_output" 2>&1; then exit 1; fi
assert_output_has "$unicode_secret_output" 'LAND step=secret-scan status=fail'
assert_output_lacks "$unicode_secret_output" "$unicode_secret_value"
assert test "$(git -C "$fixture_root/unicode-secret-repo" rev-parse HEAD)" = "$(git -C "$fixture_root/unicode-secret-repo" rev-parse main)"

make_fixture merge-conflict
git -C "$fixture_root/merge-conflict-repo" checkout -b ag-merge-conflict >/dev/null
printf 'lane change\n' > "$fixture_root/merge-conflict-repo/base.txt"
git -C "$fixture_root/merge-conflict-repo" add base.txt
git -C "$fixture_root/merge-conflict-repo" commit -m lane-conflict >/dev/null
merge_conflict_sha=$(git -C "$fixture_root/merge-conflict-repo" rev-parse HEAD)
git -C "$fixture_root/merge-conflict-repo" checkout main >/dev/null
printf 'main change\n' > "$fixture_root/merge-conflict-repo/base.txt"
git -C "$fixture_root/merge-conflict-repo" add base.txt
git -C "$fixture_root/merge-conflict-repo" commit -m main-conflict >/dev/null
git -C "$fixture_root/merge-conflict-repo" push origin main >/dev/null
report "$fixture_root/merge-conflict-report.md" "$merge_conflict_sha"
merge_conflict_output="$fixture_root/merge-conflict-output.txt"
if "$land" --branch ag-merge-conflict --report "$fixture_root/merge-conflict-report.md" --repo "$fixture_root/merge-conflict-repo" >"$merge_conflict_output" 2>&1; then exit 1; fi
assert_output_has "$merge_conflict_output" 'LAND step=merge status=fail'
assert_not git -C "$fixture_root/merge-conflict-repo" rev-parse --verify --quiet MERGE_HEAD
assert test -z "$(git -C "$fixture_root/merge-conflict-repo" status --porcelain)"

make_fixture verify-fail
verify_fail_sha=$(make_lane "$fixture_root/verify-fail-repo" ag-verify-fail)
verify_fail_before=$(git -C "$fixture_root/verify-fail-repo" rev-parse HEAD)
printf 'commit: %s fixture\nverify: test ! -f lane.txt\nresult: clean\nsecret-scan: clean\nremaining: none\n' "$verify_fail_sha" > "$fixture_root/verify-fail-report.md"
verify_fail_output="$fixture_root/verify-fail-output.txt"
if "$land" --branch ag-verify-fail --report "$fixture_root/verify-fail-report.md" --repo "$fixture_root/verify-fail-repo" --run-verify >"$verify_fail_output" 2>&1; then exit 1; fi
assert_output_has "$verify_fail_output" 'LAND step=post-merge-verify status=fail'
assert_output_has "$verify_fail_output" 'merge reset to ORIG_HEAD'
assert test "$(git -C "$fixture_root/verify-fail-repo" rev-parse HEAD)" = "$verify_fail_before"
assert git -C "$fixture_root/verify-fail-repo" show-ref --verify --quiet refs/heads/ag-verify-fail

make_fixture reap-fail
reap_fail_sha=$(make_lane "$fixture_root/reap-fail-repo" ag-reap-fail)
report "$fixture_root/reap-fail-report.md" "$reap_fail_sha"
git -C "$fixture_root/reap-fail-repo" worktree add "$fixture_root/reap-fail-worktree" ag-reap-fail >/dev/null
reap_fail_output="$fixture_root/reap-fail-output.txt"
if "$land" --branch ag-reap-fail --report "$fixture_root/reap-fail-report.md" --repo "$fixture_root/reap-fail-repo" >"$reap_fail_output" 2>&1; then exit 1; fi
assert_output_has "$reap_fail_output" 'LAND verdict=landed-reap-failed sha='
assert_not grep -Fq 'LAND verdict=aborted' "$reap_fail_output"
assert test "$(git --git-dir="$fixture_root/reap-fail-origin.git" rev-parse main)" = "$(git -C "$fixture_root/reap-fail-repo" rev-parse HEAD)"

make_fixture no-push
no_push_sha=$(make_lane "$fixture_root/no-push-repo" ag-no-push)
report "$fixture_root/no-push-report.md" "$no_push_sha"
origin_before=$(git --git-dir="$fixture_root/no-push-origin.git" rev-parse main)
no_push_output="$fixture_root/no-push-output.txt"
"$land" --branch ag-no-push --report "$fixture_root/no-push-report.md" --repo "$fixture_root/no-push-repo" --no-push >"$no_push_output" 2>&1
assert_output_has "$no_push_output" 'LAND step=post-merge-verify status=skipped'
assert_output_has "$no_push_output" 'LAND step=push status=skipped'
assert test "$(git --git-dir="$fixture_root/no-push-origin.git" rev-parse main)" = "$origin_before"

make_fixture no-push-reap-fail
no_push_reap_fail_sha=$(make_lane "$fixture_root/no-push-reap-fail-repo" ag-no-push-reap-fail)
report "$fixture_root/no-push-reap-fail-report.md" "$no_push_reap_fail_sha"
origin_before=$(git --git-dir="$fixture_root/no-push-reap-fail-origin.git" rev-parse main)
git -C "$fixture_root/no-push-reap-fail-repo" worktree add "$fixture_root/no-push-reap-fail-worktree" ag-no-push-reap-fail >/dev/null
no_push_reap_fail_output="$fixture_root/no-push-reap-fail-output.txt"
if "$land" --branch ag-no-push-reap-fail --report "$fixture_root/no-push-reap-fail-report.md" --repo "$fixture_root/no-push-reap-fail-repo" --no-push >"$no_push_reap_fail_output" 2>&1; then exit 1; fi
assert_output_has "$no_push_reap_fail_output" 'LAND verdict=landed-local-reap-failed sha='
assert_not grep -Fq 'LAND verdict=aborted' "$no_push_reap_fail_output"
assert git -C "$fixture_root/no-push-reap-fail-repo" merge-base --is-ancestor "$no_push_reap_fail_sha" HEAD
assert test "$(git --git-dir="$fixture_root/no-push-reap-fail-origin.git" rev-parse main)" = "$origin_before"

make_fixture stale-main
stale_main_sha=$(make_lane "$fixture_root/stale-main-repo" ag-stale-main)
report "$fixture_root/stale-main-report.md" "$stale_main_sha"
git clone "$fixture_root/stale-main-origin.git" "$fixture_root/stale-main-peer" >/dev/null
git -C "$fixture_root/stale-main-peer" config user.email peer@example.test
git -C "$fixture_root/stale-main-peer" config user.name Peer
printf 'remote advance\n' > "$fixture_root/stale-main-peer/remote.txt"
git -C "$fixture_root/stale-main-peer" add remote.txt
git -C "$fixture_root/stale-main-peer" commit -m remote-advance >/dev/null
git -C "$fixture_root/stale-main-peer" push origin main >/dev/null
stale_main_output="$fixture_root/stale-main-output.txt"
if "$land" --branch ag-stale-main --report "$fixture_root/stale-main-report.md" --repo "$fixture_root/stale-main-repo" >"$stale_main_output" 2>&1; then exit 1; fi
assert_output_has "$stale_main_output" 'LAND step=freshness status=fail'
assert test "$(git -C "$fixture_root/stale-main-repo" rev-parse main)" != "$(git -C "$fixture_root/stale-main-repo" rev-parse origin/main)"

make_fixture lock
lock_sha=$(make_lane "$fixture_root/lock-repo" ag-lock)
report "$fixture_root/lock-report.md" "$lock_sha"
lock_ready="$fixture_root/lock-ready"
flock "$fixture_root/lock-repo/.git/bpa-land.lock" sh -c "touch '$lock_ready'; sleep 2" &
lock_pid=$!
while [ ! -e "$lock_ready" ]; do sleep 0.1; done
lock_output="$fixture_root/lock-output.txt"
if "$land" --branch ag-lock --report "$fixture_root/lock-report.md" --repo "$fixture_root/lock-repo" >"$lock_output" 2>&1; then exit 1; fi
wait "$lock_pid"
assert_output_has "$lock_output" 'LAND step=lock status=fail'
assert test "$(git -C "$fixture_root/lock-repo" rev-parse main)" = "$(git -C "$fixture_root/lock-repo" rev-parse origin/main)"
assert git -C "$fixture_root/lock-repo" show-ref --verify --quiet refs/heads/ag-lock

make_fixture push-rollback
push_rollback_sha=$(make_lane "$fixture_root/push-rollback-repo" ag-push-rollback)
report "$fixture_root/push-rollback-report.md" "$push_rollback_sha"
printf '#!/usr/bin/env bash\nexit 1\n' > "$fixture_root/push-rollback-origin.git/hooks/pre-receive"
chmod +x "$fixture_root/push-rollback-origin.git/hooks/pre-receive"
push_rollback_output="$fixture_root/push-rollback-output.txt"
if "$land" --branch ag-push-rollback --report "$fixture_root/push-rollback-report.md" --repo "$fixture_root/push-rollback-repo" >"$push_rollback_output" 2>&1; then exit 1; fi
assert_output_has "$push_rollback_output" 'LAND step=push status=fail'
assert_output_has "$push_rollback_output" 'main reset to origin/main'
assert test "$(git -C "$fixture_root/push-rollback-repo" rev-parse main)" = "$(git -C "$fixture_root/push-rollback-repo" rev-parse origin/main)"
assert git -C "$fixture_root/push-rollback-repo" show-ref --verify --quiet refs/heads/ag-push-rollback

make_fixture payload-symlink
git -C "$fixture_root/payload-symlink-repo" checkout -b ag-payload-symlink >/dev/null
ln -s /home/user/.env "$fixture_root/payload-symlink-repo/env.template"
git -C "$fixture_root/payload-symlink-repo" add env.template
git -C "$fixture_root/payload-symlink-repo" commit -m payload-symlink >/dev/null
payload_symlink_sha=$(git -C "$fixture_root/payload-symlink-repo" rev-parse HEAD)
git -C "$fixture_root/payload-symlink-repo" checkout main >/dev/null
report "$fixture_root/payload-symlink-report.md" "$payload_symlink_sha"
payload_symlink_output="$fixture_root/payload-symlink-output.txt"
if "$land" --branch ag-payload-symlink --report "$fixture_root/payload-symlink-report.md" --repo "$fixture_root/payload-symlink-repo" >"$payload_symlink_output" 2>&1; then exit 1; fi
assert_output_has "$payload_symlink_output" 'LAND step=payload-guard status=fail detail=mode-120000'
assert_output_lacks "$payload_symlink_output" 'LAND step=merge status=pass'

make_fixture payload-gitlink
git -C "$fixture_root/payload-gitlink-repo" checkout -b ag-payload-gitlink >/dev/null
gitlink_sha=$(git -C "$fixture_root/payload-gitlink-repo" rev-parse main)
git -C "$fixture_root/payload-gitlink-repo" update-index --add --cacheinfo "160000,$gitlink_sha,modules/example"
git -C "$fixture_root/payload-gitlink-repo" commit -m payload-gitlink >/dev/null
payload_gitlink_sha=$(git -C "$fixture_root/payload-gitlink-repo" rev-parse HEAD)
git -C "$fixture_root/payload-gitlink-repo" checkout main >/dev/null
report "$fixture_root/payload-gitlink-report.md" "$payload_gitlink_sha"
payload_gitlink_output="$fixture_root/payload-gitlink-output.txt"
if "$land" --branch ag-payload-gitlink --report "$fixture_root/payload-gitlink-report.md" --repo "$fixture_root/payload-gitlink-repo" >"$payload_gitlink_output" 2>&1; then exit 1; fi
assert_output_has "$payload_gitlink_output" 'LAND step=payload-guard status=fail detail=mode-160000'
assert_output_lacks "$payload_gitlink_output" 'LAND step=merge status=pass'

make_fixture executable-shell
git -C "$fixture_root/executable-shell-repo" checkout -b ag-executable-shell >/dev/null
printf '#!/usr/bin/env bash\necho safe\n' > "$fixture_root/executable-shell-repo/deploy.sh"
chmod +x "$fixture_root/executable-shell-repo/deploy.sh"
git -C "$fixture_root/executable-shell-repo" add deploy.sh
git -C "$fixture_root/executable-shell-repo" commit -m executable-shell >/dev/null
executable_shell_sha=$(git -C "$fixture_root/executable-shell-repo" rev-parse HEAD)
git -C "$fixture_root/executable-shell-repo" checkout main >/dev/null
report "$fixture_root/executable-shell-report.md" "$executable_shell_sha"
"$land" --branch ag-executable-shell --report "$fixture_root/executable-shell-report.md" --repo "$fixture_root/executable-shell-repo" --no-push >"$fixture_root/executable-shell-output.txt" 2>&1
assert_output_has "$fixture_root/executable-shell-output.txt" 'LAND step=payload-guard status=pass'

echo "land tests: pass"
