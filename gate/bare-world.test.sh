#!/usr/bin/env bash
# Locks gate/bare-world.ts: the bare-world verify that gate/lane-exit.sh runs
# after gate/completion-guard.ts has already run the report's `verify:` and
# found it green (instance/workboard.md V3-5.42).
#
# The scenarios are not invented. Each of the first three is a lane that
# actually happened on 2026-08-06, rebuilt as the smallest fixture that fails
# for the SAME reason:
#
#   umask-delta        V3-5.34 -- green at the lane's 0022, red under the
#                      orchestrator's `umask 077`.
#   masked-host-path   V3-5.39 -- a test asserting THIS host's configured
#                      passphrase file, which the rebuilt container lacks.
#   untracked          V3-5.25 -- green locally against a file that was never
#                      committed, red in the meteorite's clean clone. That one
#                      is already caught upstream, and the scenario below proves
#                      WHICH check owns it rather than claiming it twice.
#
# ...and the fourth, `hermetic`, is the one that must NOT change: a harness that
# is merely hostile would fail every lane and be switched off within a day.
#
# The masked-host-path case is capability-gated on a usable mount namespace and
# announces its own exclusion, per instance/expected-shell-capability-exclusions.tsv.
set -u
set -o pipefail

# The fixture owns its own environment; same one line as gate/land.test.sh:3.
unset BUN_BIN

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
harness="$root/gate/bare-world.ts"
fixture_root=$(mktemp -d)
# The one fixture that must live OUTSIDE the fixture root, because reproducing
# V3-5.39 requires a real file in the real home the harness is going to mask.
host_fixture="${HOME:-/root}/.bare-world-test-$$"
trap 'rm -rf "$fixture_root" "$host_fixture"' EXIT

bun_bin=$(PATH=/usr/local/bin:/usr/bin:/bin command -v bun 2>/dev/null || true)
if [ -z "$bun_bin" ]; then
  echo "bare-world: NO-GO bun-not-on-the-trusted-path" >&2
  exit 1
fi

capability_forced_missing() {
  [[ ",${INFRA_TEST_FORCE_MISSING_CAPABILITIES:-}," == *",$1,"* ]]
}

assert() {
  if ! "$@"; then
    echo "assertion failed: $*" >&2
    exit 1
  fi
}

assert_has() {
  if ! grep -Fq "$2" "$1"; then
    echo "expected output to contain: $2" >&2
    sed 's/^/  | /' "$1" >&2
    exit 1
  fi
}

assert_lacks() {
  if grep -Fq "$2" "$1"; then
    echo "expected output NOT to contain: $2" >&2
    sed 's/^/  | /' "$1" >&2
    exit 1
  fi
}

repo="$fixture_root/repo"
git init -q --initial-branch=main "$repo"
git -C "$repo" config user.email bare@example.test
git -C "$repo" config user.name Bare

# --- the four worlds, as tracked source -------------------------------------

cat > "$repo/hermetic.test.ts" <<'EOF'
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("builds the world it asserts on", () => {
  const own = mkdtempSync(join(tmpdir(), "hermetic-"));
  writeFileSync(join(own, "value"), "ok");
  expect(readFileSync(join(own, "value"), "utf8")).toBe("ok");
});
EOF

# V3-5.34's mechanism in one assertion: a directory this test creates is
# traversable by another uid. True at umask 0022 (0755), false at 0077 (0700).
cat > "$repo/umask.test.ts" <<'EOF'
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("a directory this test creates can be swept by another uid", () => {
  const own = mkdtempSync(join(tmpdir(), "umask-"));
  mkdirSync(join(own, "worktree"));
  expect(statSync(join(own, "worktree")).mode & 0o077).not.toBe(0);
});
EOF

# V3-5.39's mechanism: the installation's configured file, read by absolute
# path. HOST_FIXTURE is substituted below so the path is a real one.
cat > "$repo/hostfile.test.ts.in" <<'EOF'
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
test("the configured file is present", () => {
  const configured = "HOST_FIXTURE/configured";
  expect(existsSync(configured), `configured file not found: ${configured}`).toBe(true);
});
EOF
sed "s|HOST_FIXTURE|$host_fixture|" "$repo/hostfile.test.ts.in" > "$repo/hostfile.test.ts"
rm -f "$repo/hostfile.test.ts.in"
mkdir -p "$host_fixture"
printf 'present\n' > "$host_fixture/configured"

# V3-5.25's mechanism: a committed test that reads a file the lane never
# committed. Green in the worktree, absent from any clone.
cat > "$repo/untracked.test.ts" <<'EOF'
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
test("reads a fixture beside it", () => {
  const beside = join(import.meta.dir, "uncommitted-fixture.json");
  expect(existsSync(beside), `fixture missing: ${beside}`).toBe(true);
});
EOF

