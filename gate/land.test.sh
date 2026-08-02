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

assert_output_has() {
  output="$1"
  expected="$2"
  assert grep -Fq "$expected" "$output"
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
  printf 'import { test, expect } from "bun:test"; test("fixture", () => expect(true).toBe(true));\n' > "$repo/base.test.ts"
  git -C "$repo" add base.txt base.test.ts
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

make_fixture zero-tests
zero_before=$(git -C "$repo" rev-parse main)
git -C "$repo" checkout -b ag-zero-tests >/dev/null
printf 'import { test } from "bun:test"; void test;\n' > "$repo/base.test.ts"
git -C "$repo" add base.test.ts
git -C "$repo" commit -m zero-tests >/dev/null
zero_sha=$(git -C "$repo" rev-parse HEAD)
git -C "$repo" checkout main >/dev/null
report "$fixture_root/zero-tests.md" "$zero_sha"
if "$land" --branch ag-zero-tests --report "$fixture_root/zero-tests.md" --repo "$repo" --no-push >"$fixture_root/zero-tests.out" 2>&1; then
  echo 'zero-tests: single gate accepted an empty suite' >&2
  exit 1
fi
assert_output_has "$fixture_root/zero-tests.out" 'LAND framework-check=test status=fail tests=0 detail=no-tests-collected'
assert test "$(git -C "$repo" rev-parse main)" = "$zero_before"

make_fixture skipped-tests
skipped_before=$(git -C "$repo" rev-parse main)
git -C "$repo" checkout -b ag-skipped-tests >/dev/null
printf 'import { test } from "bun:test"; test.skip("never runs", () => { throw new Error("must fail"); });\n' > "$repo/base.test.ts"
git -C "$repo" add base.test.ts
git -C "$repo" commit -m skipped-tests >/dev/null
skipped_sha=$(git -C "$repo" rev-parse HEAD)
git -C "$repo" checkout main >/dev/null
report "$fixture_root/skipped-tests.md" "$skipped_sha"
if "$land" --branch ag-skipped-tests --report "$fixture_root/skipped-tests.md" --repo "$repo" --no-push >"$fixture_root/skipped-tests.out" 2>&1; then
  echo 'skipped-tests: single gate accepted a suite with no passing tests' >&2
  exit 1
fi
assert_output_has "$fixture_root/skipped-tests.out" 'LAND framework-check=test status=fail tests=1 passed=0 detail=no-tests-passed'
assert test "$(git -C "$repo" rev-parse main)" = "$skipped_before"

make_fixture count-collapse
printf 'import { test, expect } from "bun:test";\nfor (const n of [1, 2, 3]) test(`baseline ${n}`, () => expect(true).toBe(true));\n' > "$repo/base.test.ts"
git -C "$repo" commit -am baseline-three-tests >/dev/null
git -C "$repo" push origin main >/dev/null
collapse_before=$(git -C "$repo" rev-parse main)
git -C "$repo" checkout -b ag-count-collapse >/dev/null
printf 'import { test, expect } from "bun:test"; test("trivial survivor", () => expect(true).toBe(true));\n' > "$repo/base.test.ts"
git -C "$repo" commit -am collapse-to-one-test >/dev/null
collapse_sha=$(git -C "$repo" rev-parse HEAD)
git -C "$repo" checkout main >/dev/null
report "$fixture_root/count-collapse.md" "$collapse_sha"
if "$land" --branch ag-count-collapse --report "$fixture_root/count-collapse.md" --repo "$repo" --no-push >"$fixture_root/count-collapse.out" 2>&1; then
  echo 'count-collapse: single gate accepted a reduced test count' >&2
  exit 1
fi
assert_output_has "$fixture_root/count-collapse.out" 'LAND framework-check=test status=fail tests=1 baseline=3 detail=test-count-regressed'
assert test "$(git -C "$repo" rev-parse main)" = "$collapse_before"

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
  reviewed_sha="$4"
  independence="$5"
  printf 'verdict: %s\nreviewer: %s\nreviewed-sha: %s\nindependence: %s\n' "$verdict" "$reviewer" "$reviewed_sha" "$independence" > "$path"
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
review "$fixture_root/ag-review-rejected.review.md" REJECT independent-reviewer "$review_rejected_sha" separate-session
review_rejected_output="$fixture_root/review-rejected-output.txt"
if "$land" --branch ag-review-rejected --report "$fixture_root/review-rejected-report.md" --repo "$fixture_root/review-rejected-repo" >"$review_rejected_output" 2>&1; then exit 1; fi
assert_output_has "$review_rejected_output" 'ERROR review-rejected'
assert_output_lacks "$review_rejected_output" 'LAND step=merge status=pass'

make_fixture review-self
review_self_sha=$(make_policy_lane "$fixture_root/review-self-repo" ag-review-self)
report "$fixture_root/review-self-report.md" "$review_self_sha"
review "$fixture_root/ag-review-self.review.md" ACCEPT ag-review-self "$review_self_sha" separate-session
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

make_fixture review-self-authored
review_self_authored_sha=$(make_policy_lane "$fixture_root/review-self-authored-repo" ag-review-self-authored)
report "$fixture_root/review-self-authored-report.md" "$review_self_authored_sha"
review "$fixture_root/ag-review-self-authored.review.md" ACCEPT ' land <LAND@EXAMPLE.TEST> ' "$review_self_authored_sha" separate-session
review_self_authored_output="$fixture_root/review-self-authored-output.txt"
if "$land" --branch ag-review-self-authored --report "$fixture_root/review-self-authored-report.md" --repo "$fixture_root/review-self-authored-repo" >"$review_self_authored_output" 2>&1; then exit 1; fi
assert_output_has "$review_self_authored_output" 'ERROR review-required self-authored-review'
assert_output_lacks "$review_self_authored_output" 'LAND step=merge status=pass'

make_fixture review-self-author-name
review_self_author_name_sha=$(make_policy_lane "$fixture_root/review-self-author-name-repo" ag-review-self-author-name)
report "$fixture_root/review-self-author-name-report.md" "$review_self_author_name_sha"
review "$fixture_root/ag-review-self-author-name.review.md" ACCEPT land "$review_self_author_name_sha" separate-session
review_self_author_name_output="$fixture_root/review-self-author-name-output.txt"
if "$land" --branch ag-review-self-author-name --report "$fixture_root/review-self-author-name-report.md" --repo "$fixture_root/review-self-author-name-repo" >"$review_self_author_name_output" 2>&1; then exit 1; fi
assert_output_has "$review_self_author_name_output" 'ERROR review-required self-authored-review'
assert_output_lacks "$review_self_author_name_output" 'LAND step=merge status=pass'

make_fixture review-self-author-email
review_self_author_email_sha=$(make_policy_lane "$fixture_root/review-self-author-email-repo" ag-review-self-author-email)
report "$fixture_root/review-self-author-email-report.md" "$review_self_author_email_sha"
review "$fixture_root/ag-review-self-author-email.review.md" ACCEPT LAND@EXAMPLE.TEST "$review_self_author_email_sha" separate-session
review_self_author_email_output="$fixture_root/review-self-author-email-output.txt"
if "$land" --branch ag-review-self-author-email --report "$fixture_root/review-self-author-email-report.md" --repo "$fixture_root/review-self-author-email-repo" >"$review_self_author_email_output" 2>&1; then exit 1; fi
assert_output_has "$review_self_author_email_output" 'ERROR review-required self-authored-review'
assert_output_lacks "$review_self_author_email_output" 'LAND step=merge status=pass'

make_fixture review-self-author-reordered
git -C "$fixture_root/review-self-author-reordered-repo" config user.name 'First Last'
review_self_author_reordered_sha=$(make_policy_lane "$fixture_root/review-self-author-reordered-repo" ag-review-self-author-reordered)
report "$fixture_root/review-self-author-reordered-report.md" "$review_self_author_reordered_sha"
review "$fixture_root/ag-review-self-author-reordered.review.md" ACCEPT 'Last First <spoofed@example.test>' "$review_self_author_reordered_sha" separate-session
review_self_author_reordered_output="$fixture_root/review-self-author-reordered-output.txt"
if "$land" --branch ag-review-self-author-reordered --report "$fixture_root/review-self-author-reordered-report.md" --repo "$fixture_root/review-self-author-reordered-repo" >"$review_self_author_reordered_output" 2>&1; then exit 1; fi
assert_output_has "$review_self_author_reordered_output" 'ERROR review-required self-authored-review'
assert_output_lacks "$review_self_author_reordered_output" 'LAND step=merge status=pass'

make_fixture review-self-author-crlf
review_self_author_crlf_sha=$(make_policy_lane "$fixture_root/review-self-author-crlf-repo" ag-review-self-author-crlf)
report "$fixture_root/review-self-author-crlf-report.md" "$review_self_author_crlf_sha"
printf 'verdict: ACCEPT\r\nreviewer: Land\r\nreviewed-sha: %s\r\nindependence: separate-session\r\n' "$review_self_author_crlf_sha" > "$fixture_root/ag-review-self-author-crlf.review.md"
review_self_author_crlf_output="$fixture_root/review-self-author-crlf-output.txt"
if "$land" --branch ag-review-self-author-crlf --report "$fixture_root/review-self-author-crlf-report.md" --repo "$fixture_root/review-self-author-crlf-repo" >"$review_self_author_crlf_output" 2>&1; then exit 1; fi
assert_output_has "$review_self_author_crlf_output" 'ERROR review-required self-authored-review'
assert_output_lacks "$review_self_author_crlf_output" 'LAND step=merge status=pass'

make_fixture review-nul-artifact
review_nul_artifact_sha=$(make_policy_lane "$fixture_root/review-nul-artifact-repo" ag-review-nul-artifact)
report "$fixture_root/review-nul-artifact-report.md" "$review_nul_artifact_sha"
printf 'verdict: ACCEPT\nreviewer: land\0x <other@example.test>\nreviewed-sha: %s\nindependence: separate-session\n' "$review_nul_artifact_sha" > "$fixture_root/ag-review-nul-artifact.review.md"
review_nul_artifact_output="$fixture_root/review-nul-artifact-output.txt"
if "$land" --branch ag-review-nul-artifact --report "$fixture_root/review-nul-artifact-report.md" --repo "$fixture_root/review-nul-artifact-repo" >"$review_nul_artifact_output" 2>&1; then exit 1; fi
assert_output_has "$review_nul_artifact_output" 'ERROR review-required invalid-artifact nul-byte'
assert_output_lacks "$review_nul_artifact_output" 'LAND step=merge status=pass'

make_fixture review-independent-identity
review_independent_identity_sha=$(make_policy_lane "$fixture_root/review-independent-identity-repo" ag-review-independent-identity)
report "$fixture_root/review-independent-identity-report.md" "$review_independent_identity_sha"
review "$fixture_root/ag-review-independent-identity.review.md" ACCEPT 'Other Reviewer <other@example.test>' "$review_independent_identity_sha" separate-session
review_independent_identity_output="$fixture_root/review-independent-identity-output.txt"
"$land" --branch ag-review-independent-identity --report "$fixture_root/review-independent-identity-report.md" --repo "$fixture_root/review-independent-identity-repo" --no-push >"$review_independent_identity_output" 2>&1
assert_output_has "$review_independent_identity_output" 'LAND verdict=landed sha='
assert_output_has "$review_independent_identity_output" 'review=accepted'

make_fixture review-artifact-symlink
review_artifact_symlink_sha=$(make_policy_lane "$fixture_root/review-artifact-symlink-repo" ag-review-artifact-symlink)
report "$fixture_root/review-artifact-symlink-report.md" "$review_artifact_symlink_sha"
review "$fixture_root/review-artifact-target.md" ACCEPT independent-reviewer "$review_artifact_symlink_sha" separate-session
ln -s "$fixture_root/review-artifact-target.md" "$fixture_root/ag-review-artifact-symlink.review.md"
review_artifact_symlink_output="$fixture_root/review-artifact-symlink-output.txt"
if "$land" --branch ag-review-artifact-symlink --report "$fixture_root/review-artifact-symlink-report.md" --repo "$fixture_root/review-artifact-symlink-repo" >"$review_artifact_symlink_output" 2>&1; then exit 1; fi
assert_output_has "$review_artifact_symlink_output" 'ERROR review-required invalid-artifact non-regular-file'
assert_output_lacks "$review_artifact_symlink_output" 'LAND step=merge status=pass'

make_fixture review-unicode-identity
review_unicode_identity_sha=$(make_policy_lane "$fixture_root/review-unicode-identity-repo" ag-review-unicode-identity)
report "$fixture_root/review-unicode-identity-report.md" "$review_unicode_identity_sha"
review "$fixture_root/ag-review-unicode-identity.review.md" ACCEPT 'independent-reviewerο' "$review_unicode_identity_sha" separate-session
review_unicode_identity_output="$fixture_root/review-unicode-identity-output.txt"
if "$land" --branch ag-review-unicode-identity --report "$fixture_root/review-unicode-identity-report.md" --repo "$fixture_root/review-unicode-identity-repo" >"$review_unicode_identity_output" 2>&1; then exit 1; fi
assert_output_has "$review_unicode_identity_output" 'ERROR review-required malformed-artifact unsafe-identity-field'
assert_output_lacks "$review_unicode_identity_output" 'LAND step=merge status=pass'

make_fixture review-policy-deletion
review_policy_deletion_sha=$(make_policy_deletion_lane "$fixture_root/review-policy-deletion-repo" ag-review-policy-deletion)
report "$fixture_root/review-policy-deletion-report.md" "$review_policy_deletion_sha"
review_policy_deletion_output="$fixture_root/review-policy-deletion-output.txt"
if "$land" --branch ag-review-policy-deletion --report "$fixture_root/review-policy-deletion-report.md" --repo "$fixture_root/review-policy-deletion-repo" >"$review_policy_deletion_output" 2>&1; then exit 1; fi
assert_output_has "$review_policy_deletion_output" 'ERROR review-required missing-artifact'
assert_output_lacks "$review_policy_deletion_output" 'LAND step=merge status=pass'
review "$fixture_root/ag-review-policy-deletion.review.md" ACCEPT independent-reviewer "$review_policy_deletion_sha" separate-session
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
review "$fixture_root/ag-review-accepted.review.md" ACCEPT independent-reviewer "$review_accepted_sha" separate-session
review_accepted_output="$fixture_root/review-accepted-output.txt"
"$land" --branch ag-review-accepted --report "$fixture_root/review-accepted-report.md" --repo "$fixture_root/review-accepted-repo" --no-push >"$review_accepted_output" 2>&1
assert_output_has "$review_accepted_output" 'LAND verdict=landed sha='
assert_output_has "$review_accepted_output" 'review=accepted'
assert git -C "$fixture_root/review-accepted-repo" merge-base --is-ancestor "$review_accepted_sha" HEAD

make_fixture review-stale-sha
review_stale_sha=$(make_policy_lane "$fixture_root/review-stale-sha-repo" ag-review-stale-sha)
report "$fixture_root/review-stale-sha-report.md" "$review_stale_sha"
review "$fixture_root/ag-review-stale-sha.review.md" ACCEPT independent-reviewer aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa separate-session
review_stale_output="$fixture_root/review-stale-sha-output.txt"
if "$land" --branch ag-review-stale-sha --report "$fixture_root/review-stale-sha-report.md" --repo "$fixture_root/review-stale-sha-repo" >"$review_stale_output" 2>&1; then exit 1; fi
assert_output_has "$review_stale_output" 'ERROR review-required stale-artifact reviewed-sha-mismatch'

make_fixture review-missing-sha
review_missing_sha=$(make_policy_lane "$fixture_root/review-missing-sha-repo" ag-review-missing-sha)
report "$fixture_root/review-missing-sha-report.md" "$review_missing_sha"
printf 'verdict: ACCEPT\nreviewer: independent-reviewer\nindependence: separate-session\n' > "$fixture_root/ag-review-missing-sha.review.md"
review_missing_sha_output="$fixture_root/review-missing-sha-output.txt"
if "$land" --branch ag-review-missing-sha --report "$fixture_root/review-missing-sha-report.md" --repo "$fixture_root/review-missing-sha-repo" >"$review_missing_sha_output" 2>&1; then exit 1; fi
assert_output_has "$review_missing_sha_output" "line='reviewed-sha: <40-hex>'"

make_fixture review-missing-independence
review_missing_independence_sha=$(make_policy_lane "$fixture_root/review-missing-independence-repo" ag-review-missing-independence)
report "$fixture_root/review-missing-independence-report.md" "$review_missing_independence_sha"
printf 'verdict: ACCEPT\nreviewer: independent-reviewer\nreviewed-sha: %s\n' "$review_missing_independence_sha" > "$fixture_root/ag-review-missing-independence.review.md"
review_missing_independence_output="$fixture_root/review-missing-independence-output.txt"
if "$land" --branch ag-review-missing-independence --report "$fixture_root/review-missing-independence-report.md" --repo "$fixture_root/review-missing-independence-repo" >"$review_missing_independence_output" 2>&1; then exit 1; fi
assert_output_has "$review_missing_independence_output" "line='independence: <text>'"

make_fixture review-skipped
review_skipped_sha=$(make_policy_lane "$fixture_root/review-skipped-repo" ag-review-skipped)
report "$fixture_root/review-skipped-report.md" "$review_skipped_sha"
review_skipped_output="$fixture_root/review-skipped-output.txt"
if "$land" --branch ag-review-skipped --report "$fixture_root/review-skipped-report.md" --repo "$fixture_root/review-skipped-repo" --no-push --skip-review >"$review_skipped_output" 2>&1; then exit 1; fi
assert_output_has "$review_skipped_output" 'usage: gate/land.sh'
if "$land" --branch ag-review-skipped --report "$fixture_root/review-skipped-report.md" --repo "$fixture_root/review-skipped-repo" --no-push --skip-review '   ' >"$review_skipped_output" 2>&1; then exit 1; fi
assert_output_has "$review_skipped_output" 'usage: gate/land.sh'
"$land" --branch ag-review-skipped --report "$fixture_root/review-skipped-report.md" --repo "$fixture_root/review-skipped-repo" --no-push --skip-review 'emergency rollback window' >"$review_skipped_output" 2>&1
assert_output_has "$review_skipped_output" 'WARN review-skipped'
assert_output_has "$review_skipped_output" 'review=skipped'
assert_output_has "$review_skipped_output" 'LAND review=SKIPPED reason=emergency rollback window'
assert grep -Fq $'branch=ag-review-skipped\tsha=' "$fixture_root/review-skipped-repo/orchestrator/runtime/review-skips.log"
assert grep -Fq $'reason=emergency rollback window' "$fixture_root/review-skipped-repo/orchestrator/runtime/review-skips.log"
assert git -C "$fixture_root/review-skipped-repo" merge-base --is-ancestor "$review_skipped_sha" HEAD

make_fixture good
good_sha=$(make_lane "$fixture_root/good-repo" ag-good)
report "$fixture_root/good-report.md" "$good_sha"
good_output="$fixture_root/good-output.txt"
"$land" --branch ag-good --report "$fixture_root/good-report.md" --repo "$fixture_root/good-repo" --run-verify >"$good_output" 2>&1
assert_output_has "$good_output" 'LAND reap remote=absent branch=ag-good detail=never-on-origin-nothing-to-delete'
assert_output_has "$good_output" 'LAND step=reap status=pass'
assert git -C "$fixture_root/good-repo" merge-base --is-ancestor "$good_sha" HEAD
assert test "$(git -C "$fixture_root/good-repo" rev-list --parents -n 1 HEAD | wc -w)" -eq 3
assert_not git -C "$fixture_root/good-repo" show-ref --verify --quiet refs/heads/ag-good
assert test "$(git --git-dir="$fixture_root/good-origin.git" rev-parse main)" = "$(git -C "$fixture_root/good-repo" rev-parse HEAD)"

make_fixture declared-check-fail
declared_before=$(git -C "$fixture_root/declared-check-fail-repo" rev-parse main)
git -C "$fixture_root/declared-check-fail-repo" checkout -b ag-declared-check-fail >/dev/null
printf '{"scripts":{"lint":"echo declared-lint-ran && false","test":"echo declared-test-ran"}}\n' > "$fixture_root/declared-check-fail-repo/package.json"
git -C "$fixture_root/declared-check-fail-repo" add package.json
git -C "$fixture_root/declared-check-fail-repo" commit -m declared-check-fail >/dev/null
declared_sha=$(git -C "$fixture_root/declared-check-fail-repo" rev-parse HEAD)
git -C "$fixture_root/declared-check-fail-repo" checkout main >/dev/null
report "$fixture_root/declared-check-fail-report.md" "$declared_sha"
declared_output="$fixture_root/declared-check-fail-output.txt"
if "$land" --branch ag-declared-check-fail --report "$fixture_root/declared-check-fail-report.md" --repo "$fixture_root/declared-check-fail-repo" --no-push >"$declared_output" 2>&1; then exit 1; fi
assert_output_has "$declared_output" 'LAND declared-check=lint status=running'
assert_output_has "$declared_output" 'declared-lint-ran'
assert_output_has "$declared_output" 'LAND step=declared-checks status=fail'
assert test "$(git -C "$fixture_root/declared-check-fail-repo" rev-parse main)" = "$declared_before"

make_fixture rewritten-test
rewritten_before=$(git -C "$fixture_root/rewritten-test-repo" rev-parse main)
git -C "$fixture_root/rewritten-test-repo" checkout -b ag-rewritten-test >/dev/null
printf '{"scripts":{"test":"./test-wrapper.sh"}}\n' > "$fixture_root/rewritten-test-repo/package.json"
printf '#!/bin/sh\ncp passing.txt real.test.ts\nexit 0\n' > "$fixture_root/rewritten-test-repo/test-wrapper.sh"
printf 'import { test, expect } from "bun:test"; test("real", () => expect(true).toBe(false));\n' > "$fixture_root/rewritten-test-repo/real.test.ts"
printf 'import { test, expect } from "bun:test"; test("real", () => expect(true).toBe(true));\n' > "$fixture_root/rewritten-test-repo/passing.txt"
chmod +x "$fixture_root/rewritten-test-repo/test-wrapper.sh"
git -C "$fixture_root/rewritten-test-repo" add package.json test-wrapper.sh real.test.ts passing.txt
git -C "$fixture_root/rewritten-test-repo" commit -m rewritten-test >/dev/null
rewritten_sha=$(git -C "$fixture_root/rewritten-test-repo" rev-parse HEAD)
git -C "$fixture_root/rewritten-test-repo" checkout main >/dev/null
report "$fixture_root/rewritten-test-report.md" "$rewritten_sha"
if "$land" --branch ag-rewritten-test --report "$fixture_root/rewritten-test-report.md" --repo "$fixture_root/rewritten-test-repo" --no-push >"$fixture_root/rewritten-test.out" 2>&1; then
  echo 'rewritten-test: gate accepted a wrapper that replaced a failing test' >&2
  exit 1
fi
assert_output_has "$fixture_root/rewritten-test.out" 'LAND framework-check=test status=fail'
assert test "$(git -C "$fixture_root/rewritten-test-repo" rev-parse main)" = "$rewritten_before"

for failure_kind in failing-test syntax-error; do
  make_fixture "declared-$failure_kind"
  failure_repo="$fixture_root/declared-$failure_kind-repo"
  failure_before=$(git -C "$failure_repo" rev-parse main)
  git -C "$failure_repo" checkout -b "ag-$failure_kind" >/dev/null
  if [ "$failure_kind" = failing-test ]; then
    printf '{"scripts":{"test":"false"}}\n' > "$failure_repo/package.json"
  else
    printf '{"scripts":{"lint":"touch %s","test":"bun test"}}\n' "$fixture_root/parse-order-ran" > "$failure_repo/package.json"
    printf 'this is not valid TypeScript !!!\n' > "$failure_repo/broken.test.ts"
  fi
  git -C "$failure_repo" add .
  git -C "$failure_repo" commit -m "$failure_kind" >/dev/null
  failure_sha=$(git -C "$failure_repo" rev-parse HEAD)
  git -C "$failure_repo" checkout main >/dev/null
  report "$fixture_root/$failure_kind-report.md" "$failure_sha"
  if "$land" --branch "ag-$failure_kind" --report "$fixture_root/$failure_kind-report.md" --repo "$failure_repo" --no-push >"$fixture_root/$failure_kind.out" 2>&1; then exit 1; fi
  if [ "$failure_kind" = syntax-error ]; then
    assert_output_has "$fixture_root/$failure_kind.out" 'LAND declared-check=parse status=fail'
    assert test ! -e "$fixture_root/parse-order-ran"
  else
    assert_output_has "$fixture_root/$failure_kind.out" 'LAND declared-check=test status=fail'
  fi
  assert test "$(git -C "$failure_repo" rev-parse main)" = "$failure_before"
done

make_fixture shadowed-node
shadow_before=$(git -C "$fixture_root/shadowed-node-repo" rev-parse main)
git -C "$fixture_root/shadowed-node-repo" checkout -b ag-shadowed-node >/dev/null
printf '{"scripts":{"test":"node -e '\''process.exit(1)'\''"}}\n' > "$fixture_root/shadowed-node-repo/package.json"
git -C "$fixture_root/shadowed-node-repo" add package.json
git -C "$fixture_root/shadowed-node-repo" commit -m shadowed-node >/dev/null
shadow_sha=$(git -C "$fixture_root/shadowed-node-repo" rev-parse HEAD)
git -C "$fixture_root/shadowed-node-repo" checkout main >/dev/null
mkdir "$fixture_root/shadow-bin"
printf '#!/bin/sh\ntouch %s\nexit 0\n' "$fixture_root/shadow-ran" > "$fixture_root/shadow-bin/node"
chmod +x "$fixture_root/shadow-bin/node"
report "$fixture_root/shadowed-node.md" "$shadow_sha"
if PATH="$fixture_root/shadow-bin:$PATH" "$land" --branch ag-shadowed-node --report "$fixture_root/shadowed-node.md" --repo "$fixture_root/shadowed-node-repo" --no-push >"$fixture_root/shadowed-node.out" 2>&1; then exit 1; fi
assert test ! -e "$fixture_root/shadow-ran"
assert test "$(git -C "$fixture_root/shadowed-node-repo" rev-parse main)" = "$shadow_before"

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

make_fixture secret-path
secret_path_sha=$(make_lane "$fixture_root/secret-path-repo" ag-secret-path)
secret_path_prefix=$(printf '%s%s' 'gh' 'p_')
secret_path_name="${secret_path_prefix}$(printf 'n%.0s' $(seq 1 36))"
git -C "$fixture_root/secret-path-repo" checkout ag-secret-path >/dev/null
printf 'public\n' > "$fixture_root/secret-path-repo/$secret_path_name"
git -C "$fixture_root/secret-path-repo" add "$secret_path_name"
git -C "$fixture_root/secret-path-repo" commit -m secret-path >/dev/null
secret_path_sha=$(git -C "$fixture_root/secret-path-repo" rev-parse HEAD)
git -C "$fixture_root/secret-path-repo" checkout main >/dev/null
report "$fixture_root/secret-path-report.md" "$secret_path_sha"
secret_path_output="$fixture_root/secret-path-output.txt"
if "$land" --branch ag-secret-path --report "$fixture_root/secret-path-report.md" --repo "$fixture_root/secret-path-repo" >"$secret_path_output" 2>&1; then exit 1; fi
assert_output_has "$secret_path_output" 'LAND secret-scan match path-name'
assert_output_has "$secret_path_output" 'LAND step=secret-scan status=fail'
assert_output_lacks "$secret_path_output" "$secret_path_name"
assert test "$(git -C "$fixture_root/secret-path-repo" rev-parse HEAD)" = "$(git -C "$fixture_root/secret-path-repo" rev-parse main)"

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

# W-16 regression lock: the old gate landed this report because it accepted the
# typed 168/168 claim without comparing it with the mandated command's output.
make_fixture verify-count-mismatch
verify_count_sha=$(make_lane "$fixture_root/verify-count-mismatch-repo" ag-verify-count-mismatch)
verify_count_before=$(git -C "$fixture_root/verify-count-mismatch-repo" rev-parse HEAD)
printf "commit: %s fixture\nverify: printf '162 pass\\\\n6 fail\\\\n'\nverify-count: 168/168\nresult: clean\nsecret-scan: clean\nremaining: none\n" "$verify_count_sha" > "$fixture_root/verify-count-mismatch-report.md"
verify_count_output="$fixture_root/verify-count-mismatch-output.txt"
if "$land" --branch ag-verify-count-mismatch --report "$fixture_root/verify-count-mismatch-report.md" --repo "$fixture_root/verify-count-mismatch-repo" --run-verify >"$verify_count_output" 2>&1; then exit 1; fi
assert_output_has "$verify_count_output" 'LAND verify-count mismatch report=168/168 actual=162/6'
assert_output_has "$verify_count_output" 'LAND step=post-merge-verify status=fail'
assert_output_lacks "$verify_count_output" 'LAND step=push status=pass'
assert test "$(git -C "$fixture_root/verify-count-mismatch-repo" rev-parse HEAD)" = "$verify_count_before"
assert git -C "$fixture_root/verify-count-mismatch-repo" show-ref --verify --quiet refs/heads/ag-verify-count-mismatch

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

# Reap pass requires the origin ref to be gone: lane exists on origin, gets
# deleted, and ls-remote confirms absence before status=pass.
make_fixture remote-reap
remote_reap_sha=$(make_lane "$fixture_root/remote-reap-repo" ag-remote-reap)
git -C "$fixture_root/remote-reap-repo" push origin ag-remote-reap >/dev/null 2>&1
report "$fixture_root/remote-reap-report.md" "$remote_reap_sha"
remote_reap_output="$fixture_root/remote-reap-output.txt"
"$land" --branch ag-remote-reap --report "$fixture_root/remote-reap-report.md" --repo "$fixture_root/remote-reap-repo" >"$remote_reap_output" 2>&1
assert_output_has "$remote_reap_output" 'LAND reap remote=deleted branch=ag-remote-reap'
assert_output_has "$remote_reap_output" 'LAND step=reap status=pass'
assert_output_has "$remote_reap_output" 'LAND verdict=landed sha='
assert_not git --git-dir="$fixture_root/remote-reap-origin.git" show-ref --verify --quiet refs/heads/ag-remote-reap
assert test "$(git --git-dir="$fixture_root/remote-reap-origin.git" rev-parse main)" = "$(git -C "$fixture_root/remote-reap-repo" rev-parse HEAD)"

# False-green direction: origin refuses the branch deletion, so the branch is
# still on origin after landing. Reap must report local-only, never pass.
make_fixture remote-reap-blocked
remote_reap_blocked_sha=$(make_lane "$fixture_root/remote-reap-blocked-repo" ag-remote-reap-blocked)
git -C "$fixture_root/remote-reap-blocked-repo" push origin ag-remote-reap-blocked >/dev/null 2>&1
report "$fixture_root/remote-reap-blocked-report.md" "$remote_reap_blocked_sha"
printf '#!/usr/bin/env bash\nzero=0000000000000000000000000000000000000000\nwhile read -r _old new _ref; do\n  if [ "$new" = "$zero" ]; then exit 1; fi\ndone\nexit 0\n' > "$fixture_root/remote-reap-blocked-origin.git/hooks/pre-receive"
chmod +x "$fixture_root/remote-reap-blocked-origin.git/hooks/pre-receive"
remote_reap_blocked_output="$fixture_root/remote-reap-blocked-output.txt"
if "$land" --branch ag-remote-reap-blocked --report "$fixture_root/remote-reap-blocked-report.md" --repo "$fixture_root/remote-reap-blocked-repo" >"$remote_reap_blocked_output" 2>&1; then exit 1; fi
assert_output_has "$remote_reap_blocked_output" 'LAND reap remote=present branch=ag-remote-reap-blocked detail=push-delete-failed'
assert_output_has "$remote_reap_blocked_output" 'LAND step=reap status=local-only'
assert_output_has "$remote_reap_blocked_output" 'LAND verdict=landed-reap-failed sha='
assert_output_lacks "$remote_reap_blocked_output" 'LAND step=reap status=pass'
assert_output_lacks "$remote_reap_blocked_output" 'LAND verdict=landed sha='
assert git --git-dir="$fixture_root/remote-reap-blocked-origin.git" show-ref --verify --quiet refs/heads/ag-remote-reap-blocked
assert test "$(git --git-dir="$fixture_root/remote-reap-blocked-origin.git" rev-parse main)" = "$(git -C "$fixture_root/remote-reap-blocked-repo" rev-parse HEAD)"

# --no-push must not delete a present origin ref (origin/main lacks the merge),
# and therefore must not claim a full reap either.
make_fixture no-push-remote-retained
no_push_remote_retained_sha=$(make_lane "$fixture_root/no-push-remote-retained-repo" ag-no-push-remote-retained)
git -C "$fixture_root/no-push-remote-retained-repo" push origin ag-no-push-remote-retained >/dev/null 2>&1
report "$fixture_root/no-push-remote-retained-report.md" "$no_push_remote_retained_sha"
no_push_remote_retained_output="$fixture_root/no-push-remote-retained-output.txt"
if "$land" --branch ag-no-push-remote-retained --report "$fixture_root/no-push-remote-retained-report.md" --repo "$fixture_root/no-push-remote-retained-repo" --no-push >"$no_push_remote_retained_output" 2>&1; then exit 1; fi
assert_output_has "$no_push_remote_retained_output" 'LAND reap remote=present branch=ag-no-push-remote-retained detail=no-push-remote-delete-refused'
assert_output_has "$no_push_remote_retained_output" 'LAND step=reap status=local-only'
assert_output_has "$no_push_remote_retained_output" 'LAND verdict=landed-local-reap-failed sha='
assert_output_lacks "$no_push_remote_retained_output" 'LAND step=reap status=pass'
assert git --git-dir="$fixture_root/no-push-remote-retained-origin.git" show-ref --verify --quiet refs/heads/ag-no-push-remote-retained

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
