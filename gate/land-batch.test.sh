#!/usr/bin/env bash
set -euo pipefail

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
batch="$root/gate/land-batch.sh"
fixture_root=$(mktemp -d)
trap 'rm -rf "$fixture_root"' EXIT

assert() { if ! "$@"; then echo "assertion failed: $*" >&2; exit 1; fi; }
assert_not() { if "$@"; then echo "unexpected success: $*" >&2; exit 1; fi; }
assert_output_has() { assert grep -Fq "$2" "$1"; }

make_fixture() {
  local name="$1"
  bare="$fixture_root/$name-origin.git"
  repo="$fixture_root/$name-repo"
  git init --bare --initial-branch=main "$bare" >/dev/null
  git clone "file://$bare" "$repo" >/dev/null
  git -C "$repo" config user.email batch@example.test
  git -C "$repo" config user.name Batch
  printf 'base\n' > "$repo/base.txt"
  printf 'import { test, expect } from "bun:test"; test("fixture", () => expect(true).toBe(true));\n' > "$repo/base.test.ts"
  git -C "$repo" add base.txt base.test.ts
  git -C "$repo" commit -m base >/dev/null
  git -C "$repo" push -u origin main >/dev/null
  printf 'ref: refs/heads/main\n' > "$bare/HEAD"
}

make_lane() {
  local target_repo="$1" lane="$2" file="$3" value="$4"
  git -C "$target_repo" checkout -b "$lane" >/dev/null
  mkdir -p "$(dirname "$target_repo/$file")"
  printf '%s\n' "$value" > "$target_repo/$file"
  git -C "$target_repo" add "$file"
  git -C "$target_repo" commit -m "$lane" >/dev/null
  git -C "$target_repo" checkout main >/dev/null
  git -C "$target_repo" rev-parse "$lane"
}

report() { printf 'commit: %s fixture\nverify: true\nresult: clean\nsecret-scan: clean\nremaining: none\n' "$2" > "$1"; }

make_fixture zero-tests
zero_before=$(git -C "$repo" rev-parse main)
git -C "$repo" checkout -b ag-zero-tests >/dev/null
printf 'import { test } from "bun:test"; void test;\n' > "$repo/base.test.ts"
git -C "$repo" add base.test.ts
git -C "$repo" commit -m zero-tests >/dev/null
zero_sha=$(git -C "$repo" rev-parse HEAD)
git -C "$repo" checkout main >/dev/null
zero_peer_sha=$(make_lane "$repo" ag-zero-peer peer.txt peer)
report "$fixture_root/zero-tests.md" "$zero_sha"
report "$fixture_root/zero-peer.md" "$zero_peer_sha"
if "$batch" --branches ag-zero-tests,ag-zero-peer --reports "$fixture_root/zero-tests.md,$fixture_root/zero-peer.md" --repo "$repo" --no-push >"$fixture_root/zero-tests-batch.out" 2>&1; then
  echo 'zero-tests: batch gate accepted an empty suite' >&2
  exit 1
fi
assert_output_has "$fixture_root/zero-tests-batch.out" 'BATCH framework-check=test status=fail tests=0 detail=no-tests-collected'
assert test "$(git -C "$repo" rev-parse main)" = "$zero_before"

make_fixture skipped-tests
skipped_before=$(git -C "$repo" rev-parse main)
git -C "$repo" checkout -b ag-skipped-tests >/dev/null
printf 'import { test } from "bun:test"; test.skip("never runs", () => { throw new Error("must fail"); });\n' > "$repo/base.test.ts"
git -C "$repo" add base.test.ts
git -C "$repo" commit -m skipped-tests >/dev/null
skipped_sha=$(git -C "$repo" rev-parse HEAD)
git -C "$repo" checkout main >/dev/null
skipped_peer_sha=$(make_lane "$repo" ag-skipped-peer peer.txt peer)
report "$fixture_root/skipped-tests.md" "$skipped_sha"
report "$fixture_root/skipped-peer.md" "$skipped_peer_sha"
if "$batch" --branches ag-skipped-tests,ag-skipped-peer --reports "$fixture_root/skipped-tests.md,$fixture_root/skipped-peer.md" --repo "$repo" --no-push >"$fixture_root/skipped-tests-batch.out" 2>&1; then
  echo 'skipped-tests: batch gate accepted a suite with no passing tests' >&2
  exit 1
