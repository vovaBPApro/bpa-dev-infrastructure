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
# The round-2 addition is the clearance rule: a world that could not mask may
# not clear the step. The host-path fixture is therefore driven through BOTH
# configurations of the one variable the round-1 review changed -- namespace
# usable, and namespace genuinely absent -- and it must not pass in either. The
# maskless configuration is produced honestly, by running the harness with a
# PATH that has no `unshare` on it, so those scenarios are true on every host
# and need no capability exclusion of their own.
#
# The cases that need a REAL mask (the delta naming, and the two that must
# reach a clearance) are capability-gated on a usable mount namespace and
# announce their exclusion, per instance/expected-shell-capability-exclusions.tsv.
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

# A scenario may only expect a mask to have been applied when both hold. Under
# the tier run (tools/shell-test-tier.test.ts forces mount-namespace missing)
# and on a host without unprivileged mount namespaces, the harness refuses every
# clearance by design, so those scenarios announce an exclusion instead.
namespace_usable() {
  ! capability_forced_missing mount-namespace && unshare --mount --propagation private -- true >/dev/null 2>&1
}

# A world where the capability is genuinely absent, produced WITHOUT the test
# affordance -- so the scenarios that use it prove the real environmental path,
# not the harness's own pretend switch. The harness decides by running
# `unshare`, and a kernel with `unprivileged_userns_clone=0` answers exactly
# like this: the binary is there and it fails. The rest of PATH is untouched.
no_unshare_bin="$fixture_root/no-unshare-bin"
mkdir -p "$no_unshare_bin"
printf '#!/bin/sh\nexit 1\n' > "$no_unshare_bin/unshare"
chmod 0700 "$no_unshare_bin/unshare"

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

# For every scenario whose expected delta IS the umask, the control side must be
# permissive on purpose rather than by inheritance. This file is otherwise the
# V3-5.34 defect itself: run under the orchestrator's `umask 077` -- or inside
# this very harness, which is how it was caught before landing -- the umask
# fixture fails on BOTH sides and the harness correctly reports `verify-unstable`
# instead of the delta the scenario asserts. A lock that only holds at one
# ambient umask cannot be the lock for umask dependence.
run_harness_permissive() {
  ( umask 022; run_harness "$1" )
}

# The same harness, on a host whose mount namespace is genuinely unusable.
run_harness_maskless() {
  ( umask 022; PATH="$no_unshare_bin:$PATH" run_harness "$1" )
}

# --- green-after: the honest lane is untouched -------------------------------

echo "== scenario: a hermetic verify passes the bare world unchanged =="
if namespace_usable; then
  report hermetic 'bun test hermetic.test.ts' '' clean
  run_harness hermetic
  status=$?
  cat "$fixture_root/hermetic.out"
  assert [ "$status" -eq 0 ]
  assert_has "$fixture_root/hermetic.out" "verdict=pass"
  assert_lacks "$fixture_root/hermetic.out" "fidelity=reduced"
  echo "PASS: hermetic verify survives the bare world"
else
  # Not a pass at reduced fidelity: without a mask there is no full-fidelity
  # clearance to observe, so the case is excluded rather than weakened.
  echo 'bare-world: EXCLUDED case=hermetic-pass capability=mount-namespace'
fi
echo

# --- red-before: the three measured escapes ----------------------------------

echo "== scenario: V3-5.34's umask delta is refused, and named =="
report umask 'bun test umask.test.ts' '' clean
run_harness_permissive umask
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

# The V3-5.39 fixture, driven through both settings of the one variable the
# round-1 review changed. In round 1 the second setting produced `verdict=pass`
# and `LANE-EXIT verdict=clear exit=0` -- a lane reading an absolute host path,
# cleared by the harness built to catch exactly that. In NO configuration may it
# pass now.

echo "== scenario: V3-5.39's host config file, masking unavailable: the STEP refuses =="
report hostfile_maskless 'bun test hostfile.test.ts' '' clean
run_harness_maskless hostfile_maskless
status=$?
cat "$fixture_root/hostfile_maskless.out"
# The verify itself passes here -- the file is reachable, nothing was masked.
# That is precisely why the harness may not: it never tested the absence.
assert [ "$status" -eq 2 ]
assert_has "$fixture_root/hostfile_maskless.out" "masking=unavailable capability=mount-namespace"
assert_has "$fixture_root/hostfile_maskless.out" "verdict=refused reason=host-state-mask-not-applied"
assert_has "$fixture_root/hostfile_maskless.out" "NO-GO capability=mount-namespace"
assert_has "$fixture_root/hostfile_maskless.out" "hermeticity=undetermined"
assert_lacks "$fixture_root/hostfile_maskless.out" "verdict=pass"
echo "PASS: a world that could not mask refuses instead of clearing at reduced fidelity"
echo

echo "== scenario: the reduced-fidelity run is a DECLARED exception, and only that =="
report hostfile_declared 'bun test hostfile.test.ts' \
  'bare-world: capability=mount-namespace reason=this-container-has-no-unprivileged-mount-namespace' clean
run_harness_maskless hostfile_declared
status=$?
cat "$fixture_root/hostfile_declared.out"
assert [ "$status" -eq 0 ]
assert_has "$fixture_root/hostfile_declared.out" "declaration=accepted capability=mount-namespace"
assert_has "$fixture_root/hostfile_declared.out" "verdict=pass"
# The clearance is never silent about what it did not do.
assert_has "$fixture_root/hostfile_declared.out" "fidelity=reduced"
echo "PASS: the only way past the mask is a declaration in the lane's own report"
echo

