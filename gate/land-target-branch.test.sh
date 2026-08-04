#!/usr/bin/env bash
# Locks gate/land.sh's --target-branch behavior:
#  - a non-default target branch can be landed onto, leaving the true default
#    branch (main) untouched;
#  - omitting the flag is byte-for-byte identical to today's default-branch
#    behavior;
#  - each validation rejection fails closed with a LAND record and the same
#    exit code the existing land_fail(step, 2) call site produces;
#  - the flag cannot be used to bypass the freshness guard: a stale target
#    still fails even though main is fresh.
set -u
set -o pipefail

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
land="$root/gate/land.sh"
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

# Fixture: a bare origin with main plus a second long-lived branch (v3),
# both pushed, so --target-branch v3 has a real origin/v3 counterpart.
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
  cp "$root/hygiene/check-workboard-integrity.ts" "$repo/hygiene/check-workboard-integrity.ts"
  printf 'main\n' > "$repo/instance/hygiene-protected-branches.txt"
  printf '| row | active |\n' > "$repo/instance/workboard.md"
  mkdir -p "$repo/meteorite"
  sed -n '/^# BEGIN TRUSTED TEST PROVER$/,/^# END TRUSTED TEST PROVER$/p' "$root/gate/land.test.sh" | sed '1d;$d' > "$repo/meteorite/prove-candidate.sh"
  chmod +x "$repo/meteorite/prove-candidate.sh"
  git -C "$repo" add base.txt base.test.ts hygiene/check-retained-branches.ts hygiene/check-workboard-integrity.ts instance meteorite/prove-candidate.sh
  git -C "$repo" commit -m base >/dev/null
  git -C "$repo" push -u origin main >/dev/null
  printf 'ref: refs/heads/main\n' > "$bare/HEAD"
  git -C "$repo" checkout -b v3 >/dev/null
  printf 'v3-base\n' > "$repo/v3.txt"
  git -C "$repo" add v3.txt
  git -C "$repo" commit -m v3-base >/dev/null
  git -C "$repo" push -u origin v3 >/dev/null
}

make_lane() {
  repo="$1"
  lane="$2"
  base="$3"
  git -C "$repo" checkout -b "$lane" "$base" >/dev/null
  printf 'lane\n' > "$repo/lane.txt"
  git -C "$repo" add lane.txt
  git -C "$repo" commit -m lane >/dev/null
  sha=$(git -C "$repo" rev-parse HEAD)
  git -C "$repo" checkout "$base" >/dev/null
  printf '%s\n' "$sha"
}

report() {
  path="$1"
  sha="$2"
  printf 'commit: %s fixture\nverify: true\nresult: clean\nsecret-scan: clean\nremaining: none\n' "$sha" > "$path"
}

# --- 1. Landing onto a non-default target succeeds; main is untouched. -----
make_fixture target-good
target_good_sha=$(make_lane "$fixture_root/target-good-repo" ag-target-good v3)
main_before=$(git -C "$fixture_root/target-good-repo" rev-parse main)
git -C "$fixture_root/target-good-repo" checkout v3 >/dev/null
report "$fixture_root/target-good-report.md" "$target_good_sha"
target_good_output="$fixture_root/target-good-output.txt"
"$land" --branch ag-target-good --item-id ag-target-good --report "$fixture_root/target-good-report.md" --repo "$fixture_root/target-good-repo" --target-branch v3 --no-push >"$target_good_output" 2>&1
target_good_status=$?
assert test "$target_good_status" -eq 0
assert_output_has "$target_good_output" 'LAND verdict=landed sha='
assert git -C "$fixture_root/target-good-repo" merge-base --is-ancestor "$target_good_sha" v3
assert test "$(git -C "$fixture_root/target-good-repo" rev-parse main)" = "$main_before"
assert test "$(git -C "$fixture_root/target-good-repo" branch --show-current)" = v3
assert_not git -C "$fixture_root/target-good-repo" show-ref --verify --quiet refs/heads/ag-target-good