fi
assert_output_has "$fixture_root/skipped-tests-batch.out" 'BATCH framework-check=test status=fail tests=1 passed=0 detail=no-tests-passed'
assert test "$(git -C "$repo" rev-parse main)" = "$skipped_before"

make_fixture disjoint
bare_skip_before=$(git -C "$repo" rev-parse main)
bare_skip_remote_before=$(git --git-dir="$bare" rev-parse main)
bare_skip_output="$fixture_root/bare-skip-review.out"
if "$batch" --branches ag-one,ag-two --reports "$fixture_root/one.md,$fixture_root/two.md" --repo "$repo" --skip-review >"$bare_skip_output" 2>&1; then exit 1; fi
assert_output_has "$bare_skip_output" 'usage: gate/land-batch.sh'
assert test "$(git -C "$repo" rev-parse main)" = "$bare_skip_before"
assert test "$(git --git-dir="$bare" rev-parse main)" = "$bare_skip_remote_before"
assert test -z "$(git -C "$repo" status --porcelain)"
batch_whitespace_output="$fixture_root/whitespace-skip-review.out"
if "$batch" --branches ag-one,ag-two --reports "$fixture_root/one.md,$fixture_root/two.md" --repo "$repo" --skip-review '   ' >"$batch_whitespace_output" 2>&1; then exit 1; fi
assert_output_has "$batch_whitespace_output" 'usage: gate/land-batch.sh'
one_sha=$(make_lane "$repo" ag-one one.txt one)
two_sha=$(make_lane "$repo" ag-two two.txt two)
three_sha=$(make_lane "$repo" ag-three three.txt three)
printf 'commit: %s fixture\nverify: test ! -e .git/batch-verify-count && touch .git/batch-verify-count\nresult: clean\nsecret-scan: clean\nremaining: none\n' "$one_sha" > "$fixture_root/one.md"
report "$fixture_root/two.md" "$two_sha"; report "$fixture_root/three.md" "$three_sha"
disjoint_output="$fixture_root/disjoint.out"
"$batch" --branches ag-one,ag-two,ag-three --reports "$fixture_root/one.md,$fixture_root/two.md,$fixture_root/three.md" --repo "$repo" --run-verify >"$disjoint_output" 2>&1
assert_output_has "$disjoint_output" 'BATCH verdict=landed sha='
assert_output_has "$disjoint_output" 'branches=3'
assert test -e "$repo/.git/batch-verify-count"
assert git -C "$repo" merge-base --is-ancestor "$one_sha" main
assert git -C "$repo" merge-base --is-ancestor "$two_sha" main
assert git -C "$repo" merge-base --is-ancestor "$three_sha" main
assert test "$(git -C "$repo" rev-list --parents -n 1 main | wc -w)" -eq 3
assert_not git -C "$repo" show-ref --verify --quiet refs/heads/ag-one
assert_not git -C "$repo" show-ref --verify --quiet refs/heads/ag-two
assert_not git -C "$repo" show-ref --verify --quiet refs/heads/ag-three
assert_not git -C "$repo" show-ref --verify --quiet refs/heads/batch-integration-$$
assert test "$(git --git-dir="$bare" rev-parse main)" = "$(git -C "$repo" rev-parse main)"