echo "== scenario: a host-state declaration does not buy the missing namespace =="
report hostfile_wrongcap 'bun test hostfile.test.ts' \
  'bare-world: capability=host-state reason=the-wrong-declaration-for-this-gap' clean
run_harness_maskless hostfile_wrongcap
status=$?
cat "$fixture_root/hostfile_wrongcap.out"
assert [ "$status" -eq 2 ]
assert_has "$fixture_root/hostfile_wrongcap.out" "NO-GO capability=mount-namespace"
echo "PASS: one declaration cannot stand in for another"
echo

echo "== scenario: the test affordance cannot mint a clearance either =="
# The repository's own force-missing idiom, applied to the harness. It may make
# this gate stricter and nothing else; that it is refused even WITH a
# declaration, on a host whose real probe succeeds, is locked in
# gate/bare-world-deltas.test.ts's clearance table.
report affordance 'bun test hermetic.test.ts' '' clean
INFRA_TEST_FORCE_MISSING_CAPABILITIES=mount-namespace run_harness affordance
status=$?
cat "$fixture_root/affordance.out"
assert [ "$status" -eq 2 ]
assert_has "$fixture_root/affordance.out" "NO-GO capability=mount-namespace"
assert_lacks "$fixture_root/affordance.out" "verdict=pass"
echo "PASS: even a hermetic verify cannot clear an unmasked world"
echo

echo "== scenario: V3-5.39's host config file is refused, and the masked path named =="
if namespace_usable; then
  report hostfile 'bun test hostfile.test.ts' '' clean
  run_harness hostfile
  status=$?
  cat "$fixture_root/hostfile.out"
  assert [ "$status" -eq 2 ]
  assert_has "$fixture_root/hostfile.out" "delta=masked-host-path"
  assert_has "$fixture_root/hostfile.out" "$host_fixture/configured"
  assert_has "$fixture_root/hostfile.out" "host-exists=yes"
  echo "PASS: the host-config read is refused with the masked path named"
else
  # Naming the mask requires having applied one. The refusal itself is proven
  # unconditionally by the maskless scenarios above, so nothing is lost silently.
  echo 'bare-world: EXCLUDED case=masked-host-path capability=mount-namespace'
fi
echo

# --- the declaration path, per instructions/lane-capabilities.md -------------

echo "== scenario: a declared host-state capability is a named acceptance =="
if namespace_usable; then
  # Driven by the umask fixture, not the host-file one: the failure it declares
  # is one the bare world produces through a subtraction that always happens.
  report declared 'bun test umask.test.ts' \
    'bare-world: capability=host-state reason=this-lane-verifies-the-installed-custody' clean
  run_harness_permissive declared
  status=$?
  cat "$fixture_root/declared.out"
  assert [ "$status" -eq 0 ]
  assert_has "$fixture_root/declared.out" "verdict=declared capability=host-state"
  # Named, not silent: the delta is still reported against the declaration.
  assert_has "$fixture_root/declared.out" "reason=verify-needs-ambient-host-state"
  echo "PASS: a declared capability accepts the failure and still names it"
else
  # A failure declaration accepts a failure; it does not entitle an unmasked
  # world to clear, which is asserted unconditionally two scenarios up.
  echo 'bare-world: EXCLUDED case=declared-host-state capability=mount-namespace'
fi
echo

echo "== scenario: an undeclarable capability stops cleanly, per lane-capabilities =="
report badcap 'bun test umask.test.ts' 'bare-world: capability=telepathy reason=x' clean
run_harness_permissive badcap
status=$?
cat "$fixture_root/badcap.out"
assert [ "$status" -eq 2 ]
assert_has "$fixture_root/badcap.out" "NO-GO capability=telepathy"
echo "PASS: an unknown capability is a named refusal"
echo

echo "== scenario: a declaration without a reason is refused =="
report noreason 'bun test umask.test.ts' 'bare-world: capability=host-state' clean
run_harness_permissive noreason
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

echo "== scenario: the harness never masks a system directory, and then cannot clear =="
# Refusing the mask target is right -- masking /usr would make the world broken
# rather than bare. Clearing afterwards would not: with HOME pointed at a
# directory the harness may not mask, nothing was subtracted, and the second
# half of that is exactly the round-1 defect arriving by another route.
report hermetic2 'bun test hermetic.test.ts' '' clean
# The scenario owns its whole environment, HOME and the three XDG dirs alike:
# leaving the XDG variables to whatever the ambient world has set leaves the
# harness other things to mask, and the case then silently stops being the case
# it claims to be. Caught by this very harness -- inside the bare world the XDG
# variables ARE set, and the scenario passed instead of refusing.
( export HOME=/usr; unset XDG_CONFIG_HOME XDG_CACHE_HOME XDG_DATA_HOME; run_harness hermetic2 )
status=$?
cat "$fixture_root/hermetic2.out"
assert [ "$status" -eq 2 ]
assert_has "$fixture_root/hermetic2.out" "mask=skipped target=/usr reason=system-directory"
assert_has "$fixture_root/hermetic2.out" "verdict=refused reason=host-state-mask-not-applied"
assert_lacks "$fixture_root/hermetic2.out" "verdict=pass"
echo "PASS: a system directory is refused as a mask target, and an unmasked world is refused a clearance"
echo

echo "ALL BARE-WORLD SCENARIOS PASS"