git -C "$repo" add -A
git -C "$repo" commit -qm "fixture worlds"
printf '{"never":"committed"}\n' > "$repo/uncommitted-fixture.json"
sha=$(git -C "$repo" rev-parse HEAD)

report() {
  # $1 name, $2 verify, $3 extra field line (may be empty), $4 result
  {
    printf 'commit: %s fixture\n' "$sha"
    printf 'verify: %s\n' "$2"
    [ -n "$3" ] && printf '%s\n' "$3"
    printf 'result: %s\n' "${4:-clean}"
    printf 'secret-scan: clean\n'
    printf 'remaining: none\n'
  } > "$fixture_root/$1.md"
}

run_harness() {
  # $1 report name -> writes $fixture_root/$1.out, returns the harness status
  "$bun_bin" "$harness" --report "$fixture_root/$1.md" --repo "$repo" > "$fixture_root/$1.out" 2>&1
}

# --- green-after: the honest lane is untouched -------------------------------

echo "== scenario: a hermetic verify passes the bare world unchanged =="
report hermetic 'bun test hermetic.test.ts' '' clean
run_harness hermetic
status=$?
cat "$fixture_root/hermetic.out"
assert [ "$status" -eq 0 ]
assert_has "$fixture_root/hermetic.out" "verdict=pass"
echo "PASS: hermetic verify survives the bare world"
echo

# --- red-before: the three measured escapes ----------------------------------

echo "== scenario: V3-5.34's umask delta is refused, and named =="
report umask 'bun test umask.test.ts' '' clean
run_harness umask
status=$?
cat "$fixture_root/umask.out"
assert [ "$status" -eq 2 ]
assert_has "$fixture_root/umask.out" "verdict=refused reason=verify-needs-ambient-host-state"
assert_has "$fixture_root/umask.out" "delta=permission-or-mode"
assert_has "$fixture_root/umask.out" "NO-GO capability=host-state"
echo "PASS: the umask-dependent verify is refused with the delta named"
echo

echo "== scenario: V3-5.25's untracked fixture -- named as unstable, because the guard upstream already owns it =="
report untracked 'bun test untracked.test.ts' '' clean
# Both the bare world and the control run against a clone at the SHA, and so
# does gate/completion-guard.ts (a detached worktree). So an uncommitted fixture
# is already absent from the run the guard makes BEFORE this harness is reached,
# and this scenario asserts both halves of that: the guard refuses the report,
# and the harness does not mislabel the same failure as a host-state delta it
# could have prevented.
"$bun_bin" "$root/gate/completion-guard.ts" --report "$fixture_root/untracked.md" --repo "$repo" \
  > "$fixture_root/untracked.guard.out" 2>&1
guard_status=$?
cat "$fixture_root/untracked.guard.out"
assert [ "$guard_status" -eq 2 ]
assert_has "$fixture_root/untracked.guard.out" "FAIL verify-run"
run_harness untracked
status=$?
cat "$fixture_root/untracked.out"
assert [ "$status" -eq 2 ]
assert_has "$fixture_root/untracked.out" "reason=verify-unstable"
assert_lacks "$fixture_root/untracked.out" "delta=masked-host-path"
echo "PASS: the clean-clone class is refused upstream and not misnamed here"
echo

echo "== scenario: V3-5.39's host config file is refused, and named =="
if capability_forced_missing mount-namespace || ! unshare --mount --propagation private -- true >/dev/null 2>&1; then
  # Without a mount namespace the host's real config dirs stay reachable by
  # absolute path, so this case cannot be reproduced -- and the harness says so
  # itself rather than passing as though it had run.
  echo 'bare-world: EXCLUDED case=masked-host-path capability=mount-namespace'
  report hostfile_reduced 'bun test hostfile.test.ts' '' clean
  INFRA_TEST_FORCE_MISSING_CAPABILITIES=mount-namespace run_harness hostfile_reduced
  status=$?
  cat "$fixture_root/hostfile_reduced.out"
  assert [ "$status" -eq 0 ]
  assert_has "$fixture_root/hostfile_reduced.out" "masking=unavailable"
  assert_has "$fixture_root/hostfile_reduced.out" "fidelity=reduced"
