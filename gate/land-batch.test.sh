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
  git -C "$repo" add base.txt
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

make_fixture disjoint
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

make_fixture secret
secret_sha=$(make_lane "$repo" ag-secret secret.txt "$(printf '%s%s' gh p_)$(printf 'x%.0s' $(seq 1 36))")
plain_sha=$(make_lane "$repo" ag-plain plain.txt plain)
report "$fixture_root/secret.md" "$secret_sha"; report "$fixture_root/plain.md" "$plain_sha"
secret_output="$fixture_root/secret.out"
if "$batch" --branches ag-secret,ag-plain --reports "$fixture_root/secret.md,$fixture_root/plain.md" --repo "$repo" --no-push >"$secret_output" 2>&1; then exit 1; fi
assert_output_has "$secret_output" 'BATCH step=secret-scan branch=ag-secret status=fail'
assert test "$(git -C "$repo" rev-parse main)" = "$(git -C "$repo" rev-parse origin/main)"

echo "land batch tests: pass"