make_fixture declared-check-fail
declared_batch_before=$(git -C "$repo" rev-parse main)
declared_one_sha=$(make_lane "$repo" ag-declared-one package.json '{"scripts":{"lint":"echo batch-declared-lint-ran && false","test":"echo batch-declared-test-ran"}}')
declared_two_sha=$(make_lane "$repo" ag-declared-two declared-two.txt two)
report "$fixture_root/declared-one.md" "$declared_one_sha"
report "$fixture_root/declared-two.md" "$declared_two_sha"
declared_batch_output="$fixture_root/declared-batch.out"
if "$batch" --branches ag-declared-one,ag-declared-two --reports "$fixture_root/declared-one.md,$fixture_root/declared-two.md" --repo "$repo" --no-push >"$declared_batch_output" 2>&1; then exit 1; fi
assert_output_has "$declared_batch_output" 'BATCH declared-check=lint status=running'
assert_output_has "$declared_batch_output" 'batch-declared-lint-ran'
assert_output_has "$declared_batch_output" 'BATCH step=declared-checks status=fail'
assert test "$(git -C "$repo" rev-parse main)" = "$declared_batch_before"

for failure_kind in failing-test syntax-error; do
  make_fixture "declared-$failure_kind"
  failure_before=$(git -C "$repo" rev-parse main)
  if [ "$failure_kind" = failing-test ]; then
    failure_value='{"scripts":{"test":"false"}}'
  else
    failure_value="{\"scripts\":{\"lint\":\"touch $fixture_root/parse-order-batch-ran\",\"test\":\"bun test\"}}"
  fi
  failure_sha=$(make_lane "$repo" "ag-$failure_kind" package.json "$failure_value")
  if [ "$failure_kind" = syntax-error ]; then
    git -C "$repo" checkout "ag-$failure_kind" >/dev/null
    printf 'this is not valid TypeScript !!!\n' > "$repo/broken.test.ts"
    git -C "$repo" add broken.test.ts
    git -C "$repo" commit -m syntax-error >/dev/null
    failure_sha=$(git -C "$repo" rev-parse HEAD)
    git -C "$repo" checkout main >/dev/null
  fi
  peer_sha=$(make_lane "$repo" "ag-$failure_kind-peer" "$failure_kind-peer.txt" peer)
  report "$fixture_root/$failure_kind.md" "$failure_sha"
  report "$fixture_root/$failure_kind-peer.md" "$peer_sha"
  if "$batch" --branches "ag-$failure_kind,ag-$failure_kind-peer" --reports "$fixture_root/$failure_kind.md,$fixture_root/$failure_kind-peer.md" --repo "$repo" --no-push >"$fixture_root/$failure_kind-batch.out" 2>&1; then exit 1; fi
  if [ "$failure_kind" = syntax-error ]; then
    assert_output_has "$fixture_root/$failure_kind-batch.out" 'BATCH declared-check=parse status=fail'
    assert test ! -e "$fixture_root/parse-order-batch-ran"
  else
    assert_output_has "$fixture_root/$failure_kind-batch.out" 'BATCH declared-check=test status=fail'
  fi
  assert_not git -C "$repo" merge-base --is-ancestor "$failure_sha" main
done