else
  report hostfile 'bun test hostfile.test.ts' '' clean
  run_harness hostfile
  status=$?
  cat "$fixture_root/hostfile.out"
  assert [ "$status" -eq 2 ]
  assert_has "$fixture_root/hostfile.out" "delta=masked-host-path"
  assert_has "$fixture_root/hostfile.out" "$host_fixture/configured"
  assert_has "$fixture_root/hostfile.out" "host-exists=yes"

  # The same fixture, same host, masking off: it passes. That is the proof that
  # the mask -- not some other subtraction -- is what caught it.
  report hostfile_reduced 'bun test hostfile.test.ts' '' clean
  INFRA_TEST_FORCE_MISSING_CAPABILITIES=mount-namespace run_harness hostfile_reduced
  status=$?
  assert [ "$status" -eq 0 ]
  assert_has "$fixture_root/hostfile_reduced.out" "masking=unavailable"
  assert_lacks "$fixture_root/hostfile_reduced.out" "masked:"
fi
echo "PASS: the host-config read is refused with the masked path named"
echo

# --- the declaration path, per instructions/lane-capabilities.md -------------

echo "== scenario: a declared host-state capability is a named acceptance =="
# Driven by the umask fixture, not the host-file one: this scenario must mean
# the same thing on a host without a usable mount namespace, where the host-file
# fixture legitimately passes.
report declared 'bun test umask.test.ts' \
  'bare-world: capability=host-state reason=this-lane-verifies-the-installed-custody' clean
run_harness declared
status=$?
cat "$fixture_root/declared.out"
assert [ "$status" -eq 0 ]
assert_has "$fixture_root/declared.out" "verdict=declared capability=host-state"
# Named, not silent: the delta is still reported against the declaration.
assert_has "$fixture_root/declared.out" "reason=verify-needs-ambient-host-state"
echo "PASS: a declared capability accepts the failure and still names it"
echo

echo "== scenario: an undeclarable capability stops cleanly, per lane-capabilities =="
report badcap 'bun test umask.test.ts' 'bare-world: capability=telepathy reason=x' clean
run_harness badcap
status=$?
cat "$fixture_root/badcap.out"
assert [ "$status" -eq 2 ]
assert_has "$fixture_root/badcap.out" "NO-GO capability=telepathy"
echo "PASS: an unknown capability is a named refusal"
echo

echo "== scenario: a declaration without a reason is refused =="
report noreason 'bun test umask.test.ts' 'bare-world: capability=host-state' clean
run_harness noreason
status=$?
cat "$fixture_root/noreason.out"
assert [ "$status" -eq 2 ]
assert_has "$fixture_root/noreason.out" "reason=declaration-without-reason"
echo "PASS: a reasonless declaration cannot buy an exemption"
echo

# --- the boundaries of the harness's own authority ---------------------------

echo "== scenario: an honest NO-GO is not-applicable, never a second failure =="
report nogo 'bun test hermetic.test.ts' '' NO-GO
run_harness nogo
status=$?
cat "$fixture_root/nogo.out"
assert [ "$status" -eq 0 ]
assert_has "$fixture_root/nogo.out" "status=not-applicable reason=result-not-clean"
echo "PASS: a NO-GO report is left alone"
echo

echo "== scenario: failing in BOTH worlds is unstable, not a host-state defect =="
report unstable 'bun test hermetic.test.ts && exit 7' '' clean
run_harness unstable
status=$?
cat "$fixture_root/unstable.out"
assert [ "$status" -eq 2 ]
assert_has "$fixture_root/unstable.out" "reason=verify-unstable"
# The wrong remedy is worse than none: declaring host-state cannot fix a command
# that fails in the ambient world too.
assert_lacks "$fixture_root/unstable.out" "capability=host-state"
echo "PASS: a both-worlds failure is named as unstable and offered no exemption"
echo

echo "== scenario: a declaration does not excuse an unstable verify =="
report unstable_declared 'bun test hermetic.test.ts && exit 7' \
  'bare-world: capability=host-state reason=claimed-but-irrelevant' clean
run_harness unstable_declared
status=$?
cat "$fixture_root/unstable_declared.out"
assert [ "$status" -eq 2 ]
assert_has "$fixture_root/unstable_declared.out" "reason=verify-unstable"
echo "PASS: the declaration is scoped to host state, not to failure in general"
echo

echo "== scenario: the harness never masks a directory holding its verifiers =="
report hermetic2 'bun test hermetic.test.ts' '' clean
HOME=/usr run_harness hermetic2
status=$?
cat "$fixture_root/hermetic2.out"
assert [ "$status" -eq 0 ]
assert_has "$fixture_root/hermetic2.out" "mask=skipped target=/usr reason=system-directory"
echo "PASS: a system directory is refused as a mask target and named"
echo

echo "ALL BARE-WORLD SCENARIOS PASS"
