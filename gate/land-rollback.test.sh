#!/usr/bin/env bash
# V3-0.3 regression lock: an aborted landing must leave the target ref and
# working tree exactly as they were, for every abort path that follows a
# successful merge -- not only the happy-path case the existing land.test.sh
# "verify-fail" fixture covers (a self-contained verify command with no side
# effects, where a plain `git reset --hard ORIG_HEAD` always succeeds).
#
# Observed defect (2026-08-03, twice): gate/land.sh printed
# "LAND post-merge-verify failure: merge reset to ORIG_HEAD" and
# "LAND verdict=aborted", yet local main sat ADVANCED at the merge commit and
# the working tree was dirty. Root cause: `git reset --hard ORIG_HEAD` can
# fail (this repo's gate scripts run under `set -u`/`pipefail`, never
# `set -e`), and land.sh did not check the reset's exit status before
# declaring the rollback done. A coder-authored `verify:` command (trusted
# only to run, never to behave) that spawns a git process which is killed or
# still alive when the gate reads its exit status leaves a stale
# $GIT_DIR/index.lock behind; every subsequent `git reset --hard` in that
# checkout then fails the same way, silently, forever.
#
# These fixtures reproduce that exact mechanism deterministically instead of
# depending on background-process timing.
set -u
set -o pipefail

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
land="$root/gate/land.sh"
fixture_root=$(mktemp -d)
cleanup() {
  # Some fixtures below chattr +i a file to make a rollback genuinely
  # unrecoverable; clear that before the trap tries to rm -rf the fixture.
  find "$fixture_root" -name index.lock -exec chattr -i {} + 2>/dev/null || true
  rm -rf "$fixture_root"
}
trap cleanup EXIT

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
  assert grep -Fq "$2" "$1"
}

assert_output_lacks() {
  assert_not grep -Fq "$2" "$1"
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
  verify="$3"
  printf 'commit: %s fixture\nverify: %s\nresult: clean\nsecret-scan: clean\nremaining: none\n' "$sha" "$verify" > "$path"
}

# --- 1. Recoverable stale index.lock at post-merge-verify -----------------
# The verify command leaves a lock file behind (as an interrupted/backgrounded
# git child of a real verify command would) and then fails. Before the fix,
# the inline `git reset --hard ORIG_HEAD` failed on this lock, the failure was
# swallowed, and main stayed advanced. After the fix, land_force_reset clears
# the stale lock -- safe because land.sh holds its own exclusive flock on this
# repo for the whole run, so no concurrent land.sh instance could be the
# lock's legitimate owner -- retries, and verifies main lands back exactly
# where it started, with a clean tree.
make_fixture stale-lock
lane_sha=$(make_lane "$fixture_root/stale-lock-repo" ag-stale-lock)
before=$(git -C "$fixture_root/stale-lock-repo" rev-parse main)
report "$fixture_root/stale-lock-report.md" "$lane_sha" 'touch .git/index.lock; exit 1'
out="$fixture_root/stale-lock-out.txt"
if "$land" --branch ag-stale-lock --report "$fixture_root/stale-lock-report.md" --repo "$fixture_root/stale-lock-repo" --run-verify --no-push >"$out" 2>&1; then
  echo 'stale-lock: gate accepted a failing verify command' >&2
  exit 1
fi
assert_output_has "$out" 'LAND step=post-merge-verify status=fail'
assert_output_has "$out" 'LAND verdict=aborted sha=none'
assert test "$(git -C "$fixture_root/stale-lock-repo" rev-parse main)" = "$before"
assert test "$(git -C "$fixture_root/stale-lock-repo" rev-parse HEAD)" = "$before"
assert test -z "$(git -C "$fixture_root/stale-lock-repo" status --porcelain)"
assert git -C "$fixture_root/stale-lock-repo" show-ref --verify --quiet refs/heads/ag-stale-lock

# --- 2. Same mechanism, different abort path: post-merge declared-checks --
# "for every abort path, not only this one." The post-merge declared-checks
# step (package.json "test") leaves the same stale lock and then fails; the
# rollback must still land main back at its pre-merge commit.
make_fixture stale-lock-declared
git -C "$fixture_root/stale-lock-declared-repo" checkout -b ag-stale-lock-declared >/dev/null
printf '{"scripts":{"test":"touch .git/index.lock && false"}}\n' > "$fixture_root/stale-lock-declared-repo/package.json"
git -C "$fixture_root/stale-lock-declared-repo" add package.json
git -C "$fixture_root/stale-lock-declared-repo" commit -m declared-stale-lock >/dev/null
declared_sha=$(git -C "$fixture_root/stale-lock-declared-repo" rev-parse HEAD)
git -C "$fixture_root/stale-lock-declared-repo" checkout main >/dev/null
declared_before=$(git -C "$fixture_root/stale-lock-declared-repo" rev-parse main)
report "$fixture_root/stale-lock-declared-report.md" "$declared_sha" true
declared_out="$fixture_root/stale-lock-declared-out.txt"
if "$land" --branch ag-stale-lock-declared --report "$fixture_root/stale-lock-declared-report.md" --repo "$fixture_root/stale-lock-declared-repo" --no-push >"$declared_out" 2>&1; then
  echo 'stale-lock-declared: gate accepted a failing declared test script' >&2
  exit 1
fi
assert_output_has "$declared_out" 'LAND step=declared-checks status=fail'
assert_output_has "$declared_out" 'LAND verdict=aborted sha=none'
assert test "$(git -C "$fixture_root/stale-lock-declared-repo" rev-parse main)" = "$declared_before"
assert test -z "$(git -C "$fixture_root/stale-lock-declared-repo" status --porcelain)"

# --- 3. Genuinely unrecoverable lock: the gate must not lie ---------------
# chattr +i makes the lock file immutable -- even root cannot rm it -- so
# land_force_reset's clear-and-retry cannot succeed, ever. This is the case
# the fix must handle honestly: report contract says "aborted" means the ref
# did not move, so when the gate cannot prove that, it must say something
# else, never "verdict=aborted".
make_fixture unrecoverable-lock
unrecoverable_sha=$(make_lane "$fixture_root/unrecoverable-lock-repo" ag-unrecoverable-lock)
unrecoverable_before=$(git -C "$fixture_root/unrecoverable-lock-repo" rev-parse main)
report "$fixture_root/unrecoverable-lock-report.md" "$unrecoverable_sha" 'touch .git/index.lock; chattr +i .git/index.lock; exit 1'
unrecoverable_out="$fixture_root/unrecoverable-lock-out.txt"
if "$land" --branch ag-unrecoverable-lock --report "$fixture_root/unrecoverable-lock-report.md" --repo "$fixture_root/unrecoverable-lock-repo" --run-verify --no-push >"$unrecoverable_out" 2>&1; then
  echo 'unrecoverable-lock: gate reported success despite an unrecoverable rollback' >&2
  exit 1
fi
assert_output_has "$unrecoverable_out" 'LAND verdict=rollback-failed'
assert_output_lacks "$unrecoverable_out" 'LAND verdict=aborted'
chattr -i "$fixture_root/unrecoverable-lock-repo/.git/index.lock" 2>/dev/null || true

echo 'land rollback tests: pass'