# --- 2. Omitting the flag preserves today's default-branch behavior. -------
# This reproduces the original defect verbatim: checked out on v3, landing a
# v3 lane without --target-branch must still hard-fail because the derived
# default (main) is what the equality check compares against, exactly as
# before this change -- the new flag changes nothing unless it is passed.
make_fixture omitted-flag
omitted_sha=$(make_lane "$fixture_root/omitted-flag-repo" ag-omitted-flag v3)
git -C "$fixture_root/omitted-flag-repo" checkout v3 >/dev/null
main_before=$(git -C "$fixture_root/omitted-flag-repo" rev-parse main)
report "$fixture_root/omitted-flag-report.md" "$omitted_sha"
omitted_output="$fixture_root/omitted-flag-output.txt"
"$land" --branch ag-omitted-flag --item-id ag-omitted-flag --report "$fixture_root/omitted-flag-report.md" --repo "$fixture_root/omitted-flag-repo" --no-push >"$omitted_output" 2>&1
omitted_status=$?
assert test "$omitted_status" -eq 2
assert_output_has "$omitted_output" 'LAND default-branch expected=main current=v3'
assert test "$(git -C "$fixture_root/omitted-flag-repo" rev-parse main)" = "$main_before"

# Also lock the true default-only path end to end: a normal main-targeted
# landing (no flag at all) still lands cleanly, unaffected by the new code.
make_fixture omitted-flag-main
omitted_main_sha=$(make_lane "$fixture_root/omitted-flag-main-repo" ag-omitted-flag-main main)
report "$fixture_root/omitted-flag-main-report.md" "$omitted_main_sha"
omitted_main_output="$fixture_root/omitted-flag-main-output.txt"
"$land" --branch ag-omitted-flag-main --item-id ag-omitted-flag-main --report "$fixture_root/omitted-flag-main-report.md" --repo "$fixture_root/omitted-flag-main-repo" --no-push >"$omitted_main_output" 2>&1
omitted_main_status=$?
assert test "$omitted_main_status" -eq 0
assert_output_has "$omitted_main_output" 'LAND verdict=landed sha='
assert git -C "$fixture_root/omitted-flag-main-repo" merge-base --is-ancestor "$omitted_main_sha" main

# --- 3. Validation rejections fail closed with a clear LAND record. --------

# 3a. --target-branch equal to the candidate branch.
make_fixture target-same-as-branch
same_sha=$(make_lane "$fixture_root/target-same-as-branch-repo" ag-target-same-as-branch v3)
main_before=$(git -C "$fixture_root/target-same-as-branch-repo" rev-parse main)
git -C "$fixture_root/target-same-as-branch-repo" checkout v3 >/dev/null
report "$fixture_root/target-same-as-branch-report.md" "$same_sha"
same_output="$fixture_root/target-same-as-branch-output.txt"
"$land" --branch ag-target-same-as-branch --item-id ag-target-same-as-branch --report "$fixture_root/target-same-as-branch-report.md" --repo "$fixture_root/target-same-as-branch-repo" --target-branch ag-target-same-as-branch --no-push >"$same_output" 2>&1
same_status=$?
assert test "$same_status" -eq 2
assert_output_has "$same_output" 'LAND target-branch same-as-candidate target=ag-target-same-as-branch branch=ag-target-same-as-branch'
assert_output_has "$same_output" 'LAND step=target-branch status=fail'
assert test "$(git -C "$fixture_root/target-same-as-branch-repo" rev-parse main)" = "$main_before"

# 3b. --target-branch with no local ref at all.
make_fixture target-missing-local
missing_local_sha=$(make_lane "$fixture_root/target-missing-local-repo" ag-target-missing-local main)
main_before=$(git -C "$fixture_root/target-missing-local-repo" rev-parse main)
report "$fixture_root/target-missing-local-report.md" "$missing_local_sha"
missing_local_output="$fixture_root/target-missing-local-output.txt"
"$land" --branch ag-target-missing-local --item-id ag-target-missing-local --report "$fixture_root/target-missing-local-report.md" --repo "$fixture_root/target-missing-local-repo" --target-branch does-not-exist-anywhere --no-push >"$missing_local_output" 2>&1
missing_local_status=$?
assert test "$missing_local_status" -eq 2
assert_output_has "$missing_local_output" 'LAND target-branch missing-local target=does-not-exist-anywhere'
assert_output_has "$missing_local_output" 'LAND step=target-branch status=fail'
assert test "$(git -C "$fixture_root/target-missing-local-repo" rev-parse main)" = "$main_before"