make_fixture shadowed-node
shadow_before=$(git -C "$repo" rev-parse main)
shadow_sha=$(make_lane "$repo" ag-shadowed-node package.json '{"scripts":{"test":"node -e '\''process.exit(1)'\''"}}')
shadow_peer_sha=$(make_lane "$repo" ag-shadowed-node-peer peer.txt peer)
report "$fixture_root/shadowed-node.md" "$shadow_sha"
report "$fixture_root/shadowed-node-peer.md" "$shadow_peer_sha"
mkdir "$fixture_root/shadow-bin"
printf '#!/bin/sh\ntouch %s\nexit 0\n' "$fixture_root/shadow-ran" > "$fixture_root/shadow-bin/node"
chmod +x "$fixture_root/shadow-bin/node"
if PATH="$fixture_root/shadow-bin:$PATH" "$batch" --branches ag-shadowed-node,ag-shadowed-node-peer --reports "$fixture_root/shadowed-node.md,$fixture_root/shadowed-node-peer.md" --repo "$repo" --no-push >"$fixture_root/shadowed-node-batch.out" 2>&1; then exit 1; fi
assert test ! -e "$fixture_root/shadow-ran"
assert test "$(git -C "$repo" rev-parse main)" = "$shadow_before"

make_fixture conflict
conflict_before=$(git -C "$repo" rev-parse main)
first_sha=$(make_lane "$repo" ag-first base.txt first)
second_sha=$(make_lane "$repo" ag-second base.txt second)
report "$fixture_root/first.md" "$first_sha"; report "$fixture_root/second.md" "$second_sha"
conflict_output="$fixture_root/conflict.out"
if "$batch" --branches ag-first,ag-second --reports "$fixture_root/first.md,$fixture_root/second.md" --repo "$repo" --no-push >"$conflict_output" 2>&1; then exit 1; fi
assert_output_has "$conflict_output" 'BATCH verdict=conflict pair=ag-second'
assert test "$(git -C "$repo" rev-parse main)" = "$conflict_before"
assert test -z "$(git -C "$repo" status --porcelain)"
assert_not git -C "$repo" rev-parse --verify --quiet MERGE_HEAD
assert git -C "$repo" show-ref --verify --quiet refs/heads/ag-first
assert git -C "$repo" show-ref --verify --quiet refs/heads/ag-second

make_fixture bad-report
bad_before=$(git -C "$repo" rev-parse main)
good_sha=$(make_lane "$repo" ag-good good.txt good)
make_lane "$repo" ag-bad bad.txt bad >/dev/null
report "$fixture_root/good.md" "$good_sha"
report "$fixture_root/bad.md" aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
bad_output="$fixture_root/bad.out"
if "$batch" --branches ag-good,ag-bad --reports "$fixture_root/good.md,$fixture_root/bad.md" --repo "$repo" --no-push >"$bad_output" 2>&1; then exit 1; fi
assert test "$(git -C "$repo" rev-parse main)" = "$bad_before"
assert git -C "$repo" show-ref --verify --quiet refs/heads/ag-good
assert git -C "$repo" show-ref --verify --quiet refs/heads/ag-bad

make_fixture risky
risk_sha=$(make_lane "$repo" ag-risk gate/changed.txt risky)
safe_sha=$(make_lane "$repo" ag-safe safe.txt safe)
report "$fixture_root/risk.md" "$risk_sha"; report "$fixture_root/safe.md" "$safe_sha"
risk_output="$fixture_root/risk.out"
if "$batch" --branches ag-risk,ag-safe --reports "$fixture_root/risk.md,$fixture_root/safe.md" --repo "$repo" --no-push >"$risk_output" 2>&1; then exit 1; fi
assert_output_has "$risk_output" 'ERROR review-required missing-artifact'
assert test "$(git -C "$repo" rev-parse main)" = "$(git -C "$repo" rev-parse origin/main)"

make_fixture skip-review
skip_first_sha=$(make_lane "$repo" ag-skip-first gate/first.txt first)
skip_second_sha=$(make_lane "$repo" ag-skip-second instructions/second.md second)
report "$fixture_root/skip-first.md" "$skip_first_sha"; report "$fixture_root/skip-second.md" "$skip_second_sha"
skip_reason='fake urgent maintenance'
skip_output="$fixture_root/skip-review.out"
"$batch" --branches ag-skip-first,ag-skip-second --reports "$fixture_root/skip-first.md,$fixture_root/skip-second.md" --repo "$repo" --no-push --skip-review "$skip_reason" >"$skip_output" 2>&1
skip_audit="$repo/orchestrator/runtime/review-skips.log"
assert_output_has "$skip_output" "BATCH review=SKIPPED reason=$skip_reason"
assert_output_has "$skip_output" 'BATCH step=review branch=ag-skip-first status=pass'
assert_output_has "$skip_output" 'BATCH step=review branch=ag-skip-second status=pass'
assert_output_has "$skip_output" 'review=ag-skip-first:skipped,ag-skip-second:not-required'
assert grep -Eq "^[-0-9TZ:]+"$'\t'"branch=ag-skip-first"$'\t'"sha=$skip_first_sha"$'\t'"reason=$skip_reason$" "$skip_audit"
assert grep -Eq "^[-0-9TZ:]+"$'\t'"branch=ag-skip-second"$'\t'"sha=$skip_second_sha"$'\t'"reason=$skip_reason$" "$skip_audit"
assert test "$(grep -Fc "reason=$skip_reason" "$skip_audit")" -eq 2

make_fixture secret
secret_sha=$(make_lane "$repo" ag-secret secret.txt "$(printf '%s%s' gh p_)$(printf 'x%.0s' $(seq 1 36))")
plain_sha=$(make_lane "$repo" ag-plain plain.txt plain)
report "$fixture_root/secret.md" "$secret_sha"; report "$fixture_root/plain.md" "$plain_sha"
secret_output="$fixture_root/secret.out"
if "$batch" --branches ag-secret,ag-plain --reports "$fixture_root/secret.md,$fixture_root/plain.md" --repo "$repo" --no-push >"$secret_output" 2>&1; then exit 1; fi
assert_output_has "$secret_output" 'BATCH step=secret-scan branch=ag-secret status=fail'
assert test "$(git -C "$repo" rev-parse main)" = "$(git -C "$repo" rev-parse origin/main)"

make_fixture stale
stale_one_sha=$(make_lane "$repo" ag-stale-one one.txt one)
stale_two_sha=$(make_lane "$repo" ag-stale-two two.txt two)
report "$fixture_root/stale-one.md" "$stale_one_sha"; report "$fixture_root/stale-two.md" "$stale_two_sha"
git clone "file://$bare" "$fixture_root/stale-peer" >/dev/null
git -C "$fixture_root/stale-peer" config user.email peer@example.test
git -C "$fixture_root/stale-peer" config user.name Peer
printf 'remote advance\n' > "$fixture_root/stale-peer/remote.txt"
git -C "$fixture_root/stale-peer" add remote.txt
git -C "$fixture_root/stale-peer" commit -m remote-advance >/dev/null
git -C "$fixture_root/stale-peer" push origin main >/dev/null
stale_output="$fixture_root/stale.out"
if "$batch" --branches ag-stale-one,ag-stale-two --reports "$fixture_root/stale-one.md,$fixture_root/stale-two.md" --repo "$repo" >"$stale_output" 2>&1; then exit 1; fi
assert_output_has "$stale_output" 'BATCH step=freshness status=fail'
assert test "$(git -C "$repo" rev-parse main)" != "$(git -C "$repo" rev-parse origin/main)"

make_fixture payload
git -C "$repo" checkout -b ag-payload >/dev/null
ln -s /home/user/.env "$repo/env.template"
git -C "$repo" add env.template
git -C "$repo" commit -m payload-symlink >/dev/null
payload_sha=$(git -C "$repo" rev-parse HEAD)
git -C "$repo" checkout main >/dev/null
plain_payload_sha=$(make_lane "$repo" ag-payload-plain plain.txt plain)
report "$fixture_root/payload.md" "$payload_sha"; report "$fixture_root/payload-plain.md" "$plain_payload_sha"
payload_output="$fixture_root/payload.out"
if "$batch" --branches ag-payload,ag-payload-plain --reports "$fixture_root/payload.md,$fixture_root/payload-plain.md" --repo "$repo" --no-push >"$payload_output" 2>&1; then exit 1; fi
assert_output_has "$payload_output" 'LAND step=payload-guard status=fail detail=mode-120000'
assert test "$(git -C "$repo" rev-parse main)" = "$(git -C "$repo" rev-parse origin/main)"

# Reap pass requires origin refs to be gone: a lane pushed to origin is
# deleted there and confirmed absent; a local-only lane passes explicitly.
make_fixture remote-reap
remote_one_sha=$(make_lane "$repo" ag-remote-one remote-one.txt one)
remote_two_sha=$(make_lane "$repo" ag-remote-two remote-two.txt two)
git -C "$repo" push origin ag-remote-one >/dev/null 2>&1
report "$fixture_root/remote-one.md" "$remote_one_sha"; report "$fixture_root/remote-two.md" "$remote_two_sha"
remote_reap_output="$fixture_root/remote-reap.out"
"$batch" --branches ag-remote-one,ag-remote-two --reports "$fixture_root/remote-one.md,$fixture_root/remote-two.md" --repo "$repo" >"$remote_reap_output" 2>&1
assert_output_has "$remote_reap_output" 'BATCH reap remote=deleted branch=ag-remote-one'
assert_output_has "$remote_reap_output" 'BATCH reap remote=absent branch=ag-remote-two detail=never-on-origin-nothing-to-delete'
assert_output_has "$remote_reap_output" 'BATCH step=reap status=pass'
assert_output_has "$remote_reap_output" 'BATCH verdict=landed sha='
assert_not git --git-dir="$bare" show-ref --verify --quiet refs/heads/ag-remote-one

# False-green direction: origin refuses branch deletion, so the lane is still
# on origin after landing. Reap must report local-only, never pass.
make_fixture remote-blocked
blocked_one_sha=$(make_lane "$repo" ag-blocked-one blocked-one.txt one)
blocked_two_sha=$(make_lane "$repo" ag-blocked-two blocked-two.txt two)
git -C "$repo" push origin ag-blocked-one >/dev/null 2>&1
report "$fixture_root/blocked-one.md" "$blocked_one_sha"; report "$fixture_root/blocked-two.md" "$blocked_two_sha"
printf '#!/usr/bin/env bash\nzero=0000000000000000000000000000000000000000\nwhile read -r _old new _ref; do\n  if [ "$new" = "$zero" ]; then exit 1; fi\ndone\nexit 0\n' > "$bare/hooks/pre-receive"
chmod +x "$bare/hooks/pre-receive"
remote_blocked_output="$fixture_root/remote-blocked.out"
if "$batch" --branches ag-blocked-one,ag-blocked-two --reports "$fixture_root/blocked-one.md,$fixture_root/blocked-two.md" --repo "$repo" >"$remote_blocked_output" 2>&1; then exit 1; fi
assert_output_has "$remote_blocked_output" 'BATCH reap remote=present branch=ag-blocked-one detail=push-delete-failed'
assert_output_has "$remote_blocked_output" 'BATCH step=reap status=local-only'
assert_output_has "$remote_blocked_output" 'BATCH verdict=landed-reap-failed sha='
assert_not grep -Fq 'BATCH step=reap status=pass' "$remote_blocked_output"
assert_not grep -Fq 'BATCH verdict=landed sha=' "$remote_blocked_output"
assert git --git-dir="$bare" show-ref --verify --quiet refs/heads/ag-blocked-one

make_fixture push-rollback
rollback_one_sha=$(make_lane "$repo" ag-rollback-one one.txt one)
rollback_two_sha=$(make_lane "$repo" ag-rollback-two two.txt two)
report "$fixture_root/rollback-one.md" "$rollback_one_sha"; report "$fixture_root/rollback-two.md" "$rollback_two_sha"
printf '#!/usr/bin/env bash\nexit 1\n' > "$bare/hooks/pre-receive"
chmod +x "$bare/hooks/pre-receive"
rollback_output="$fixture_root/rollback.out"
if "$batch" --branches ag-rollback-one,ag-rollback-two --reports "$fixture_root/rollback-one.md,$fixture_root/rollback-two.md" --repo "$repo" >"$rollback_output" 2>&1; then exit 1; fi
assert_output_has "$rollback_output" 'BATCH step=push status=fail'
assert_output_has "$rollback_output" 'main reset to origin/main'
assert test "$(git -C "$repo" rev-parse main)" = "$(git -C "$repo" rev-parse origin/main)"
assert git -C "$repo" show-ref --verify --quiet refs/heads/ag-rollback-one
assert git -C "$repo" show-ref --verify --quiet refs/heads/ag-rollback-two

echo "land batch tests: pass"
