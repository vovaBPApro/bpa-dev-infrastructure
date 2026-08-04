#!/usr/bin/env bash
set -euo pipefail
unset BUN_BIN

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
land="${LAND_UNDER_TEST:-$root/gate/land.sh}"
fixture_root=$(mktemp -d)
trap 'rm -rf "$fixture_root"' EXIT
mkdir -p "$fixture_root/fake-bin"
printf '#!/usr/bin/env bash\ntest "$1" = info\n' > "$fixture_root/fake-bin/docker"
chmod +x "$fixture_root/fake-bin/docker"
export PATH="$fixture_root/fake-bin:$PATH"

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

install_push_noop_wrapper() {
  wrapper_dir="$1"
  real_git=$(command -v git)
  mkdir -p "$wrapper_dir"
  printf '#!/usr/bin/env bash\nif [ "$1" = "-C" ] && [ "$3" = "push" ]; then exit 0; fi\nexec %q "$@"\n' "$real_git" > "$wrapper_dir/git"
  chmod +x "$wrapper_dir/git"
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
  mkdir -p "$repo/hygiene" "$repo/instance/parked"
  cp "$root/hygiene/check-retained-branches.ts" "$repo/hygiene/check-retained-branches.ts"
  printf 'main\n' > "$repo/instance/hygiene-protected-branches.txt"
  printf '| row | active |\n' > "$repo/instance/workboard.md"
  mkdir -p "$repo/meteorite"
  cat > "$repo/meteorite/prove-candidate.sh" <<'EOF'
# BEGIN TRUSTED TEST PROVER
#!/usr/bin/env bash
sha="$2"
cat > "$METEORITE_REPORT" <<REPORT
- requested SHA: \`$sha\`
- tested SHA: \`$sha\`
- result: clean
- blocker: none
## Stages
- container-start: PASS
- prerequisites: PASS
- clone: PASS
- sha-verification: PASS
- bootstrap-test-prerequisites: PASS
- bootstrap-dry-run: PASS
- bootstrap-install: PASS
- bootstrap-verify-source: PASS
- test-prerequisites: PASS
- full-test-suite: PASS
- unit-drift: PASS
REPORT
# END TRUSTED TEST PROVER
EOF
  chmod +x "$repo/meteorite/prove-candidate.sh"
  git -C "$repo" add base.txt base.test.ts hygiene/check-retained-branches.ts instance meteorite/prove-candidate.sh
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

# Reviewer's exact evasion: a recut branch cannot mint a new counter by
# changing V3-3.4 to V3-3.4-recut. Authority comes from tracked target data.
make_fixture review-item-identity
mkdir -p "$repo/instance"
printf '# item-id\tstable-branch-root\nV3-3.4\tag-s5-6\n' > "$repo/instance/review-items.tsv"
git -C "$repo" add instance/review-items.tsv
git -C "$repo" commit -m registry >/dev/null
git -C "$repo" push origin main >/dev/null
identity_sha=$(make_lane "$repo" ag-s5-6-r2)
report "$fixture_root/review-item-identity.md" "$identity_sha"
identity_output="$fixture_root/review-item-identity.out"
if "$land" --branch ag-s5-6-r2 --item-id V3-3.4-recut --report "$fixture_root/review-item-identity.md" --repo "$repo" --no-push >"$identity_output" 2>&1; then exit 1; fi
assert_output_has "$identity_output" 'LAND review-item unknown-or-mismatched item=V3-3.4-recut branch=ag-s5-6-r2'
assert test ! -e "$repo/.git/bpa-review-rounds.json"

# Meteorite regression: clone B must reconstruct an exhausted counter from the
# target branch even though its Git common directory has never held local state.
make_fixture durable-review-rounds
clone_a="$repo"
durable_sha=$(make_lane "$clone_a" ag-durable-rounds)
git -C "$clone_a" branch -f ag-durable-rounds "$durable_sha"
mkdir -p "$clone_a/.bpa"
round_state="$clone_a/.bpa/review-rounds.json"
env -u BUN_BIN bun "$root/gate/review-rounds.ts" init --state "$round_state" --cap 3 --no-progress-limit 3 >/dev/null
for digit in 1 2 3; do
  env -u BUN_BIN bun "$root/gate/review-rounds.ts" attempt --state "$round_state" --item-id ag-durable-rounds >/dev/null
  env -u BUN_BIN bun "$root/gate/review-rounds.ts" landed --state "$round_state" --item-id ag-durable-rounds --sha "$(printf '%040d' "$digit")" >/dev/null
done
git -C "$clone_a" add .bpa/review-rounds.json
git -C "$clone_a" commit -m 'seed durable review rounds' >/dev/null
git -C "$clone_a" push origin main ag-durable-rounds >/dev/null
clone_b="$fixture_root/durable-review-rounds-clone-b"
git clone "$bare" "$clone_b" >/dev/null
git -C "$clone_b" config user.email land@example.test
git -C "$clone_b" config user.name Land
git -C "$clone_b" branch ag-durable-rounds origin/ag-durable-rounds >/dev/null
report "$fixture_root/durable-review-rounds.md" "$durable_sha"
durable_output="$fixture_root/durable-review-rounds.out"
if "$land" --branch ag-durable-rounds --item-id ag-durable-rounds --report "$fixture_root/durable-review-rounds.md" --repo "$clone_b" --no-push >"$durable_output" 2>&1; then exit 1; fi
assert_output_has "$durable_output" 'item=ag-durable-rounds cap=3 parked=cap'
assert test -f "$clone_b/.git/bpa-review-rounds.json"
assert grep -Fq '"rounds": 3' "$clone_b/.git/bpa-review-rounds.json"

# Original regression: Clone A counts reviewed attempts which fail after the
# count and rolls main back. Clone B must recover those attempts from origin,
# even though neither the merge nor Clone A's Git-common-dir cache survives.
make_fixture failed-review-attempts
clone_a="$repo"
git -C "$clone_a" checkout -b ag-failed-attempts >/dev/null
printf 'import { test, expect } from "bun:test"; test("candidate fails", () => expect(true).toBe(false));\n' > "$clone_a/base.test.ts"
git -C "$clone_a" commit -am failed-candidate >/dev/null
failed_sha=$(git -C "$clone_a" rev-parse HEAD)
git -C "$clone_a" checkout main >/dev/null
git -C "$clone_a" push origin ag-failed-attempts >/dev/null
report "$fixture_root/failed-review-attempts.md" "$failed_sha"
for attempt in 1 2; do
  failed_output="$fixture_root/failed-review-attempts-$attempt.out"
  if "$land" --branch ag-failed-attempts --item-id ag-failed-attempts --report "$fixture_root/failed-review-attempts.md" --repo "$clone_a" --no-push >"$failed_output" 2>&1; then exit 1; fi
  assert_output_has "$failed_output" 'LAND step=review-rounds status=pass'
  assert_output_has "$failed_output" 'LAND step=declared-checks status=fail'
  assert test "$(git -C "$clone_a" rev-parse main)" = "$(git -C "$clone_a" rev-parse origin/main)"
done
# The third reviewed attempt is durably recorded before no-progress parks it.
if "$land" --branch ag-failed-attempts --item-id ag-failed-attempts --report "$fixture_root/failed-review-attempts.md" --repo "$clone_a" --no-push >"$fixture_root/failed-review-attempts-3.out" 2>&1; then exit 1; fi
assert_output_has "$fixture_root/failed-review-attempts-3.out" 'parked=no-progress'

clone_b="$fixture_root/failed-review-attempts-clone-b"
git clone "$bare" "$clone_b" >/dev/null
git -C "$clone_b" config user.email land@example.test
git -C "$clone_b" config user.name Land
git -C "$clone_b" branch ag-failed-attempts origin/ag-failed-attempts >/dev/null
if "$land" --branch ag-failed-attempts --item-id ag-failed-attempts --report "$fixture_root/failed-review-attempts.md" --repo "$clone_b" --no-push >"$fixture_root/failed-review-attempts-clone-b.out" 2>&1; then exit 1; fi
assert_output_has "$fixture_root/failed-review-attempts-clone-b.out" 'parked=no-progress'
assert grep -Fq '"rounds": 3' "$clone_b/.git/bpa-review-rounds.json"
rm "$clone_b/.git/bpa-review-rounds.json"
if "$land" --branch ag-failed-attempts --item-id ag-failed-attempts --report "$fixture_root/failed-review-attempts.md" --repo "$clone_b" --no-push >"$fixture_root/failed-review-attempts-cache-deleted.out" 2>&1; then exit 1; fi
assert_output_has "$fixture_root/failed-review-attempts-cache-deleted.out" 'parked=no-progress'

# Root-equivalent lanes can mutate either origin namespace. Independent
# forgery or suppression must nevertheless be detected by the mirrored record.
genuine_ref=$(git -C "$bare" for-each-ref --format='%(refname)' refs/bpa-review-attempts/ | head -n 1)
genuine_mirror=${genuine_ref/refs\/bpa-review-attempts/refs\/bpa-review-attempt-mirrors}
git -C "$bare" update-ref -d "$genuine_ref"
if "$land" --branch ag-failed-attempts --item-id ag-failed-attempts --report "$fixture_root/failed-review-attempts.md" --repo "$clone_b" --no-push >"$fixture_root/attempt-suppressed.out" 2>&1; then exit 1; fi
assert_output_has "$fixture_root/attempt-suppressed.out" 'LAND review-rounds attempt-mirror-mismatch item=ag-failed-attempts'
git -C "$bare" update-ref "$genuine_ref" "$(git -C "$bare" rev-parse "$genuine_mirror")"
forged_sha=$(git -C "$clone_b" rev-parse ag-failed-attempts)
git -C "$bare" update-ref "${genuine_ref%/*}/4-$forged_sha" "$forged_sha"
if "$land" --branch ag-failed-attempts --item-id ag-failed-attempts --report "$fixture_root/failed-review-attempts.md" --repo "$clone_b" --no-push >"$fixture_root/attempt-forged.out" 2>&1; then exit 1; fi
assert_output_has "$fixture_root/attempt-forged.out" 'LAND review-rounds attempt-mirror-mismatch item=ag-failed-attempts'
git -C "$bare" update-ref -d "${genuine_ref%/*}/4-$forged_sha"

# Regression lock: the copied gate must support the orphan v3 family range,
# while callers that do not select a family still resolve against main.
# shellcheck source=gate/land-lib.sh
source "$root/gate/land-lib.sh"
make_fixture changed-range-main
main_base=$(git -C "$repo" rev-parse main)
main_lane=$(make_lane "$repo" ag-main-range)
unset LAND_DEFAULT_BRANCH
assert test "$(land_changed_base "$repo" "$main_lane")" = "$main_base"

git -C "$repo" checkout --orphan v3 >/dev/null
git -C "$repo" rm -rf . >/dev/null
printf 'v3 root\n' > "$repo/v3.txt"
git -C "$repo" add v3.txt
git -C "$repo" commit -m v3-root >/dev/null
v3_root=$(git -C "$repo" rev-parse HEAD)
git -C "$repo" push origin v3 >/dev/null
git -C "$repo" checkout -b ag-v3-range >/dev/null
printf 'v3 lane\n' >> "$repo/v3.txt"
git -C "$repo" commit -am v3-lane >/dev/null
v3_lane=$(git -C "$repo" rev-parse HEAD)
git -C "$repo" checkout main >/dev/null
LAND_DEFAULT_BRANCH=origin/v3
assert test "$(land_changed_base "$repo" "$v3_lane")" = "$v3_root"
git -C "$repo" update-ref -d refs/remotes/origin/v3
assert test "$(land_changed_base "$repo" "$v3_lane")" = "$v3_root"
unset LAND_DEFAULT_BRANCH

make_fixture zero-tests
zero_before=$(git -C "$repo" rev-parse main)
git -C "$repo" checkout -b ag-zero-tests >/dev/null
printf 'import { test } from "bun:test"; void test;\n' > "$repo/base.test.ts"
git -C "$repo" add base.test.ts
git -C "$repo" commit -m zero-tests >/dev/null
zero_sha=$(git -C "$repo" rev-parse HEAD)
git -C "$repo" checkout main >/dev/null
report "$fixture_root/zero-tests.md" "$zero_sha"
if "$land" --branch ag-zero-tests --item-id ag-zero-tests --report "$fixture_root/zero-tests.md" --repo "$repo" --no-push >"$fixture_root/zero-tests.out" 2>&1; then
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
if "$land" --branch ag-skipped-tests --item-id ag-skipped-tests --report "$fixture_root/skipped-tests.md" --repo "$repo" --no-push >"$fixture_root/skipped-tests.out" 2>&1; then
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
if "$land" --branch ag-count-collapse --item-id ag-count-collapse --report "$fixture_root/count-collapse.md" --repo "$repo" --no-push >"$fixture_root/count-collapse.out" 2>&1; then
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
if "$land" --branch ag-review-missing --item-id ag-review-missing --report "$fixture_root/review-missing-report.md" --repo "$fixture_root/review-missing-repo" >"$review_missing_output" 2>&1; then exit 1; fi
assert_output_has "$review_missing_output" 'ERROR review-required missing-artifact'
assert_output_lacks "$review_missing_output" 'LAND step=merge status=pass'
assert test "$(git -C "$fixture_root/review-missing-repo" rev-parse HEAD)" = "$(git -C "$fixture_root/review-missing-repo" rev-parse main)"

make_fixture review-malformed
review_malformed_sha=$(make_policy_lane "$fixture_root/review-malformed-repo" ag-review-malformed)
report "$fixture_root/review-malformed-report.md" "$review_malformed_sha"
printf 'verdict: ACCEPT\nreviewer:\n' > "$fixture_root/ag-review-malformed.review.md"
review_malformed_output="$fixture_root/review-malformed-output.txt"
if "$land" --branch ag-review-malformed --item-id ag-review-malformed --report "$fixture_root/review-malformed-report.md" --repo "$fixture_root/review-malformed-repo" >"$review_malformed_output" 2>&1; then exit 1; fi
assert_output_has "$review_malformed_output" 'ERROR review-required malformed-artifact'
assert_output_lacks "$review_malformed_output" 'LAND step=merge status=pass'

make_fixture review-rejected
review_rejected_sha=$(make_policy_lane "$fixture_root/review-rejected-repo" ag-review-rejected)
report "$fixture_root/review-rejected-report.md" "$review_rejected_sha"
review "$fixture_root/ag-review-rejected.review.md" REJECT independent-reviewer "$review_rejected_sha" separate-session
review_rejected_output="$fixture_root/review-rejected-output.txt"
if "$land" --branch ag-review-rejected --item-id ag-review-rejected --report "$fixture_root/review-rejected-report.md" --repo "$fixture_root/review-rejected-repo" >"$review_rejected_output" 2>&1; then exit 1; fi
assert_output_has "$review_rejected_output" 'ERROR review-rejected'
assert_output_lacks "$review_rejected_output" 'LAND step=merge status=pass'

make_fixture review-self
review_self_sha=$(make_policy_lane "$fixture_root/review-self-repo" ag-review-self)
report "$fixture_root/review-self-report.md" "$review_self_sha"
review "$fixture_root/ag-review-self.review.md" ACCEPT ag-review-self "$review_self_sha" separate-session
review_self_output="$fixture_root/review-self-output.txt"
if "$land" --branch ag-review-self --item-id ag-review-self --report "$fixture_root/review-self-report.md" --repo "$fixture_root/review-self-repo" >"$review_self_output" 2>&1; then exit 1; fi
assert_output_has "$review_self_output" 'ERROR review-required malformed-artifact'
assert_output_lacks "$review_self_output" 'LAND step=merge status=pass'

make_fixture review-self-trailing-space
review_self_trailing_space_sha=$(make_policy_lane "$fixture_root/review-self-trailing-space-repo" ag-review-self-trailing-space)
report "$fixture_root/review-self-trailing-space-report.md" "$review_self_trailing_space_sha"
printf 'verdict: ACCEPT\nreviewer: ag-review-self-trailing-space \n' > "$fixture_root/ag-review-self-trailing-space.review.md"
review_self_trailing_space_output="$fixture_root/review-self-trailing-space-output.txt"
if "$land" --branch ag-review-self-trailing-space --item-id ag-review-self-trailing-space --report "$fixture_root/review-self-trailing-space-report.md" --repo "$fixture_root/review-self-trailing-space-repo" >"$review_self_trailing_space_output" 2>&1; then exit 1; fi
assert_output_has "$review_self_trailing_space_output" 'ERROR review-required malformed-artifact'
assert_output_lacks "$review_self_trailing_space_output" 'LAND step=merge status=pass'

make_fixture review-self-authored
review_self_authored_sha=$(make_policy_lane "$fixture_root/review-self-authored-repo" ag-review-self-authored)
report "$fixture_root/review-self-authored-report.md" "$review_self_authored_sha"
review "$fixture_root/ag-review-self-authored.review.md" ACCEPT ' land <LAND@EXAMPLE.TEST> ' "$review_self_authored_sha" separate-session
review_self_authored_output="$fixture_root/review-self-authored-output.txt"
if "$land" --branch ag-review-self-authored --item-id ag-review-self-authored --report "$fixture_root/review-self-authored-report.md" --repo "$fixture_root/review-self-authored-repo" >"$review_self_authored_output" 2>&1; then exit 1; fi
assert_output_has "$review_self_authored_output" 'ERROR review-required self-authored-review'
assert_output_lacks "$review_self_authored_output" 'LAND step=merge status=pass'

make_fixture review-self-author-name
review_self_author_name_sha=$(make_policy_lane "$fixture_root/review-self-author-name-repo" ag-review-self-author-name)
report "$fixture_root/review-self-author-name-report.md" "$review_self_author_name_sha"
review "$fixture_root/ag-review-self-author-name.review.md" ACCEPT land "$review_self_author_name_sha" separate-session
review_self_author_name_output="$fixture_root/review-self-author-name-output.txt"
if "$land" --branch ag-review-self-author-name --item-id ag-review-self-author-name --report "$fixture_root/review-self-author-name-report.md" --repo "$fixture_root/review-self-author-name-repo" >"$review_self_author_name_output" 2>&1; then exit 1; fi
assert_output_has "$review_self_author_name_output" 'ERROR review-required self-authored-review'
assert_output_lacks "$review_self_author_name_output" 'LAND step=merge status=pass'

make_fixture review-self-author-email
review_self_author_email_sha=$(make_policy_lane "$fixture_root/review-self-author-email-repo" ag-review-self-author-email)
report "$fixture_root/review-self-author-email-report.md" "$review_self_author_email_sha"
review "$fixture_root/ag-review-self-author-email.review.md" ACCEPT LAND@EXAMPLE.TEST "$review_self_author_email_sha" separate-session
review_self_author_email_output="$fixture_root/review-self-author-email-output.txt"
if "$land" --branch ag-review-self-author-email --item-id ag-review-self-author-email --report "$fixture_root/review-self-author-email-report.md" --repo "$fixture_root/review-self-author-email-repo" >"$review_self_author_email_output" 2>&1; then exit 1; fi
assert_output_has "$review_self_author_email_output" 'ERROR review-required self-authored-review'
assert_output_lacks "$review_self_author_email_output" 'LAND step=merge status=pass'

make_fixture review-self-author-reordered
git -C "$fixture_root/review-self-author-reordered-repo" config user.name 'First Last'
review_self_author_reordered_sha=$(make_policy_lane "$fixture_root/review-self-author-reordered-repo" ag-review-self-author-reordered)
report "$fixture_root/review-self-author-reordered-report.md" "$review_self_author_reordered_sha"
review "$fixture_root/ag-review-self-author-reordered.review.md" ACCEPT 'Last First <spoofed@example.test>' "$review_self_author_reordered_sha" separate-session
review_self_author_reordered_output="$fixture_root/review-self-author-reordered-output.txt"
if "$land" --branch ag-review-self-author-reordered --item-id ag-review-self-author-reordered --report "$fixture_root/review-self-author-reordered-report.md" --repo "$fixture_root/review-self-author-reordered-repo" >"$review_self_author_reordered_output" 2>&1; then exit 1; fi
assert_output_has "$review_self_author_reordered_output" 'ERROR review-required self-authored-review'
assert_output_lacks "$review_self_author_reordered_output" 'LAND step=merge status=pass'

make_fixture review-self-author-crlf
review_self_author_crlf_sha=$(make_policy_lane "$fixture_root/review-self-author-crlf-repo" ag-review-self-author-crlf)
report "$fixture_root/review-self-author-crlf-report.md" "$review_self_author_crlf_sha"
printf 'verdict: ACCEPT\r\nreviewer: Land\r\nreviewed-sha: %s\r\nindependence: separate-session\r\n' "$review_self_author_crlf_sha" > "$fixture_root/ag-review-self-author-crlf.review.md"
review_self_author_crlf_output="$fixture_root/review-self-author-crlf-output.txt"
if "$land" --branch ag-review-self-author-crlf --item-id ag-review-self-author-crlf --report "$fixture_root/review-self-author-crlf-report.md" --repo "$fixture_root/review-self-author-crlf-repo" >"$review_self_author_crlf_output" 2>&1; then exit 1; fi
assert_output_has "$review_self_author_crlf_output" 'ERROR review-required self-authored-review'
assert_output_lacks "$review_self_author_crlf_output" 'LAND step=merge status=pass'

make_fixture review-nul-artifact
review_nul_artifact_sha=$(make_policy_lane "$fixture_root/review-nul-artifact-repo" ag-review-nul-artifact)
report "$fixture_root/review-nul-artifact-report.md" "$review_nul_artifact_sha"
printf 'verdict: ACCEPT\nreviewer: land\0x <other@example.test>\nreviewed-sha: %s\nindependence: separate-session\n' "$review_nul_artifact_sha" > "$fixture_root/ag-review-nul-artifact.review.md"
review_nul_artifact_output="$fixture_root/review-nul-artifact-output.txt"
if "$land" --branch ag-review-nul-artifact --item-id ag-review-nul-artifact --report "$fixture_root/review-nul-artifact-report.md" --repo "$fixture_root/review-nul-artifact-repo" >"$review_nul_artifact_output" 2>&1; then exit 1; fi
assert_output_has "$review_nul_artifact_output" 'ERROR review-required invalid-artifact nul-byte'
assert_output_lacks "$review_nul_artifact_output" 'LAND step=merge status=pass'

make_fixture review-independent-identity
review_independent_identity_sha=$(make_policy_lane "$fixture_root/review-independent-identity-repo" ag-review-independent-identity)
report "$fixture_root/review-independent-identity-report.md" "$review_independent_identity_sha"
review "$fixture_root/ag-review-independent-identity.review.md" ACCEPT 'Other Reviewer <other@example.test>' "$review_independent_identity_sha" separate-session
review_independent_identity_output="$fixture_root/review-independent-identity-output.txt"
"$land" --branch ag-review-independent-identity --item-id ag-review-independent-identity --report "$fixture_root/review-independent-identity-report.md" --repo "$fixture_root/review-independent-identity-repo" --no-push >"$review_independent_identity_output" 2>&1
assert_output_has "$review_independent_identity_output" 'LAND verdict=landed sha='
assert_output_has "$review_independent_identity_output" 'review=accepted'

make_fixture review-artifact-symlink
review_artifact_symlink_sha=$(make_policy_lane "$fixture_root/review-artifact-symlink-repo" ag-review-artifact-symlink)
report "$fixture_root/review-artifact-symlink-report.md" "$review_artifact_symlink_sha"
review "$fixture_root/review-artifact-target.md" ACCEPT independent-reviewer "$review_artifact_symlink_sha" separate-session
ln -s "$fixture_root/review-artifact-target.md" "$fixture_root/ag-review-artifact-symlink.review.md"
review_artifact_symlink_output="$fixture_root/review-artifact-symlink-output.txt"
if "$land" --branch ag-review-artifact-symlink --item-id ag-review-artifact-symlink --report "$fixture_root/review-artifact-symlink-report.md" --repo "$fixture_root/review-artifact-symlink-repo" >"$review_artifact_symlink_output" 2>&1; then exit 1; fi
assert_output_has "$review_artifact_symlink_output" 'ERROR review-required invalid-artifact non-regular-file'
assert_output_lacks "$review_artifact_symlink_output" 'LAND step=merge status=pass'

make_fixture review-unicode-identity
review_unicode_identity_sha=$(make_policy_lane "$fixture_root/review-unicode-identity-repo" ag-review-unicode-identity)
report "$fixture_root/review-unicode-identity-report.md" "$review_unicode_identity_sha"
review "$fixture_root/ag-review-unicode-identity.review.md" ACCEPT 'independent-reviewerο' "$review_unicode_identity_sha" separate-session
review_unicode_identity_output="$fixture_root/review-unicode-identity-output.txt"
if "$land" --branch ag-review-unicode-identity --item-id ag-review-unicode-identity --report "$fixture_root/review-unicode-identity-report.md" --repo "$fixture_root/review-unicode-identity-repo" >"$review_unicode_identity_output" 2>&1; then exit 1; fi
assert_output_has "$review_unicode_identity_output" 'ERROR review-required malformed-artifact unsafe-identity-field'
assert_output_lacks "$review_unicode_identity_output" 'LAND step=merge status=pass'

make_fixture review-policy-deletion
review_policy_deletion_sha=$(make_policy_deletion_lane "$fixture_root/review-policy-deletion-repo" ag-review-policy-deletion)
report "$fixture_root/review-policy-deletion-report.md" "$review_policy_deletion_sha"
review_policy_deletion_output="$fixture_root/review-policy-deletion-output.txt"
if "$land" --branch ag-review-policy-deletion --item-id ag-review-policy-deletion --report "$fixture_root/review-policy-deletion-report.md" --repo "$fixture_root/review-policy-deletion-repo" >"$review_policy_deletion_output" 2>&1; then exit 1; fi
assert_output_has "$review_policy_deletion_output" 'ERROR review-required missing-artifact'
assert_output_lacks "$review_policy_deletion_output" 'LAND step=merge status=pass'
review "$fixture_root/ag-review-policy-deletion.review.md" ACCEPT independent-reviewer "$review_policy_deletion_sha" separate-session
"$land" --branch ag-review-policy-deletion --item-id ag-review-policy-deletion --report "$fixture_root/review-policy-deletion-report.md" --repo "$fixture_root/review-policy-deletion-repo" --no-push >"$review_policy_deletion_output" 2>&1
assert_output_has "$review_policy_deletion_output" 'review=accepted'
assert git -C "$fixture_root/review-policy-deletion-repo" merge-base --is-ancestor "$review_policy_deletion_sha" HEAD

make_fixture review-policy-rename
review_policy_rename_sha=$(make_policy_rename_lane "$fixture_root/review-policy-rename-repo" ag-review-policy-rename)
report "$fixture_root/review-policy-rename-report.md" "$review_policy_rename_sha"
review_policy_rename_output="$fixture_root/review-policy-rename-output.txt"
if "$land" --branch ag-review-policy-rename --item-id ag-review-policy-rename --report "$fixture_root/review-policy-rename-report.md" --repo "$fixture_root/review-policy-rename-repo" >"$review_policy_rename_output" 2>&1; then exit 1; fi
assert_output_has "$review_policy_rename_output" 'ERROR review-required missing-artifact'
assert_output_lacks "$review_policy_rename_output" 'LAND step=merge status=pass'

make_fixture review-accepted
review_accepted_sha=$(make_policy_lane "$fixture_root/review-accepted-repo" ag-review-accepted)
report "$fixture_root/review-accepted-report.md" "$review_accepted_sha"
review "$fixture_root/ag-review-accepted.review.md" ACCEPT independent-reviewer "$review_accepted_sha" separate-session
review_accepted_output="$fixture_root/review-accepted-output.txt"
"$land" --branch ag-review-accepted --item-id ag-review-accepted --report "$fixture_root/review-accepted-report.md" --repo "$fixture_root/review-accepted-repo" --no-push >"$review_accepted_output" 2>&1
assert_output_has "$review_accepted_output" 'LAND verdict=landed sha='
assert_output_has "$review_accepted_output" 'review=accepted'
assert git -C "$fixture_root/review-accepted-repo" merge-base --is-ancestor "$review_accepted_sha" HEAD

make_fixture review-stale-sha
review_stale_sha=$(make_policy_lane "$fixture_root/review-stale-sha-repo" ag-review-stale-sha)
report "$fixture_root/review-stale-sha-report.md" "$review_stale_sha"
review "$fixture_root/ag-review-stale-sha.review.md" ACCEPT independent-reviewer aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa separate-session
review_stale_output="$fixture_root/review-stale-sha-output.txt"
if "$land" --branch ag-review-stale-sha --item-id ag-review-stale-sha --report "$fixture_root/review-stale-sha-report.md" --repo "$fixture_root/review-stale-sha-repo" >"$review_stale_output" 2>&1; then exit 1; fi
assert_output_has "$review_stale_output" 'ERROR review-required stale-artifact reviewed-sha-mismatch'

make_fixture review-missing-sha
review_missing_sha=$(make_policy_lane "$fixture_root/review-missing-sha-repo" ag-review-missing-sha)
report "$fixture_root/review-missing-sha-report.md" "$review_missing_sha"
printf 'verdict: ACCEPT\nreviewer: independent-reviewer\nindependence: separate-session\n' > "$fixture_root/ag-review-missing-sha.review.md"
review_missing_sha_output="$fixture_root/review-missing-sha-output.txt"
if "$land" --branch ag-review-missing-sha --item-id ag-review-missing-sha --report "$fixture_root/review-missing-sha-report.md" --repo "$fixture_root/review-missing-sha-repo" >"$review_missing_sha_output" 2>&1; then exit 1; fi
assert_output_has "$review_missing_sha_output" "line='reviewed-sha: <40-hex>'"

make_fixture review-missing-independence
review_missing_independence_sha=$(make_policy_lane "$fixture_root/review-missing-independence-repo" ag-review-missing-independence)
report "$fixture_root/review-missing-independence-report.md" "$review_missing_independence_sha"
printf 'verdict: ACCEPT\nreviewer: independent-reviewer\nreviewed-sha: %s\n' "$review_missing_independence_sha" > "$fixture_root/ag-review-missing-independence.review.md"
review_missing_independence_output="$fixture_root/review-missing-independence-output.txt"
if "$land" --branch ag-review-missing-independence --item-id ag-review-missing-independence --report "$fixture_root/review-missing-independence-report.md" --repo "$fixture_root/review-missing-independence-repo" >"$review_missing_independence_output" 2>&1; then exit 1; fi
assert_output_has "$review_missing_independence_output" "line='independence: <text>'"

make_fixture review-skipped
review_skipped_sha=$(make_policy_lane "$fixture_root/review-skipped-repo" ag-review-skipped)
report "$fixture_root/review-skipped-report.md" "$review_skipped_sha"
review_skipped_output="$fixture_root/review-skipped-output.txt"
if "$land" --branch ag-review-skipped --item-id ag-review-skipped --report "$fixture_root/review-skipped-report.md" --repo "$fixture_root/review-skipped-repo" --no-push --skip-review >"$review_skipped_output" 2>&1; then exit 1; fi
assert_output_has "$review_skipped_output" 'usage: gate/land.sh'
if "$land" --branch ag-review-skipped --item-id ag-review-skipped --report "$fixture_root/review-skipped-report.md" --repo "$fixture_root/review-skipped-repo" --no-push --skip-review '   ' >"$review_skipped_output" 2>&1; then exit 1; fi
assert_output_has "$review_skipped_output" 'usage: gate/land.sh'
"$land" --branch ag-review-skipped --item-id ag-review-skipped --report "$fixture_root/review-skipped-report.md" --repo "$fixture_root/review-skipped-repo" --no-push --skip-review 'emergency rollback window' >"$review_skipped_output" 2>&1
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
"$land" --branch ag-good --item-id ag-good --report "$fixture_root/good-report.md" --repo "$fixture_root/good-repo" --run-verify >"$good_output" 2>&1
assert_output_has "$good_output" 'LAND step=review-rounds status=pass'
assert_output_has "$good_output" 'LAND step=retained-branches status=pass'
assert_output_has "$good_output" 'REVIEW_ROUNDS status=landed item=ag-good'
assert_output_has "$good_output" 'LAND reap remote=absent branch=ag-good detail=never-on-origin-nothing-to-delete'
assert_output_has "$good_output" 'LAND step=reap status=pass'
assert git -C "$fixture_root/good-repo" merge-base --is-ancestor "$good_sha" HEAD
assert test "$(git -C "$fixture_root/good-repo" rev-list --parents -n 1 HEAD | wc -w)" -eq 3
assert_not git -C "$fixture_root/good-repo" show-ref --verify --quiet refs/heads/ag-good
assert test "$(git --git-dir="$fixture_root/good-origin.git" rev-parse main)" = "$(git -C "$fixture_root/good-repo" rev-parse HEAD)"

# Regression lock: a protected branch that nobody pushed must make a real
# landing fail and roll back, rather than leaving the checker inert.
make_fixture retained-branch-missing
retained_repo="$fixture_root/retained-branch-missing-repo"
printf 'main\nag-never-pushed\n' > "$retained_repo/instance/hygiene-protected-branches.txt"
git -C "$retained_repo" add instance/hygiene-protected-branches.txt
git -C "$retained_repo" commit -m protect-unpublished >/dev/null
git -C "$retained_repo" push origin main >/dev/null
retained_before=$(git -C "$retained_repo" rev-parse main)
retained_sha=$(make_lane "$retained_repo" ag-retained-check)
report "$fixture_root/retained-branch-missing-report.md" "$retained_sha"
retained_output="$fixture_root/retained-branch-missing-output.txt"
if "$land" --branch ag-retained-check --item-id ag-retained-check --report "$fixture_root/retained-branch-missing-report.md" --repo "$retained_repo" --no-push >"$retained_output" 2>&1; then exit 1; fi
assert_output_has "$retained_output" 'RETAINED-BRANCHES FAIL cause=absent-from-remote remote=origin branches=ag-never-pushed'
assert_output_has "$retained_output" 'LAND step=retained-branches status=fail'
assert test "$(git -C "$retained_repo" rev-parse main)" = "$retained_before"
assert test -z "$(git -C "$retained_repo" status --porcelain)"

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
if "$land" --branch ag-declared-check-fail --item-id ag-declared-check-fail --report "$fixture_root/declared-check-fail-report.md" --repo "$fixture_root/declared-check-fail-repo" --no-push >"$declared_output" 2>&1; then exit 1; fi
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
if "$land" --branch ag-rewritten-test --item-id ag-rewritten-test --report "$fixture_root/rewritten-test-report.md" --repo "$fixture_root/rewritten-test-repo" --no-push >"$fixture_root/rewritten-test.out" 2>&1; then
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
  if "$land" --branch "ag-$failure_kind" --item-id "ag-$failure_kind" --report "$fixture_root/$failure_kind-report.md" --repo "$failure_repo" --no-push >"$fixture_root/$failure_kind.out" 2>&1; then exit 1; fi
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
if PATH="$fixture_root/shadow-bin:$PATH" "$land" --branch ag-shadowed-node --item-id ag-shadowed-node --report "$fixture_root/shadowed-node.md" --repo "$fixture_root/shadowed-node-repo" --no-push >"$fixture_root/shadowed-node.out" 2>&1; then exit 1; fi
assert test ! -e "$fixture_root/shadow-ran"
assert test "$(git -C "$fixture_root/shadowed-node-repo" rev-parse main)" = "$shadow_before"

make_fixture bad-sha
make_lane "$fixture_root/bad-sha-repo" ag-bad-sha >/dev/null
report "$fixture_root/bad-sha-report.md" "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
if "$land" --branch ag-bad-sha --item-id ag-bad-sha --report "$fixture_root/bad-sha-report.md" --repo "$fixture_root/bad-sha-repo"; then exit 1; fi
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
if "$land" --branch ag-secret --item-id ag-secret --report "$fixture_root/secret-report.md" --repo "$fixture_root/secret-repo" >"$secret_output" 2>&1; then exit 1; fi
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
if "$land" --branch ag-secret-path --item-id ag-secret-path --report "$fixture_root/secret-path-report.md" --repo "$fixture_root/secret-path-repo" >"$secret_path_output" 2>&1; then exit 1; fi
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
if "$land" --branch ag-typechange-secret --item-id ag-typechange-secret --report "$fixture_root/typechange-secret-report.md" --repo "$fixture_root/typechange-secret-repo" >"$typechange_secret_output" 2>&1; then exit 1; fi
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
if "$land" --branch ag-binary-secret --item-id ag-binary-secret --report "$fixture_root/binary-secret-report.md" --repo "$fixture_root/binary-secret-repo" >"$binary_secret_output" 2>&1; then exit 1; fi
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
if "$land" --branch ag-unicode-secret --item-id ag-unicode-secret --report "$fixture_root/unicode-secret-report.md" --repo "$fixture_root/unicode-secret-repo" >"$unicode_secret_output" 2>&1; then exit 1; fi
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
if "$land" --branch ag-merge-conflict --item-id ag-merge-conflict --report "$fixture_root/merge-conflict-report.md" --repo "$fixture_root/merge-conflict-repo" >"$merge_conflict_output" 2>&1; then exit 1; fi
assert_output_has "$merge_conflict_output" 'LAND step=merge status=fail'
assert_not git -C "$fixture_root/merge-conflict-repo" rev-parse --verify --quiet MERGE_HEAD
assert test -z "$(git -C "$fixture_root/merge-conflict-repo" status --porcelain)"

make_fixture verify-fail
verify_fail_sha=$(make_lane "$fixture_root/verify-fail-repo" ag-verify-fail)
verify_fail_before=$(git -C "$fixture_root/verify-fail-repo" rev-parse HEAD)
printf 'commit: %s fixture\nverify: test ! -f lane.txt\nresult: clean\nsecret-scan: clean\nremaining: none\n' "$verify_fail_sha" > "$fixture_root/verify-fail-report.md"
verify_fail_output="$fixture_root/verify-fail-output.txt"
if "$land" --branch ag-verify-fail --item-id ag-verify-fail --report "$fixture_root/verify-fail-report.md" --repo "$fixture_root/verify-fail-repo" --run-verify >"$verify_fail_output" 2>&1; then exit 1; fi
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
if "$land" --branch ag-verify-count-mismatch --item-id ag-verify-count-mismatch --report "$fixture_root/verify-count-mismatch-report.md" --repo "$fixture_root/verify-count-mismatch-repo" --run-verify >"$verify_count_output" 2>&1; then exit 1; fi
assert_output_has "$verify_count_output" 'LAND verify-count mismatch report=168/168 actual=1/0'
assert_output_has "$verify_count_output" 'LAND step=reviewed-verify status=fail'
assert_output_lacks "$verify_count_output" 'LAND step=push status=pass'
assert test "$(git -C "$fixture_root/verify-count-mismatch-repo" rev-parse HEAD)" = "$verify_count_before"
assert git -C "$fixture_root/verify-count-mismatch-repo" show-ref --verify --quiet refs/heads/ag-verify-count-mismatch

# V3-0.25 regression lock: two reviewed candidates were both measured at two
# tests. Landing the first raises the merged count for the second to three, but
# does not change the second candidate's reviewed diff or exact-SHA measurement.
make_fixture verify-count-reviewed-queue
queue_repo="$fixture_root/verify-count-reviewed-queue-repo"
count_command="count=\$(find . -name '*.test.ts' -type f | wc -l); printf '%s pass\\n0 fail\\n' \"\$count\""
for queue_lane in ag-queue-a ag-queue-b; do
  git -C "$queue_repo" checkout -b "$queue_lane" main >/dev/null
  mkdir -p "$queue_repo/gate"
  printf 'policy\n' > "$queue_repo/gate/$queue_lane.txt"
  printf 'import { test, expect } from "bun:test"; test("%s", () => expect(true).toBe(true));\n' "$queue_lane" > "$queue_repo/$queue_lane.test.ts"
  git -C "$queue_repo" add "gate/$queue_lane.txt" "$queue_lane.test.ts"
  git -C "$queue_repo" commit -m "$queue_lane" >/dev/null
  queue_sha=$(git -C "$queue_repo" rev-parse HEAD)
  printf "commit: %s fixture\nverify: %s\nverify-count: 2/0\nresult: clean\nsecret-scan: clean\nremaining: none\n" "$queue_sha" "$count_command" > "$fixture_root/$queue_lane-report.md"
  review "$fixture_root/$queue_lane.review.md" ACCEPT independent-reviewer "$queue_sha" separate-session
  git -C "$queue_repo" checkout main >/dev/null
done
for queue_lane in ag-queue-a ag-queue-b; do
  queue_output="$fixture_root/$queue_lane-output.txt"
  "$land" --branch "$queue_lane" --item-id "$queue_lane" --report "$fixture_root/$queue_lane-report.md" --repo "$queue_repo" --run-verify >"$queue_output" 2>&1
  assert_output_has "$queue_output" 'LAND step=reviewed-verify status=pass'
  assert_output_has "$queue_output" 'review=accepted'
  assert_output_has "$queue_output" 'LAND verdict=landed sha='
done
assert_output_has "$fixture_root/ag-queue-a-output.txt" 'LAND verify-count carried report=2/0 actual=2/0'
assert_output_has "$fixture_root/ag-queue-b-output.txt" 'LAND verify-count carried report=2/0 actual=3/0'

# A colluding report and candidate-authored command both fabricate the same low
# count. The gate-owned inventory still measures two tests and refuses them.
make_fixture verify-count-fabricated
fabricated_repo="$fixture_root/verify-count-fabricated-repo"
git -C "$fabricated_repo" checkout -b ag-verify-count-fabricated main >/dev/null
printf 'import { test, expect } from "bun:test"; test("second", () => expect(true).toBe(true));\n' > "$fabricated_repo/second.test.ts"
git -C "$fabricated_repo" add second.test.ts
git -C "$fabricated_repo" commit -m fabricated >/dev/null
fabricated_sha=$(git -C "$fabricated_repo" rev-parse HEAD)
git -C "$fabricated_repo" checkout main >/dev/null
printf "commit: %s fixture\nverify: printf '1 pass\\\\n0 fail\\\\n'\nverify-count: 1/0\nresult: clean\nsecret-scan: clean\nremaining: none\n" "$fabricated_sha" > "$fixture_root/verify-count-fabricated-report.md"
fabricated_output="$fixture_root/verify-count-fabricated-output.txt"
if "$land" --branch ag-verify-count-fabricated --item-id ag-verify-count-fabricated --report "$fixture_root/verify-count-fabricated-report.md" --repo "$fixture_root/verify-count-fabricated-repo" --run-verify >"$fabricated_output" 2>&1; then exit 1; fi
assert_output_has "$fabricated_output" 'LAND verify-count mismatch report=1/0 actual=2/0'
assert_output_has "$fabricated_output" 'LAND step=reviewed-verify status=fail'

make_fixture reap-fail
reap_fail_sha=$(make_lane "$fixture_root/reap-fail-repo" ag-reap-fail)
report "$fixture_root/reap-fail-report.md" "$reap_fail_sha"
git -C "$fixture_root/reap-fail-repo" worktree add "$fixture_root/reap-fail-worktree" ag-reap-fail >/dev/null
reap_fail_output="$fixture_root/reap-fail-output.txt"
if "$land" --branch ag-reap-fail --item-id ag-reap-fail --report "$fixture_root/reap-fail-report.md" --repo "$fixture_root/reap-fail-repo" >"$reap_fail_output" 2>&1; then exit 1; fi
assert_output_has "$reap_fail_output" 'LAND verdict=landed-reap-failed sha='
assert_not grep -Fq 'LAND verdict=aborted' "$reap_fail_output"
assert test "$(git --git-dir="$fixture_root/reap-fail-origin.git" rev-parse main)" = "$(git -C "$fixture_root/reap-fail-repo" rev-parse HEAD)"

# V3-0.18 regression locks: push exit status is not landing evidence. A push
# that performs no update, and a server that moves the accepted ref elsewhere,
# must both be refused based on the ref observed through ls-remote.
make_fixture push-noop
push_noop_sha=$(make_lane "$fixture_root/push-noop-repo" ag-push-noop)
report "$fixture_root/push-noop-report.md" "$push_noop_sha"
push_noop_before=$(git --git-dir="$fixture_root/push-noop-origin.git" rev-parse main)
install_push_noop_wrapper "$fixture_root/push-noop-bin"
push_noop_output="$fixture_root/push-noop-output.txt"
if PATH="$fixture_root/push-noop-bin:$PATH" "$land" --branch ag-push-noop --item-id ag-push-noop --report "$fixture_root/push-noop-report.md" --repo "$fixture_root/push-noop-repo" >"$push_noop_output" 2>&1; then exit 1; fi
assert_output_has "$push_noop_output" 'LAND review-rounds attempt-persist-mismatch'
assert_output_has "$push_noop_output" 'LAND step=review-rounds status=fail'
assert_output_lacks "$push_noop_output" 'LAND verdict=landed'

make_fixture push-wrong-remote
push_wrong_sha=$(make_lane "$fixture_root/push-wrong-remote-repo" ag-push-wrong-remote)
report "$fixture_root/push-wrong-remote-report.md" "$push_wrong_sha"
push_wrong_before=$(git --git-dir="$fixture_root/push-wrong-remote-origin.git" rev-parse main)
printf '#!/usr/bin/env bash\ngit update-ref refs/heads/main %s\n' "$push_wrong_before" > "$fixture_root/push-wrong-remote-origin.git/hooks/post-receive"
chmod +x "$fixture_root/push-wrong-remote-origin.git/hooks/post-receive"
push_wrong_output="$fixture_root/push-wrong-remote-output.txt"
if "$land" --branch ag-push-wrong-remote --item-id ag-push-wrong-remote --report "$fixture_root/push-wrong-remote-report.md" --repo "$fixture_root/push-wrong-remote-repo" >"$push_wrong_output" 2>&1; then exit 1; fi
assert_output_has "$push_wrong_output" "LAND push remote-mismatch target=main found=$push_wrong_before expected="
assert_output_has "$push_wrong_output" 'LAND step=push status=fail'
assert_output_lacks "$push_wrong_output" 'LAND verdict=landed'

make_fixture no-push
no_push_sha=$(make_lane "$fixture_root/no-push-repo" ag-no-push)
report "$fixture_root/no-push-report.md" "$no_push_sha"
origin_before=$(git --git-dir="$fixture_root/no-push-origin.git" rev-parse main)
no_push_output="$fixture_root/no-push-output.txt"
"$land" --branch ag-no-push --item-id ag-no-push --report "$fixture_root/no-push-report.md" --repo "$fixture_root/no-push-repo" --no-push >"$no_push_output" 2>&1
assert_output_has "$no_push_output" 'LAND step=post-merge-verify status=skipped'
assert_output_has "$no_push_output" 'LAND step=push status=skipped'
assert test "$(git --git-dir="$fixture_root/no-push-origin.git" rev-parse main)" = "$origin_before"

make_fixture no-push-reap-fail
no_push_reap_fail_sha=$(make_lane "$fixture_root/no-push-reap-fail-repo" ag-no-push-reap-fail)
report "$fixture_root/no-push-reap-fail-report.md" "$no_push_reap_fail_sha"
origin_before=$(git --git-dir="$fixture_root/no-push-reap-fail-origin.git" rev-parse main)
git -C "$fixture_root/no-push-reap-fail-repo" worktree add "$fixture_root/no-push-reap-fail-worktree" ag-no-push-reap-fail >/dev/null
no_push_reap_fail_output="$fixture_root/no-push-reap-fail-output.txt"
if "$land" --branch ag-no-push-reap-fail --item-id ag-no-push-reap-fail --report "$fixture_root/no-push-reap-fail-report.md" --repo "$fixture_root/no-push-reap-fail-repo" --no-push >"$no_push_reap_fail_output" 2>&1; then exit 1; fi
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
"$land" --branch ag-remote-reap --item-id ag-remote-reap --report "$fixture_root/remote-reap-report.md" --repo "$fixture_root/remote-reap-repo" >"$remote_reap_output" 2>&1
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
if "$land" --branch ag-remote-reap-blocked --item-id ag-remote-reap-blocked --report "$fixture_root/remote-reap-blocked-report.md" --repo "$fixture_root/remote-reap-blocked-repo" >"$remote_reap_blocked_output" 2>&1; then exit 1; fi
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
if "$land" --branch ag-no-push-remote-retained --item-id ag-no-push-remote-retained --report "$fixture_root/no-push-remote-retained-report.md" --repo "$fixture_root/no-push-remote-retained-repo" --no-push >"$no_push_remote_retained_output" 2>&1; then exit 1; fi
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
if "$land" --branch ag-stale-main --item-id ag-stale-main --report "$fixture_root/stale-main-report.md" --repo "$fixture_root/stale-main-repo" >"$stale_main_output" 2>&1; then exit 1; fi
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
if "$land" --branch ag-lock --item-id ag-lock --report "$fixture_root/lock-report.md" --repo "$fixture_root/lock-repo" >"$lock_output" 2>&1; then exit 1; fi
wait "$lock_pid"
assert_output_has "$lock_output" 'LAND step=lock status=fail'
assert test "$(git -C "$fixture_root/lock-repo" rev-parse main)" = "$(git -C "$fixture_root/lock-repo" rev-parse origin/main)"
assert git -C "$fixture_root/lock-repo" show-ref --verify --quiet refs/heads/ag-lock

make_fixture push-rollback
push_rollback_sha=$(make_lane "$fixture_root/push-rollback-repo" ag-push-rollback)
report "$fixture_root/push-rollback-report.md" "$push_rollback_sha"
printf '#!/usr/bin/env bash\nwhile read -r _old _new ref; do [ "$ref" != refs/heads/main ] || exit 1; done\nexit 0\n' > "$fixture_root/push-rollback-origin.git/hooks/pre-receive"
chmod +x "$fixture_root/push-rollback-origin.git/hooks/pre-receive"
push_rollback_output="$fixture_root/push-rollback-output.txt"
if "$land" --branch ag-push-rollback --item-id ag-push-rollback --report "$fixture_root/push-rollback-report.md" --repo "$fixture_root/push-rollback-repo" >"$push_rollback_output" 2>&1; then exit 1; fi
assert_output_has "$push_rollback_output" 'LAND step=push status=fail'
assert_output_has "$push_rollback_output" 'main reset to origin/main'
assert test "$(git -C "$fixture_root/push-rollback-repo" rev-parse main)" = "$(git -C "$fixture_root/push-rollback-repo" rev-parse origin/main)"
assert git -C "$fixture_root/push-rollback-repo" show-ref --verify --quiet refs/heads/ag-push-rollback

# REGRESSION V3-0.29 F1: a candidate cannot mint operator authority by adding
# the old working-tree signer path.
make_fixture operator-trust-root
git -C "$fixture_root/operator-trust-root-repo" checkout -b ag-operator-trust-root >/dev/null
mkdir -p "$fixture_root/operator-trust-root-repo/instance"
printf 'lane ssh-ed25519 AAAA\n' > "$fixture_root/operator-trust-root-repo/instance/operator-unpark.allowed-signers"
git -C "$fixture_root/operator-trust-root-repo" add instance/operator-unpark.allowed-signers
git -C "$fixture_root/operator-trust-root-repo" commit -m operator-trust-root >/dev/null
operator_trust_root_sha=$(git -C "$fixture_root/operator-trust-root-repo" rev-parse HEAD)
git -C "$fixture_root/operator-trust-root-repo" checkout main >/dev/null
report "$fixture_root/operator-trust-root-report.md" "$operator_trust_root_sha"
operator_trust_root_output="$fixture_root/operator-trust-root-output.txt"
if "$land" --branch ag-operator-trust-root --item-id ag-operator-trust-root --report "$fixture_root/operator-trust-root-report.md" --repo "$fixture_root/operator-trust-root-repo" >"$operator_trust_root_output" 2>&1; then exit 1; fi
assert_output_has "$operator_trust_root_output" 'LAND step=payload-guard status=fail detail=reserved-path path=instance/operator-unpark.allowed-signers'
assert_output_lacks "$operator_trust_root_output" 'LAND step=merge status=pass'

# The grant lives in the file's YAML frontmatter, where the prose of a verbatim
# operator capture cannot reach it. Everything after the closing `---` is text
# about an authorization, never an authorization.
unpark_authorization() {
  printf -- '---\nid: %s\noperator-unpark: v2 item=%s decision=%s park=no-progress\n---\n\n# %s\n' \
    "$2" "$1" "$2" "$2"
}

# REGRESSION V3-0.29 r3: an operator decision tracked on origin/main -- and only
# there -- releases a no-progress park. Proven on fixture items throughout.
make_fixture operator-unpark-decision
unpark_repo="$fixture_root/operator-unpark-decision-repo"
unpark_state="$unpark_repo/.bpa/review-rounds.json"
mkdir -p "$unpark_repo/.bpa"
env -u BUN_BIN bun "$root/gate/review-rounds.ts" init --state "$unpark_state" --cap 10 --no-progress-limit 3 >/dev/null
for unpark_item in ag-unpark-decision ag-unpark-second; do
  for _unpark_round in 1 2 3; do
    env -u BUN_BIN bun "$root/gate/review-rounds.ts" attempt --defer-park-exit --state "$unpark_state" --item-id "$unpark_item" >/dev/null
  done
done
git -C "$unpark_repo" add .bpa/review-rounds.json
git -C "$unpark_repo" commit -m 'seed parked items' >/dev/null
git -C "$unpark_repo" push origin main >/dev/null
unpark_sha=$(make_lane "$unpark_repo" ag-unpark-decision)
report "$fixture_root/operator-unpark-decision-report.md" "$unpark_sha"

# Without a tracked decision the park still refuses.
unpark_refused_output="$fixture_root/operator-unpark-decision-refused.txt"
if "$land" --branch ag-unpark-decision --item-id ag-unpark-decision --report "$fixture_root/operator-unpark-decision-report.md" --repo "$unpark_repo" --no-push >"$unpark_refused_output" 2>&1; then exit 1; fi
assert_output_has "$unpark_refused_output" 'REVIEW_ROUNDS status=unpark-none item=ag-unpark-decision'
assert_output_has "$unpark_refused_output" 'parked=no-progress'
assert_output_lacks "$unpark_refused_output" 'LAND step=merge status=pass'

# A decision the lane wrote itself is not authority: the gate reads origin, so
# the candidate's own file is invisible and the park is unchanged.
git -C "$unpark_repo" checkout ag-unpark-decision >/dev/null
mkdir -p "$unpark_repo/instance/decisions"
unpark_authorization ag-unpark-decision HR-9999 > "$unpark_repo/instance/decisions/HR-9999.md"
git -C "$unpark_repo" add instance/decisions/HR-9999.md
git -C "$unpark_repo" commit -m lane-authored-authorization >/dev/null
unpark_self_sha=$(git -C "$unpark_repo" rev-parse HEAD)
git -C "$unpark_repo" checkout main >/dev/null
report "$fixture_root/operator-unpark-self-report.md" "$unpark_self_sha"
unpark_self_output="$fixture_root/operator-unpark-decision-self.txt"
if "$land" --branch ag-unpark-decision --item-id ag-unpark-decision --report "$fixture_root/operator-unpark-self-report.md" --repo "$unpark_repo" --no-push >"$unpark_self_output" 2>&1; then exit 1; fi
assert_output_has "$unpark_self_output" 'REVIEW_ROUNDS status=unpark-none item=ag-unpark-decision'
assert_output_has "$unpark_self_output" 'parked=no-progress'
assert_output_lacks "$unpark_self_output" 'LAND step=merge status=pass'
git -C "$unpark_repo" branch -f ag-unpark-decision "$unpark_sha"

# The operator's decision, tracked on origin/main, makes the same item landable.
mkdir -p "$unpark_repo/instance/decisions"
unpark_authorization ag-unpark-decision HR-2149 > "$unpark_repo/instance/decisions/HR-2149.md"
git -C "$unpark_repo" add instance/decisions/HR-2149.md
git -C "$unpark_repo" commit -m 'record HR-2149' >/dev/null
git -C "$unpark_repo" push origin main >/dev/null
unpark_landed_output="$fixture_root/operator-unpark-decision-landed.txt"
"$land" --branch ag-unpark-decision --item-id ag-unpark-decision --report "$fixture_root/operator-unpark-decision-report.md" --repo "$unpark_repo" --no-push >"$unpark_landed_output" 2>&1
assert_output_has "$unpark_landed_output" 'REVIEW_ROUNDS status=unparked item=ag-unpark-decision decision=HR-2149 source=instance/decisions/HR-2149.md'
assert_output_has "$unpark_landed_output" 'LAND verdict=landed sha='
assert grep -Fq '"HR-2149": "ag-unpark-decision"' "$unpark_state"
git -C "$unpark_repo" push origin main >/dev/null

# The same decision retargeted at a second parked item is refused: a decision id
# is bound to the one item it released.
git -C "$unpark_repo" checkout -b ag-unpark-second >/dev/null
printf 'second\n' > "$unpark_repo/second.txt"
git -C "$unpark_repo" add second.txt
git -C "$unpark_repo" commit -m second >/dev/null
unpark_second_sha=$(git -C "$unpark_repo" rev-parse HEAD)
git -C "$unpark_repo" checkout main >/dev/null
unpark_authorization ag-unpark-second HR-2149 > "$unpark_repo/instance/decisions/HR-2149.md"
git -C "$unpark_repo" commit -am 'retarget HR-2149' >/dev/null
git -C "$unpark_repo" push origin main >/dev/null
report "$fixture_root/operator-unpark-second-report.md" "$unpark_second_sha"
unpark_second_output="$fixture_root/operator-unpark-decision-second.txt"
if "$land" --branch ag-unpark-second --item-id ag-unpark-second --report "$fixture_root/operator-unpark-second-report.md" --repo "$unpark_repo" --no-push >"$unpark_second_output" 2>&1; then exit 1; fi
assert_output_has "$unpark_second_output" 'decision-bound-to-other-item decision=HR-2149 bound=ag-unpark-decision'
assert_output_lacks "$unpark_second_output" 'LAND step=merge status=pass'

# REGRESSION V3-0.29 r3: a candidate carrying an authorization is a reserved-path
# refusal, so a lane cannot land the authority this gate reads back.
make_fixture operator-unpark-reserved
git -C "$fixture_root/operator-unpark-reserved-repo" checkout -b ag-operator-unpark-reserved >/dev/null
mkdir -p "$fixture_root/operator-unpark-reserved-repo/instance/decisions"
unpark_authorization ag-operator-unpark-reserved HR-9999 > "$fixture_root/operator-unpark-reserved-repo/instance/decisions/HR-9999.md"
git -C "$fixture_root/operator-unpark-reserved-repo" add instance/decisions/HR-9999.md
git -C "$fixture_root/operator-unpark-reserved-repo" commit -m lane-authorization >/dev/null
operator_unpark_reserved_sha=$(git -C "$fixture_root/operator-unpark-reserved-repo" rev-parse HEAD)
git -C "$fixture_root/operator-unpark-reserved-repo" checkout main >/dev/null
report "$fixture_root/operator-unpark-reserved-report.md" "$operator_unpark_reserved_sha"
operator_unpark_reserved_output="$fixture_root/operator-unpark-reserved-output.txt"
if "$land" --branch ag-operator-unpark-reserved --item-id ag-operator-unpark-reserved --report "$fixture_root/operator-unpark-reserved-report.md" --repo "$fixture_root/operator-unpark-reserved-repo" >"$operator_unpark_reserved_output" 2>&1; then exit 1; fi
assert_output_has "$operator_unpark_reserved_output" 'LAND step=payload-guard status=fail detail=reserved-path path=instance/decisions/HR-9999.md'
assert_output_lacks "$operator_unpark_reserved_output" 'LAND step=merge status=pass'

# The reservation is the authorization, not the directory: recording an ordinary
# decision stays ordinary lane work.
make_fixture operator-unpark-plain-decision
git -C "$fixture_root/operator-unpark-plain-decision-repo" checkout -b ag-operator-unpark-plain >/dev/null
mkdir -p "$fixture_root/operator-unpark-plain-decision-repo/instance/decisions"
printf '# HR-1234\n\nThe operator asked for a shorter status line.\n' > "$fixture_root/operator-unpark-plain-decision-repo/instance/decisions/HR-1234.md"
git -C "$fixture_root/operator-unpark-plain-decision-repo" add instance/decisions/HR-1234.md
git -C "$fixture_root/operator-unpark-plain-decision-repo" commit -m plain-decision >/dev/null
operator_unpark_plain_sha=$(git -C "$fixture_root/operator-unpark-plain-decision-repo" rev-parse HEAD)
git -C "$fixture_root/operator-unpark-plain-decision-repo" checkout main >/dev/null
report "$fixture_root/operator-unpark-plain-report.md" "$operator_unpark_plain_sha"
operator_unpark_plain_output="$fixture_root/operator-unpark-plain-output.txt"
"$land" --branch ag-operator-unpark-plain --item-id ag-operator-unpark-plain --report "$fixture_root/operator-unpark-plain-report.md" --repo "$fixture_root/operator-unpark-plain-decision-repo" --no-push >"$operator_unpark_plain_output" 2>&1
assert_output_has "$operator_unpark_plain_output" 'LAND verdict=landed sha='

# REGRESSION V3-0.29 r4 F5: quoting the format back is governance, not authority.
# instance/decisions/ is where the operator's words are stored verbatim (Hard
# Rule 16) and the doc that teaches this feature prints the line in a fence, so
# a capture of him discussing it must stay landable and must grant nothing.
make_fixture operator-unpark-quoted-decision
unpark_quoted_repo="$fixture_root/operator-unpark-quoted-decision-repo"
git -C "$unpark_quoted_repo" checkout -b ag-operator-unpark-quoted >/dev/null
mkdir -p "$unpark_quoted_repo/instance/decisions"
printf '# HR-1235\n\nHe asked how it works. The line is:\n\n```text\noperator-unpark: v2 item=ag-operator-unpark-quoted decision=HR-1235 park=no-progress\n```\n' \
  > "$unpark_quoted_repo/instance/decisions/HR-1235.md"
git -C "$unpark_quoted_repo" add instance/decisions/HR-1235.md
git -C "$unpark_quoted_repo" commit -m quoted-decision >/dev/null
unpark_quoted_sha=$(git -C "$unpark_quoted_repo" rev-parse HEAD)
git -C "$unpark_quoted_repo" checkout main >/dev/null
report "$fixture_root/operator-unpark-quoted-report.md" "$unpark_quoted_sha"
unpark_quoted_output="$fixture_root/operator-unpark-quoted-output.txt"
"$land" --branch ag-operator-unpark-quoted --item-id ag-operator-unpark-quoted --report "$fixture_root/operator-unpark-quoted-report.md" --repo "$unpark_quoted_repo" --no-push >"$unpark_quoted_output" 2>&1
assert_output_has "$unpark_quoted_output" 'LAND verdict=landed sha='
assert_output_lacks "$unpark_quoted_output" 'reserved-path path=instance/decisions/HR-1235.md'
assert_output_lacks "$unpark_quoted_output" 'status=unparked'

# REGRESSION V3-0.29 r4 F3: the reserved-path guard reads every candidate file,
# including one whose name Git would C-quote. Feeding the loop from an unquoted
# `git diff --name-only` handed `cat-file -e` a quoted string, the `&&`
# short-circuited into "not a reserved path", and a self-authored authorization
# landed on main.
make_fixture operator-unpark-quoted-path
unpark_quoted_path_repo="$fixture_root/operator-unpark-quoted-path-repo"
git -C "$unpark_quoted_path_repo" checkout -b ag-operator-unpark-quoted-path >/dev/null
mkdir -p "$unpark_quoted_path_repo/instance/decisions"
unpark_authorization ag-operator-unpark-quoted-path HR-9999 > "$unpark_quoted_path_repo/instance/decisions/HR-9999é.md"
git -C "$unpark_quoted_path_repo" add "instance/decisions/HR-9999é.md"
git -C "$unpark_quoted_path_repo" commit -m quoted-path-authorization >/dev/null
unpark_quoted_path_sha=$(git -C "$unpark_quoted_path_repo" rev-parse HEAD)
git -C "$unpark_quoted_path_repo" checkout main >/dev/null
report "$fixture_root/operator-unpark-quoted-path-report.md" "$unpark_quoted_path_sha"
unpark_quoted_path_output="$fixture_root/operator-unpark-quoted-path-output.txt"
if "$land" --branch ag-operator-unpark-quoted-path --item-id ag-operator-unpark-quoted-path --report "$fixture_root/operator-unpark-quoted-path-report.md" --repo "$unpark_quoted_path_repo" >"$unpark_quoted_path_output" 2>&1; then exit 1; fi
assert_output_has "$unpark_quoted_path_output" 'LAND step=payload-guard status=fail detail=reserved-path path=instance/decisions/HR-9999é.md'
assert_output_lacks "$unpark_quoted_path_output" 'LAND step=merge status=pass'

# REGRESSION V3-0.29 r4 F1: the trust root is the SHA origin answers with, not a
# ref name. Every lane worktree here shares one Git common directory, so
# refs/remotes/origin/<target> is writable by any lane with a plain
# `git update-ref` -- no push, no key, no privilege. A landing whose local view
# of the target disagrees with origin is refused before any authority is read.
make_fixture operator-unpark-forged-ref
unpark_forged_repo="$fixture_root/operator-unpark-forged-ref-repo"
unpark_forged_state="$unpark_forged_repo/.bpa/review-rounds.json"
mkdir -p "$unpark_forged_repo/.bpa"
env -u BUN_BIN bun "$root/gate/review-rounds.ts" init --state "$unpark_forged_state" --cap 10 --no-progress-limit 3 >/dev/null
for _unpark_round in 1 2 3; do
  env -u BUN_BIN bun "$root/gate/review-rounds.ts" attempt --defer-park-exit --state "$unpark_forged_state" --item-id ag-unpark-forged >/dev/null
done
git -C "$unpark_forged_repo" add .bpa/review-rounds.json
git -C "$unpark_forged_repo" commit -m 'seed parked item' >/dev/null
git -C "$unpark_forged_repo" push origin main >/dev/null
git -C "$unpark_forged_repo" checkout -b v3 >/dev/null
git -C "$unpark_forged_repo" push -u origin v3 >/dev/null
unpark_forged_lane_sha=$(make_lane "$unpark_forged_repo" ag-unpark-forged)
report "$fixture_root/operator-unpark-forged-report.md" "$unpark_forged_lane_sha"
git -C "$unpark_forged_repo" checkout v3 >/dev/null
# Origin no longer has the branch, so `git fetch origin` leaves the stale
# remote-tracking ref exactly where a lane put it -- the deterministic form of
# the same primitive. The authorization is committed locally and never pushed.
git -C "$unpark_forged_repo" push origin --delete v3 >/dev/null 2>&1
mkdir -p "$unpark_forged_repo/instance/decisions"
unpark_authorization ag-unpark-forged HR-5001 > "$unpark_forged_repo/instance/decisions/HR-5001.md"
git -C "$unpark_forged_repo" add instance/decisions/HR-5001.md
git -C "$unpark_forged_repo" commit -m forged-authorization >/dev/null
unpark_forged_sha=$(git -C "$unpark_forged_repo" rev-parse v3)
git -C "$unpark_forged_repo" update-ref refs/remotes/origin/v3 "$unpark_forged_sha"
unpark_forged_output="$fixture_root/operator-unpark-forged-output.txt"
if "$land" --branch ag-unpark-forged --item-id ag-unpark-forged --report "$fixture_root/operator-unpark-forged-report.md" --repo "$unpark_forged_repo" --target-branch v3 --no-push >"$unpark_forged_output" 2>&1; then exit 1; fi
# The local view is self-consistent -- refs/heads/v3 and refs/remotes/origin/v3
# agree -- so the old freshness check passes. Only asking origin catches it.
assert_output_has "$unpark_forged_output" "LAND freshness origin-target-mismatch target=v3 origin=missing local=$unpark_forged_sha"
assert_output_lacks "$unpark_forged_output" 'status=unparked'
assert_output_lacks "$unpark_forged_output" 'LAND step=merge status=pass'
assert grep -Fq '"park": "no-progress"' "$unpark_forged_state"
assert_output_lacks "$unpark_forged_output" 'HR-5001'

# A lane branch is never an authority root, even when it exists on origin: only
# an integration branch reaches origin through this gate's review requirement,
# which is the whole reason a decision tracked there means anything. This is the
# one check that still needs a branch NAME, so it lives here rather than in the
# unpark command, which now takes an immutable SHA and refuses names outright.
git -C "$unpark_forged_repo" checkout -b ag-other-root >/dev/null
git -C "$unpark_forged_repo" push -u origin ag-other-root >/dev/null
git -C "$unpark_forged_repo" checkout ag-other-root >/dev/null
unpark_lane_root_output="$fixture_root/operator-unpark-lane-root-output.txt"
if "$land" --branch ag-unpark-forged --item-id ag-unpark-forged --report "$fixture_root/operator-unpark-forged-report.md" --repo "$unpark_forged_repo" --target-branch ag-other-root --no-push >"$unpark_lane_root_output" 2>&1; then exit 1; fi
assert_output_has "$unpark_lane_root_output" 'LAND target-branch lane-branch-not-an-authority-root target=ag-other-root'
assert_output_has "$unpark_lane_root_output" 'LAND step=target-branch status=fail'
assert_output_lacks "$unpark_lane_root_output" 'LAND step=merge status=pass'

# REGRESSION V3-0.29 r4 F2: one aborted landing must not strand the operator's
# decision. The authorised attempt pushes attempt ref N to origin and then
# aborts, so the target branch never records the unpark while the ref is
# permanent. Replaying that ref used to die on the park before either authority
# was consulted, which made the park unreleasable and the one-time decision
# unspendable forever.
make_fixture operator-unpark-abort
unpark_abort_repo="$fixture_root/operator-unpark-abort-repo"
unpark_abort_state="$unpark_abort_repo/.bpa/review-rounds.json"
mkdir -p "$unpark_abort_repo/.bpa"
env -u BUN_BIN bun "$root/gate/review-rounds.ts" init --state "$unpark_abort_state" --cap 3 --no-progress-limit 3 >/dev/null
for _unpark_round in 1 2 3; do
  env -u BUN_BIN bun "$root/gate/review-rounds.ts" attempt --defer-park-exit --state "$unpark_abort_state" --item-id ag-unpark-abort >/dev/null
done
git -C "$unpark_abort_repo" add .bpa/review-rounds.json
git -C "$unpark_abort_repo" commit -m 'seed parked item' >/dev/null
mkdir -p "$unpark_abort_repo/instance/decisions"
unpark_authorization ag-unpark-abort HR-2149 > "$unpark_abort_repo/instance/decisions/HR-2149.md"
git -C "$unpark_abort_repo" add instance/decisions/HR-2149.md
git -C "$unpark_abort_repo" commit -m 'record HR-2149' >/dev/null
git -C "$unpark_abort_repo" push origin main >/dev/null
unpark_abort_sha=$(make_lane "$unpark_abort_repo" ag-unpark-abort)
# The authorised round, aborted after the merge by a failing reviewed verify.
printf 'commit: %s fixture\nverify: false\nresult: clean\nsecret-scan: clean\nremaining: none\n' "$unpark_abort_sha" \
  > "$fixture_root/operator-unpark-abort-report.md"
unpark_abort_first="$fixture_root/operator-unpark-abort-first.txt"
if "$land" --branch ag-unpark-abort --item-id ag-unpark-abort --report "$fixture_root/operator-unpark-abort-report.md" --repo "$unpark_abort_repo" --run-verify --no-push >"$unpark_abort_first" 2>&1; then exit 1; fi
assert_output_has "$unpark_abort_first" 'REVIEW_ROUNDS status=unparked item=ag-unpark-abort decision=HR-2149'
assert_output_has "$unpark_abort_first" 'LAND verdict=aborted'
# Origin now carries the attempt ref, and main never recorded the release.
assert test -n "$(git -C "$unpark_abort_repo" ls-remote --refs origin 'refs/bpa-review-attempts/*')"
assert grep -Fq '"park": "no-progress"' "$(git -C "$unpark_abort_repo" rev-parse --show-toplevel)/.bpa/review-rounds.json"
# A second, clean attempt on the same branch must still be admitted: the
# decision is intact on origin/main and has never been consumed.
report "$fixture_root/operator-unpark-abort-report.md" "$unpark_abort_sha"
unpark_abort_second="$fixture_root/operator-unpark-abort-second.txt"
"$land" --branch ag-unpark-abort --item-id ag-unpark-abort --report "$fixture_root/operator-unpark-abort-report.md" --repo "$unpark_abort_repo" --no-push >"$unpark_abort_second" 2>&1
assert_output_has "$unpark_abort_second" 'REVIEW_ROUNDS status=unparked item=ag-unpark-abort decision=HR-2149'
assert_output_has "$unpark_abort_second" 'LAND verdict=landed sha='
assert grep -Fq '"HR-2149": "ag-unpark-abort"' "$unpark_abort_state"

# REGRESSION V3-0.29 r4 F4: a malformed or hostile decision file on the target
# branch fails that decision, never the gate. It used to abort every landing of
# every item -- including the landing of the branch that would delete it, which
# left no repair path through the gate at all.
make_fixture operator-unpark-hostile
unpark_hostile_repo="$fixture_root/operator-unpark-hostile-repo"
mkdir -p "$unpark_hostile_repo/instance/decisions/archive"
printf -- '---\noperator-unpark: v2 item=ag-elsewhere decision=HR-3000 park=no-progress\noperator-unpark: v2 item=ag-elsewhere decision=HR-3000 park=no-progress\n---\n' \
  > "$unpark_hostile_repo/instance/decisions/HR-3000.md"
printf -- '---\noperator-unpark: v2 item=ag-elsewhere decision=HR-3001 park=cap\n---\n' \
  > "$unpark_hostile_repo/instance/decisions/HR-3001.md"
unpark_authorization ag-elsewhere HR-9999 > "$unpark_hostile_repo/instance/decisions/HR-9999é.md"
unpark_authorization ag-elsewhere HR-4000 > "$unpark_hostile_repo/instance/decisions/archive/HR-4000.md"
git -C "$unpark_hostile_repo" add instance/decisions
git -C "$unpark_hostile_repo" commit -m 'hostile decisions' >/dev/null
git -C "$unpark_hostile_repo" push origin main >/dev/null
unpark_hostile_sha=$(make_lane "$unpark_hostile_repo" ag-unpark-hostile)
report "$fixture_root/operator-unpark-hostile-report.md" "$unpark_hostile_sha"
unpark_hostile_output="$fixture_root/operator-unpark-hostile-output.txt"
"$land" --branch ag-unpark-hostile --item-id ag-unpark-hostile --report "$fixture_root/operator-unpark-hostile-report.md" --repo "$unpark_hostile_repo" --no-push >"$unpark_hostile_output" 2>&1
assert_output_has "$unpark_hostile_output" 'LAND verdict=landed sha='
assert_output_has "$unpark_hostile_output" 'REVIEW_ROUNDS status=warn detail=decision-ignored-not-this-item path=instance/decisions/HR-3000.md'
git -C "$unpark_hostile_repo" push origin main >/dev/null
# And the repair goes through the gate: a branch that deletes the offending
# files lands like any other change.
git -C "$unpark_hostile_repo" checkout -b ag-unpark-repair >/dev/null
git -C "$unpark_hostile_repo" rm -q "instance/decisions/HR-3000.md" "instance/decisions/HR-3001.md" "instance/decisions/HR-9999é.md" "instance/decisions/archive/HR-4000.md"
git -C "$unpark_hostile_repo" commit -m 'remove the malformed decisions' >/dev/null
unpark_repair_sha=$(git -C "$unpark_hostile_repo" rev-parse HEAD)
git -C "$unpark_hostile_repo" checkout main >/dev/null
report "$fixture_root/operator-unpark-repair-report.md" "$unpark_repair_sha"
unpark_repair_output="$fixture_root/operator-unpark-repair-output.txt"
"$land" --branch ag-unpark-repair --item-id ag-unpark-repair --report "$fixture_root/operator-unpark-repair-report.md" --repo "$unpark_hostile_repo" --no-push >"$unpark_repair_output" 2>&1
assert_output_has "$unpark_repair_output" 'LAND verdict=landed sha='

# REGRESSION V3-0.29 r5 F8: the reserved-path guard and the authority reader are
# ONE predicate. They used to be two -- an awk over a bash command substitution,
# and a TypeScript reader over raw bytes -- and bash silently deletes NUL bytes
# from $(...). A file whose third line is `-<NUL>--` therefore closed the
# frontmatter for the guard (grant outside the block, not reserved) while the
# reader saw a line that is not `---` (grant inside the block, grants). A lane
# landed its own operator authorization through the ordinary gate and then spent
# it on its own park. Both halves are locked here: the candidate is refused, and
# the same bytes tracked on the target branch grant nothing.
make_fixture unpark-nul-blob
unpark_nul_repo="$fixture_root/unpark-nul-blob-repo"
git -C "$unpark_nul_repo" checkout -b ag-unpark-nul >/dev/null
mkdir -p "$unpark_nul_repo/instance/decisions"
printf -- '---\nid: HR-9999\n-\000--\noperator-unpark: v2 item=ag-unpark-nul decision=HR-9999 park=no-progress\n---\n' \
  > "$unpark_nul_repo/instance/decisions/HR-9999.md"
assert grep -qa 'operator-unpark' "$unpark_nul_repo/instance/decisions/HR-9999.md"
git -C "$unpark_nul_repo" add instance/decisions/HR-9999.md
git -C "$unpark_nul_repo" commit -m nul-authorization >/dev/null
unpark_nul_sha=$(git -C "$unpark_nul_repo" rev-parse HEAD)
git -C "$unpark_nul_repo" checkout main >/dev/null
report "$fixture_root/unpark-nul-report.md" "$unpark_nul_sha"
unpark_nul_output="$fixture_root/unpark-nul-output.txt"
if "$land" --branch ag-unpark-nul --item-id ag-unpark-nul --report "$fixture_root/unpark-nul-report.md" --repo "$unpark_nul_repo" >"$unpark_nul_output" 2>&1; then exit 1; fi
assert_output_has "$unpark_nul_output" 'LAND step=payload-guard status=fail detail=reserved-path path=instance/decisions/HR-9999.md'
assert_output_lacks "$unpark_nul_output" 'LAND step=merge status=pass'

# Reader half: the same bytes, already tracked on the target branch, against a
# genuinely parked item. A blob the shared predicate cannot certify as text
# grants nothing -- and says so rather than passing over it silently.
make_fixture unpark-nul-authority
unpark_nul_auth_repo="$fixture_root/unpark-nul-authority-repo"
unpark_nul_auth_state="$unpark_nul_auth_repo/.bpa/review-rounds.json"
mkdir -p "$unpark_nul_auth_repo/.bpa" "$unpark_nul_auth_repo/instance/decisions"
env -u BUN_BIN bun "$root/gate/review-rounds.ts" init --state "$unpark_nul_auth_state" --cap 10 --no-progress-limit 3 >/dev/null
for _unpark_round in 1 2 3; do
  env -u BUN_BIN bun "$root/gate/review-rounds.ts" attempt --defer-park-exit --state "$unpark_nul_auth_state" --item-id ag-unpark-nul-auth >/dev/null
done
printf -- '---\nid: HR-9999\n-\000--\noperator-unpark: v2 item=ag-unpark-nul-auth decision=HR-9999 park=no-progress\n---\n' \
  > "$unpark_nul_auth_repo/instance/decisions/HR-9999.md"
git -C "$unpark_nul_auth_repo" add .bpa/review-rounds.json instance/decisions/HR-9999.md
git -C "$unpark_nul_auth_repo" commit -m 'parked item plus a NUL-carrying decision' >/dev/null
git -C "$unpark_nul_auth_repo" push origin main >/dev/null
unpark_nul_auth_sha=$(make_lane "$unpark_nul_auth_repo" ag-unpark-nul-auth)
report "$fixture_root/unpark-nul-authority-report.md" "$unpark_nul_auth_sha"
unpark_nul_auth_output="$fixture_root/unpark-nul-authority-output.txt"
if "$land" --branch ag-unpark-nul-auth --item-id ag-unpark-nul-auth --report "$fixture_root/unpark-nul-authority-report.md" --repo "$unpark_nul_auth_repo" --no-push >"$unpark_nul_auth_output" 2>&1; then exit 1; fi
assert_output_has "$unpark_nul_auth_output" 'REVIEW_ROUNDS status=warn detail=decision-ignored-binary path=instance/decisions/HR-9999.md'
assert_output_lacks "$unpark_nul_auth_output" 'status=unparked'
assert_output_lacks "$unpark_nul_auth_output" 'LAND step=merge status=pass'
assert grep -Fq '"park": "no-progress"' "$unpark_nul_auth_state"

# REGRESSION V3-0.29 r5 F1: `origin` is not a fixed thing. remote.origin.url
# lives in the Git common directory every lane worktree shares, and Git honors
# multiple pushurl values -- so three plain `git config` writes once split the
# gate's reads (ls-remote, fetch) from its writes: authority was read from a
# forged repository holding a self-authored decision while the merge still
# reached the real origin. The gate now resolves ONE url and uses it for every
# remote read and write; a second url or any pushurl is refused outright.
make_fixture origin-redirect
origin_redirect_repo="$fixture_root/origin-redirect-repo"
origin_redirect_real="$fixture_root/origin-redirect-origin.git"
origin_redirect_state="$origin_redirect_repo/.bpa/review-rounds.json"
mkdir -p "$origin_redirect_repo/.bpa" "$origin_redirect_repo/instance"
env -u BUN_BIN bun "$root/gate/review-rounds.ts" init --state "$origin_redirect_state" --cap 10 --no-progress-limit 3 >/dev/null
for _unpark_round in 1 2 3; do
  env -u BUN_BIN bun "$root/gate/review-rounds.ts" attempt --defer-park-exit --state "$origin_redirect_state" --item-id ag-origin-redirect >/dev/null
done
# The pin has one home: instance/params.yaml, read from the SHA origin answers
# with. A redirected clone must forge durable tracked content, not a config line.
printf 'repos:\n  git_remote: %s   # pinned origin\n' "$origin_redirect_real" > "$origin_redirect_repo/instance/params.yaml"
git -C "$origin_redirect_repo" add .bpa/review-rounds.json instance/params.yaml
git -C "$origin_redirect_repo" commit -m 'seed parked item and pin origin' >/dev/null
git -C "$origin_redirect_repo" push origin main >/dev/null
origin_redirect_lane_sha=$(make_lane "$origin_redirect_repo" ag-origin-redirect)
report "$fixture_root/origin-redirect-report.md" "$origin_redirect_lane_sha"
# The forged origin: a full copy of the real one, plus one commit adding the
# authorization the lane wrote itself.
origin_redirect_forged="$fixture_root/origin-redirect-forged.git"
git clone --bare "$origin_redirect_real" "$origin_redirect_forged" >/dev/null 2>&1
git clone "$origin_redirect_forged" "$fixture_root/origin-redirect-forger" >/dev/null 2>&1
git -C "$fixture_root/origin-redirect-forger" config user.email land@example.test
git -C "$fixture_root/origin-redirect-forger" config user.name Land
mkdir -p "$fixture_root/origin-redirect-forger/instance/decisions"
unpark_authorization ag-origin-redirect HR-5001 > "$fixture_root/origin-redirect-forger/instance/decisions/HR-5001.md"
git -C "$fixture_root/origin-redirect-forger" add instance/decisions/HR-5001.md
git -C "$fixture_root/origin-redirect-forger" commit -m 'self-authored authorization' >/dev/null
git -C "$fixture_root/origin-redirect-forger" push origin main >/dev/null
# The whole attack, verbatim: reads go to the forged copy, writes to both.
git -C "$origin_redirect_repo" config remote.origin.url "$origin_redirect_forged"
git -C "$origin_redirect_repo" config --add remote.origin.pushurl "$origin_redirect_real"
git -C "$origin_redirect_repo" config --add remote.origin.pushurl "$origin_redirect_forged"
git -C "$origin_redirect_repo" fetch origin >/dev/null 2>&1
git -C "$origin_redirect_repo" reset --hard origin/main >/dev/null 2>&1
origin_redirect_output="$fixture_root/origin-redirect-output.txt"
if "$land" --branch ag-origin-redirect --item-id ag-origin-redirect --report "$fixture_root/origin-redirect-report.md" --repo "$origin_redirect_repo" >"$origin_redirect_output" 2>&1; then exit 1; fi
assert_output_has "$origin_redirect_output" 'LAND freshness origin-pushurl-refused'
assert_output_lacks "$origin_redirect_output" 'status=unparked'
assert_output_lacks "$origin_redirect_output" 'LAND step=merge status=pass'
assert test "$(git -C "$origin_redirect_real" rev-parse main)" != "$(git -C "$origin_redirect_forged" rev-parse main)"

# Without the pushurl split, a single redirected url is caught by the pin the
# target branch itself tracks: the authority is not "whatever this clone calls
# origin" any more.
git -C "$origin_redirect_repo" config --unset-all remote.origin.pushurl
origin_pin_output="$fixture_root/origin-redirect-pin-output.txt"
if "$land" --branch ag-origin-redirect --item-id ag-origin-redirect --report "$fixture_root/origin-redirect-report.md" --repo "$origin_redirect_repo" >"$origin_pin_output" 2>&1; then exit 1; fi
assert_output_has "$origin_pin_output" "LAND freshness origin-redirected pinned=$origin_redirect_real configured=$origin_redirect_forged"
assert_output_lacks "$origin_pin_output" 'status=unparked'
assert_output_lacks "$origin_pin_output" 'LAND step=merge status=pass'

# And the residual case, stated so nobody mistakes it for a hole: an attacker
# who also rewrites the pin ON the forged remote gets a landing that succeeds
# against the forged repository -- and reaches the real origin with nothing.
# That is the property the single url buys: read and write cannot be split.
git -C "$fixture_root/origin-redirect-forger" fetch origin >/dev/null 2>&1
git -C "$fixture_root/origin-redirect-forger" reset --hard origin/main >/dev/null 2>&1
printf 'repos:\n  git_remote: %s   # pinned origin\n' "$origin_redirect_forged" > "$fixture_root/origin-redirect-forger/instance/params.yaml"
git -C "$fixture_root/origin-redirect-forger" add instance/params.yaml
git -C "$fixture_root/origin-redirect-forger" commit -m 'forge the pin too' >/dev/null
git -C "$fixture_root/origin-redirect-forger" push origin main >/dev/null
git -C "$origin_redirect_repo" fetch origin >/dev/null 2>&1
git -C "$origin_redirect_repo" reset --hard origin/main >/dev/null 2>&1
origin_real_before=$(git -C "$origin_redirect_real" rev-parse main)
origin_forged_output="$fixture_root/origin-redirect-forged-output.txt"
"$land" --branch ag-origin-redirect --item-id ag-origin-redirect --report "$fixture_root/origin-redirect-report.md" --repo "$origin_redirect_repo" >"$origin_forged_output" 2>&1
assert_output_has "$origin_forged_output" 'LAND verdict=landed sha='
assert test "$(git -C "$origin_redirect_real" rev-parse main)" = "$origin_real_before"
assert_not git -C "$origin_redirect_real" cat-file -e main:instance/decisions/HR-5001.md

# The pinned value is authority-adjacent state: a candidate that rewrites it
# redirects every later landing's trust root, so the VALUE is reserved even
# though instance/params.yaml stays ordinary, heavily edited instance state.
make_fixture origin-pin-candidate
origin_pin_repo="$fixture_root/origin-pin-candidate-repo"
origin_pin_real="$fixture_root/origin-pin-candidate-origin.git"
mkdir -p "$origin_pin_repo/instance"
printf 'repos:\n  git_remote: %s   # pinned origin\n' "$origin_pin_real" > "$origin_pin_repo/instance/params.yaml"
git -C "$origin_pin_repo" add instance/params.yaml
git -C "$origin_pin_repo" commit -m 'pin origin' >/dev/null
git -C "$origin_pin_repo" push origin main >/dev/null
git -C "$origin_pin_repo" checkout -b ag-origin-pin >/dev/null
printf 'repos:\n  git_remote: %s   # pinned origin\n' "$fixture_root/somewhere-else.git" > "$origin_pin_repo/instance/params.yaml"
git -C "$origin_pin_repo" add instance/params.yaml
git -C "$origin_pin_repo" commit -m 'repoint the pin' >/dev/null
origin_pin_sha=$(git -C "$origin_pin_repo" rev-parse HEAD)
git -C "$origin_pin_repo" checkout main >/dev/null
report "$fixture_root/origin-pin-report.md" "$origin_pin_sha"
origin_pin_candidate_output="$fixture_root/origin-pin-candidate-output.txt"
if "$land" --branch ag-origin-pin --item-id ag-origin-pin --report "$fixture_root/origin-pin-report.md" --repo "$origin_pin_repo" >"$origin_pin_candidate_output" 2>&1; then exit 1; fi
assert_output_has "$origin_pin_candidate_output" "LAND step=payload-guard status=fail detail=reserved-origin-pin base=$origin_pin_real candidate=$fixture_root/somewhere-else.git"
assert_output_lacks "$origin_pin_candidate_output" 'LAND step=merge status=pass'
# Introducing a pin where the merge-base has none is the same class of change:
# a lane that chooses the pin chooses what the next landing will call origin.
git -C "$origin_pin_repo" checkout -b ag-origin-pin-new main >/dev/null
git -C "$origin_pin_repo" rm -q instance/params.yaml >/dev/null
git -C "$origin_pin_repo" commit -m 'drop the pin' >/dev/null
git -C "$origin_pin_repo" checkout main >/dev/null
origin_pin_drop_sha=$(git -C "$origin_pin_repo" rev-parse ag-origin-pin-new)
report "$fixture_root/origin-pin-drop-report.md" "$origin_pin_drop_sha"
origin_pin_drop_output="$fixture_root/origin-pin-drop-output.txt"
if "$land" --branch ag-origin-pin-new --item-id ag-origin-pin-new --report "$fixture_root/origin-pin-drop-report.md" --repo "$origin_pin_repo" --no-push >"$origin_pin_drop_output" 2>&1; then exit 1; fi
assert_output_has "$origin_pin_drop_output" "LAND step=payload-guard status=fail detail=reserved-origin-pin base=$origin_pin_real candidate=none"
assert_output_lacks "$origin_pin_drop_output" 'LAND step=merge status=pass'
# Ordinary edits to the same file, leaving the pin alone, stay ordinary work.
git -C "$origin_pin_repo" checkout -b ag-origin-pin-ok main >/dev/null
printf 'repos:\n  git_remote: %s   # pinned origin\noperator:\n  language: uk\n' "$origin_pin_real" > "$origin_pin_repo/instance/params.yaml"
git -C "$origin_pin_repo" add instance/params.yaml
git -C "$origin_pin_repo" commit -m 'ordinary params edit' >/dev/null
origin_pin_ok_sha=$(git -C "$origin_pin_repo" rev-parse HEAD)
git -C "$origin_pin_repo" checkout main >/dev/null
report "$fixture_root/origin-pin-ok-report.md" "$origin_pin_ok_sha"
origin_pin_ok_output="$fixture_root/origin-pin-ok-output.txt"
"$land" --branch ag-origin-pin-ok --item-id ag-origin-pin-ok --report "$fixture_root/origin-pin-ok-report.md" --repo "$origin_pin_repo" --no-push >"$origin_pin_ok_output" 2>&1
assert_output_has "$origin_pin_ok_output" 'LAND verdict=landed sha='

# A lane branch is not an integration target however it was nominated. The
# --target-branch path already refused one; refs/remotes/origin/HEAD is a
# symbolic ref in the same shared common directory, so the detection path needs
# the same refusal or a lane can nominate its own branch by repointing it.
make_fixture origin-head-lane
origin_head_repo="$fixture_root/origin-head-lane-repo"
origin_head_sha=$(make_lane "$origin_head_repo" ag-origin-head-target)
git -C "$origin_head_repo" push -u origin ag-origin-head-target >/dev/null
git -C "$origin_head_repo" symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/ag-origin-head-target
report "$fixture_root/origin-head-report.md" "$origin_head_sha"
origin_head_output="$fixture_root/origin-head-output.txt"
if "$land" --branch ag-origin-head-target --item-id ag-origin-head-target --report "$fixture_root/origin-head-report.md" --repo "$origin_head_repo" --no-push >"$origin_head_output" 2>&1; then exit 1; fi
assert_output_has "$origin_head_output" 'LAND default-branch lane-branch-not-an-integration-target target=ag-origin-head-target'
assert_output_lacks "$origin_head_output" 'LAND step=merge status=pass'

# REGRESSION V3-0.29 r5 F4: a decision file that NAMES an item refused every
# landing of that item, including the branch that would delete the file -- and
# minting a fresh item id to repair it requires landing a change to the closed
# registry, which itself needs an id. The two likeliest operator typos
# (`park=cap`, a trailing space) hit exactly the item he was releasing. A
# candidate that deletes the file is now inert against it.
make_fixture unpark-bricked-item
unpark_bricked_repo="$fixture_root/unpark-bricked-item-repo"
mkdir -p "$unpark_bricked_repo/instance/decisions"
printf -- '---\nid: HR-6000\noperator-unpark: v2 item=ag-unpark-bricked decision=HR-6000 park=cap\n---\n' \
  > "$unpark_bricked_repo/instance/decisions/HR-6000.md"
git -C "$unpark_bricked_repo" add instance/decisions/HR-6000.md
git -C "$unpark_bricked_repo" commit -m 'operator typo: park=cap' >/dev/null
git -C "$unpark_bricked_repo" push origin main >/dev/null
unpark_bricked_sha=$(make_lane "$unpark_bricked_repo" ag-unpark-bricked)
report "$fixture_root/unpark-bricked-report.md" "$unpark_bricked_sha"
unpark_bricked_output="$fixture_root/unpark-bricked-output.txt"
if "$land" --branch ag-unpark-bricked --item-id ag-unpark-bricked --report "$fixture_root/unpark-bricked-report.md" --repo "$unpark_bricked_repo" --no-push >"$unpark_bricked_output" 2>&1; then exit 1; fi
assert_output_has "$unpark_bricked_output" 'malformed-authorization path=instance/decisions/HR-6000.md'
# The repair goes through the gate, under the SAME item id -- no borrowed id,
# no registry change, no push around the gate.
git -C "$unpark_bricked_repo" checkout ag-unpark-bricked >/dev/null
git -C "$unpark_bricked_repo" rm -q instance/decisions/HR-6000.md
git -C "$unpark_bricked_repo" commit -m 'delete the malformed decision' >/dev/null
unpark_bricked_repair_sha=$(git -C "$unpark_bricked_repo" rev-parse HEAD)
git -C "$unpark_bricked_repo" checkout main >/dev/null
report "$fixture_root/unpark-bricked-repair-report.md" "$unpark_bricked_repair_sha"
unpark_bricked_repair_output="$fixture_root/unpark-bricked-repair-output.txt"
"$land" --branch ag-unpark-bricked --item-id ag-unpark-bricked --report "$fixture_root/unpark-bricked-repair-report.md" --repo "$unpark_bricked_repo" --no-push >"$unpark_bricked_repair_output" 2>&1
assert_output_has "$unpark_bricked_repair_output" 'REVIEW_ROUNDS status=warn detail=decision-ignored-deleted-by-candidate path=instance/decisions/HR-6000.md'
assert_output_has "$unpark_bricked_repair_output" 'LAND verdict=landed sha='

make_fixture payload-symlink
git -C "$fixture_root/payload-symlink-repo" checkout -b ag-payload-symlink >/dev/null
ln -s /home/user/.env "$fixture_root/payload-symlink-repo/env.template"
git -C "$fixture_root/payload-symlink-repo" add env.template
git -C "$fixture_root/payload-symlink-repo" commit -m payload-symlink >/dev/null
payload_symlink_sha=$(git -C "$fixture_root/payload-symlink-repo" rev-parse HEAD)
git -C "$fixture_root/payload-symlink-repo" checkout main >/dev/null
report "$fixture_root/payload-symlink-report.md" "$payload_symlink_sha"
payload_symlink_output="$fixture_root/payload-symlink-output.txt"
if "$land" --branch ag-payload-symlink --item-id ag-payload-symlink --report "$fixture_root/payload-symlink-report.md" --repo "$fixture_root/payload-symlink-repo" >"$payload_symlink_output" 2>&1; then exit 1; fi
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
if "$land" --branch ag-payload-gitlink --item-id ag-payload-gitlink --report "$fixture_root/payload-gitlink-report.md" --repo "$fixture_root/payload-gitlink-repo" >"$payload_gitlink_output" 2>&1; then exit 1; fi
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
"$land" --branch ag-executable-shell --item-id ag-executable-shell --report "$fixture_root/executable-shell-report.md" --repo "$fixture_root/executable-shell-repo" --no-push >"$fixture_root/executable-shell-output.txt" 2>&1
assert_output_has "$fixture_root/executable-shell-output.txt" 'LAND step=payload-guard status=pass'

# A meteorite refusal is a post-merge abort boundary: both the target ref and
# its worktree must return to the exact pre-merge state.
make_fixture meteorite-refusal
mkdir -p "$fixture_root/meteorite-refusal-repo/meteorite" "$fixture_root/meteorite-fake-bin"
printf '#!/usr/bin/env bash\nexit 42\n' > "$fixture_root/meteorite-refusal-repo/meteorite/prove-candidate.sh"
chmod +x "$fixture_root/meteorite-refusal-repo/meteorite/prove-candidate.sh"
git -C "$fixture_root/meteorite-refusal-repo" add meteorite/prove-candidate.sh
git -C "$fixture_root/meteorite-refusal-repo" commit -m trusted-refusing-prover >/dev/null
git -C "$fixture_root/meteorite-refusal-repo" push origin main >/dev/null
meteorite_before=$(git -C "$fixture_root/meteorite-refusal-repo" rev-parse main)
meteorite_sha=$(make_lane "$fixture_root/meteorite-refusal-repo" ag-meteorite-refusal)
report "$fixture_root/meteorite-refusal-report.md" "$meteorite_sha"
printf '#!/usr/bin/env bash\ntest "$1" = info\n' > "$fixture_root/meteorite-fake-bin/docker"
chmod +x "$fixture_root/meteorite-fake-bin/docker"
meteorite_output="$fixture_root/meteorite-refusal-output.txt"
if PATH="$fixture_root/meteorite-fake-bin:$PATH" "$land" --branch ag-meteorite-refusal --item-id ag-meteorite-refusal \
    --report "$fixture_root/meteorite-refusal-report.md" --repo "$fixture_root/meteorite-refusal-repo" --no-push >"$meteorite_output" 2>&1; then
  sed -n '/LAND step=merge/,$p' "$meteorite_output" >&2
  echo 'meteorite refusal unexpectedly landed' >&2; exit 1
fi
assert_output_has "$meteorite_output" 'LAND step=meteorite status=fail'
assert_output_has "$meteorite_output" 'LAND verdict=aborted sha=none'
assert test "$(git -C "$fixture_root/meteorite-refusal-repo" rev-parse main)" = "$meteorite_before"
assert test "$(git -C "$fixture_root/meteorite-refusal-repo" rev-parse HEAD)" = "$meteorite_before"
assert test -z "$(git -C "$fixture_root/meteorite-refusal-repo" status --porcelain)"

echo "land tests: pass"
