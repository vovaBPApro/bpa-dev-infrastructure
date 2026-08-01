#!/usr/bin/env bash
set -euo pipefail

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
batch="$root/gate/land-batch.sh"
fixture_root=$(mktemp -d)
trap 'rm -rf "$fixture_root"' EXIT

assert() { if ! "$@"; then echo "assertion failed: $*" >&2; exit 1; fi; }
assert_not() { if "$@"; then echo "unexpected success: $*" >&2; exit 1; fi; }
assert_no_integration_branch() {
  assert test -z "$(git -C "$repo" for-each-ref --format='%(refname)' refs/heads/batch-integration-)"
}

make_fixture() {
  local name="$1"
  bare="$fixture_root/$name-origin.git"
  repo="$fixture_root/$name-repo"
  git init --bare --initial-branch=main "$bare" >/dev/null
  git clone "file://$bare" "$repo" >/dev/null
  git -C "$repo" config user.email hardening@example.test
  git -C "$repo" config user.name Hardening
  printf 'base\n' >"$repo/base.txt"
  git -C "$repo" add base.txt
  git -C "$repo" commit -m base >/dev/null
  git -C "$repo" push -u origin main >/dev/null
  printf 'ref: refs/heads/main\n' >"$bare/HEAD"
}

make_lane() {
  local lane="$1" file="$2" value="$3"
  git -C "$repo" checkout -b "$lane" >/dev/null
  printf '%s\n' "$value" >"$repo/$file"
  git -C "$repo" add "$file"
  git -C "$repo" commit -m "$lane" >/dev/null
  git -C "$repo" checkout main >/dev/null
  git -C "$repo" rev-parse "$lane"
}

write_report() {
  printf 'commit: %s fixture\nverify: %s\nresult: clean\nsecret-scan: clean\nremaining: none\n' "$2" "$3" >"$1"
}

make_fixture later-verify
before=$(git -C "$repo" rev-parse main)
one=$(make_lane ag-one one.txt one)
two=$(make_lane ag-two two.txt two)
write_report "$fixture_root/one.md" "$one" true
write_report "$fixture_root/two.md" "$two" false
if "$batch" --branches ag-one,ag-two --reports "$fixture_root/one.md,$fixture_root/two.md" \
  --repo "$repo" --no-push --run-verify >/dev/null 2>&1; then
  echo "later-report-verify-fails: batch unexpectedly succeeded" >&2
  exit 1
fi
assert test "$(git -C "$repo" rev-parse main)" = "$before"
assert_no_integration_branch
assert git -C "$repo" show-ref --verify --quiet refs/heads/ag-one
assert git -C "$repo" show-ref --verify --quiet refs/heads/ag-two

make_fixture rewritten-test
before=$(git -C "$repo" rev-parse main)
git -C "$repo" checkout -b ag-wrapper >/dev/null
printf '{"scripts":{"test":"./test-wrapper.sh"}}\n' > "$repo/package.json"
printf '#!/bin/sh\ncp passing.txt real.test.ts\nexit 0\n' > "$repo/test-wrapper.sh"
printf 'import { test, expect } from "bun:test"; test("real", () => expect(true).toBe(false));\n' > "$repo/real.test.ts"
printf 'import { test, expect } from "bun:test"; test("real", () => expect(true).toBe(true));\n' > "$repo/passing.txt"
chmod +x "$repo/test-wrapper.sh"
git -C "$repo" add package.json test-wrapper.sh real.test.ts passing.txt
git -C "$repo" commit -m ag-wrapper >/dev/null
wrapper_sha=$(git -C "$repo" rev-parse HEAD)
git -C "$repo" checkout main >/dev/null
other_sha=$(make_lane ag-other other.txt other)
write_report "$fixture_root/wrapper.md" "$wrapper_sha" true
write_report "$fixture_root/other.md" "$other_sha" true
if "$batch" --branches ag-wrapper,ag-other --reports "$fixture_root/wrapper.md,$fixture_root/other.md" \
  --repo "$repo" --no-push >"$fixture_root/rewritten-test.out" 2>&1; then
  echo 'rewritten-test: batch accepted a wrapper that replaced a failing test' >&2
  exit 1
fi
assert grep -Fq 'BATCH framework-check=test status=fail' "$fixture_root/rewritten-test.out"
assert test "$(git -C "$repo" rev-parse main)" = "$before"
assert_no_integration_branch

make_fixture overlap
before=$(git -C "$repo" rev-parse main)
one=$(make_lane ag-one shared.txt same)
two=$(make_lane ag-two shared.txt same)
write_report "$fixture_root/one.md" "$one" true
write_report "$fixture_root/two.md" "$two" true
if "$batch" --branches ag-one,ag-two --reports "$fixture_root/one.md,$fixture_root/two.md" \
  --repo "$repo" --no-push >/dev/null 2>&1; then
  echo "overlapping-identical-add: batch unexpectedly succeeded" >&2
  exit 1
fi
assert test "$(git -C "$repo" rev-parse main)" = "$before"
assert_no_integration_branch
assert git -C "$repo" show-ref --verify --quiet refs/heads/ag-one
assert git -C "$repo" show-ref --verify --quiet refs/heads/ag-two

make_fixture interruption
before=$(git -C "$repo" rev-parse main)
one=$(make_lane ag-one one.txt one)
two=$(make_lane ag-two two.txt two)
write_report "$fixture_root/one.md" "$one" 'sleep 30'
write_report "$fixture_root/two.md" "$two" true
"$batch" --branches ag-one,ag-two --reports "$fixture_root/one.md,$fixture_root/two.md" \
  --repo "$repo" --no-push --run-verify >"$fixture_root/interruption.out" 2>&1 &
batch_pid=$!
for _ in $(seq 1 100); do
  case "$(git -C "$repo" branch --show-current)" in batch-integration-*) break ;; esac
  sleep 0.05
done
kill -TERM "$batch_pid"
wait "$batch_pid" 2>/dev/null || true
assert test "$(git -C "$repo" branch --show-current)" = main
assert test "$(git -C "$repo" rev-parse main)" = "$before"
assert_no_integration_branch
assert git -C "$repo" show-ref --verify --quiet refs/heads/ag-one
assert git -C "$repo" show-ref --verify --quiet refs/heads/ag-two
write_report "$fixture_root/one.md" "$one" true
"$batch" --branches ag-one,ag-two --reports "$fixture_root/one.md,$fixture_root/two.md" \
  --repo "$repo" --no-push --run-verify >/dev/null

echo "land batch hardening tests: pass"