# 3c. --target-branch exists locally but has no origin/<name> counterpart.
make_fixture target-missing-origin
missing_origin_sha=$(make_lane "$fixture_root/target-missing-origin-repo" ag-target-missing-origin main)
git -C "$fixture_root/target-missing-origin-repo" branch local-only-branch main >/dev/null
main_before=$(git -C "$fixture_root/target-missing-origin-repo" rev-parse main)
report "$fixture_root/target-missing-origin-report.md" "$missing_origin_sha"
missing_origin_output="$fixture_root/target-missing-origin-output.txt"
"$land" --branch ag-target-missing-origin --item-id ag-target-missing-origin --report "$fixture_root/target-missing-origin-report.md" --repo "$fixture_root/target-missing-origin-repo" --target-branch local-only-branch --no-push >"$missing_origin_output" 2>&1
missing_origin_status=$?
assert test "$missing_origin_status" -eq 2
assert_output_has "$missing_origin_output" 'LAND target-branch missing-origin target=local-only-branch'
assert_output_has "$missing_origin_output" 'LAND step=target-branch status=fail'
assert test "$(git -C "$fixture_root/target-missing-origin-repo" rev-parse main)" = "$main_before"

# 3d. --target-branch given but the caller stayed checked out on main instead
# of the target: the equality check (retargeted at v3) must still fire.
make_fixture target-wrong-checkout
wrong_checkout_sha=$(make_lane "$fixture_root/target-wrong-checkout-repo" ag-target-wrong-checkout v3)
git -C "$fixture_root/target-wrong-checkout-repo" checkout main >/dev/null
main_before=$(git -C "$fixture_root/target-wrong-checkout-repo" rev-parse main)
report "$fixture_root/target-wrong-checkout-report.md" "$wrong_checkout_sha"
wrong_checkout_output="$fixture_root/target-wrong-checkout-output.txt"
"$land" --branch ag-target-wrong-checkout --item-id ag-target-wrong-checkout --report "$fixture_root/target-wrong-checkout-report.md" --repo "$fixture_root/target-wrong-checkout-repo" --target-branch v3 --no-push >"$wrong_checkout_output" 2>&1
wrong_checkout_status=$?
assert test "$wrong_checkout_status" -eq 2
assert_output_has "$wrong_checkout_output" 'LAND default-branch expected=v3 current=main'
assert_output_has "$wrong_checkout_output" 'LAND step=default-branch status=fail'
assert test "$(git -C "$fixture_root/target-wrong-checkout-repo" rev-parse main)" = "$main_before"

# --- 4. The flag cannot be used to bypass the freshness check. -------------
# origin/v3 advances after clone (peer push); main stays fresh throughout.
# A landing with --target-branch v3 must still fail on freshness even though
# the (unused) default main is perfectly up to date -- proving the flag
# retargets the guard instead of skipping it.
make_fixture target-stale
stale_sha=$(make_lane "$fixture_root/target-stale-repo" ag-target-stale v3)
git clone "$fixture_root/target-stale-origin.git" "$fixture_root/target-stale-peer" >/dev/null
git -C "$fixture_root/target-stale-peer" config user.email peer@example.test
git -C "$fixture_root/target-stale-peer" config user.name Peer
git -C "$fixture_root/target-stale-peer" checkout v3 >/dev/null
printf 'remote advance\n' > "$fixture_root/target-stale-peer/remote.txt"
git -C "$fixture_root/target-stale-peer" add remote.txt
git -C "$fixture_root/target-stale-peer" commit -m remote-advance >/dev/null
git -C "$fixture_root/target-stale-peer" push origin v3 >/dev/null
main_before=$(git -C "$fixture_root/target-stale-repo" rev-parse main)
git -C "$fixture_root/target-stale-repo" checkout v3 >/dev/null
report "$fixture_root/target-stale-report.md" "$stale_sha"
stale_output="$fixture_root/target-stale-output.txt"
"$land" --branch ag-target-stale --item-id ag-target-stale --report "$fixture_root/target-stale-report.md" --repo "$fixture_root/target-stale-repo" --target-branch v3 --no-push >"$stale_output" 2>&1
stale_status=$?
assert test "$stale_status" -eq 2
assert_output_has "$stale_output" 'LAND step=freshness status=fail'
assert test "$(git -C "$fixture_root/target-stale-repo" rev-parse v3)" != "$(git -C "$fixture_root/target-stale-repo" rev-parse origin/v3)"
assert test "$(git -C "$fixture_root/target-stale-repo" rev-parse main)" = "$main_before"
assert git -C "$fixture_root/target-stale-repo" show-ref --verify --quiet refs/heads/ag-target-stale

echo "land target-branch tests: pass"
