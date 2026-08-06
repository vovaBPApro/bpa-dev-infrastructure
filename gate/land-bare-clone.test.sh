#!/usr/bin/env bash
# V3-5.27. The landing procedure must work from a bare clone with zero hand-steps.
#
# Landing ag-v3-5.25-r3 from a fresh clone of origin/main on 2026-08-06 needed
# three manual preparations that a rebuilt host has no way to know about. Two of
# them were gate defects and are locked here:
#
#   * `git config user.name/user.email` -- the merge step died with a bare
#     `fatal: unable to auto-detect email address` after passing every guard,
#     because the gate authored its merge commit with whatever identity the
#     checkout happened to carry, and a clone carries none.
#   * `git branch v2-deprecated origin/v2-deprecated` -- the rebuild proof
#     dereferenced an unqualified `v2-deprecated^{commit}`, which a clone cannot
#     resolve because a clone has only remote-tracking refs. gate/land-lib.sh
#     could report only the generic `blocker=rebuild-proof-failed`.
#
# The property under lock is one sentence: in a bare clone the gate's
# preconditions are either MATERIALIZED by the gate or refused BY NAME with what
# is missing listed -- never a mid-flight `fatal:`. Every landing case below runs
# with HOME, GIT_CONFIG_GLOBAL and GIT_CONFIG_SYSTEM neutralized, so "the host
# has no git identity" is a property of the run rather than of whoever runs it.
set -euo pipefail
unset BUN_BIN

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
land="${LAND_UNDER_TEST:-$root/gate/land.sh}"
lib="${LAND_LIB_UNDER_TEST:-$root/gate/land-lib.sh}"
prover="${METEORITE_PROVER_UNDER_TEST:-$root/meteorite/prove-candidate.sh}"
fixture_root=$(mktemp -d)
trap 'rm -rf "$fixture_root"' EXIT

mkdir -p "$fixture_root/fake-bin"
printf '#!/usr/bin/env bash\ntest "$1" = info\n' > "$fixture_root/fake-bin/docker"
chmod +x "$fixture_root/fake-bin/docker"
export PATH="$fixture_root/fake-bin:$PATH"

pass_count=0

assert() {
  if ! "$@"; then
    echo "assertion failed: $*" >&2
    exit 1
  fi
  pass_count=$((pass_count + 1))
}

assert_not() {
  if "$@"; then
    echo "unexpected success: $*" >&2
    exit 1
  fi
  pass_count=$((pass_count + 1))
}

assert_has() {
  if ! grep -Fq -- "$2" "$1"; then
    echo "expected '$2' in $1" >&2
    sed -n '1,200p' "$1" >&2
    exit 1
  fi
  pass_count=$((pass_count + 1))
}

assert_lacks() {
  if grep -Fq -- "$2" "$1"; then
    echo "unexpected '$2' in $1" >&2
    sed -n '1,200p' "$1" >&2
    exit 1
  fi
  pass_count=$((pass_count + 1))
}

# Run a command as a host with NO git identity of any kind: no repository
# config (the clone never gets one), no global file, no system file, and a HOME
# that does not exist. This is the whole point -- a run that quietly inherited
# the developer's own ~/.gitconfig would pass against the pre-fix gate too.
bare_host() {
  env HOME="$fixture_root/nonexistent-home" \
      GIT_CONFIG_GLOBAL=/dev/null \
      GIT_CONFIG_SYSTEM=/dev/null \
      "$@"
}

# A minimal landable repository plus its bare origin. `donor` decides whether
# origin carries a `v2-deprecated` branch, which is what the meteorite's rebuild
# proof dereferences. `prover_kind` is `stub` (the inert report writer every
# other gate fixture uses, which advertises no --preflight) or `real` (this
# repository's actual prover, so the donor resolution under test is the shipped
# one and not a restatement of it).
make_source() {
  local name="$1" prover_kind="$2" donor="$3"
  bare="$fixture_root/$name-origin.git"
  source_repo="$fixture_root/$name-source"
  git init --bare --initial-branch=main "$bare" >/dev/null
  git clone "$bare" "$source_repo" >/dev/null
  git -C "$source_repo" config user.email land@example.test
  git -C "$source_repo" config user.name Land
  printf 'base\n' > "$source_repo/base.txt"
  printf 'import { test, expect } from "bun:test"; test("fixture", () => expect(true).toBe(true));\n' \
    > "$source_repo/base.test.ts"
  mkdir -p "$source_repo/hygiene" "$source_repo/instance/parked" "$source_repo/meteorite"
  cp "$root/hygiene/check-retained-branches.ts" "$source_repo/hygiene/check-retained-branches.ts"
  printf 'main\n' > "$source_repo/instance/hygiene-protected-branches.txt"
  printf '| row | active |\n' > "$source_repo/instance/workboard.md"
  printf 'keep\n' > "$source_repo/instance/parked/.gitkeep"
  if [ "$prover_kind" = real ]; then
    cp "$prover" "$source_repo/meteorite/prove-candidate.sh"
  else
    cat > "$source_repo/meteorite/prove-candidate.sh" <<'EOF'
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
EOF
  fi
  chmod +x "$source_repo/meteorite/prove-candidate.sh"
  git -C "$source_repo" add -A
  git -C "$source_repo" commit -m base >/dev/null
  git -C "$source_repo" push -u origin main >/dev/null
  printf 'ref: refs/heads/main\n' > "$bare/HEAD"
  if [ "$donor" = with-donor ]; then
    git -C "$source_repo" branch v2-deprecated main >/dev/null
    git -C "$source_repo" push origin v2-deprecated >/dev/null
  fi
  git -C "$source_repo" checkout -q -b "$name-lane"
  printf 'lane\n' > "$source_repo/lane.txt"
  git -C "$source_repo" add lane.txt
  git -C "$source_repo" commit -m lane >/dev/null
  lane_sha=$(git -C "$source_repo" rev-parse HEAD)
  git -C "$source_repo" checkout -q main
  git -C "$source_repo" push origin "$name-lane" >/dev/null
}

# The bare clone: cloned and used, never configured. No `git config user.*`
# line exists here on purpose, and no local branch is created for the donor.
make_bare_clone() {
  local name="$1"
  shift
  clone="$fixture_root/$name-clone"
  git clone "$@" "$bare" "$clone" >/dev/null
  git -C "$clone" branch "$name-lane" "origin/$name-lane" >/dev/null 2>&1 || true
  assert_not git -C "$clone" config --get user.email >/dev/null
  assert_not git -C "$clone" rev-parse --verify --quiet refs/heads/v2-deprecated >/dev/null
}

report_for() {
  printf 'commit: %s fixture\nverify: true\nresult: clean\nsecret-scan: clean\nremaining: none\n' "$2" > "$1"
}

echo "== case 1: a bare clone reaches a real verdict with zero preparation =="
# Red before the fix: `LAND step=merge status=fail` preceded by
# `fatal: unable to auto-detect email address`, with the landing dead at the
# merge after every guard had passed.
make_source zero-prep stub no-donor
make_bare_clone zero-prep
report_for "$fixture_root/zero-prep.md" "$lane_sha"
zero_prep_out="$fixture_root/zero-prep.out"
set +e
bare_host "$land" --branch zero-prep-lane --item-id zero-prep-lane \
  --report "$fixture_root/zero-prep.md" --repo "$clone" --no-push >"$zero_prep_out" 2>&1
zero_prep_status=$?
set -e
assert_has "$zero_prep_out" 'LAND preflight identity=gate-provided'
assert_has "$zero_prep_out" 'LAND step=preflight status=pass'
assert_has "$zero_prep_out" 'LAND step=merge status=pass'
assert_has "$zero_prep_out" 'LAND step=declared-checks status=pass'
assert_has "$zero_prep_out" 'LAND step=retained-branches status=pass'
# A `fatal:` from git plumbing is the failure mode this row exists to remove.
assert_lacks "$zero_prep_out" 'fatal: unable to auto-detect email address'
# --no-push cannot delete the lane ref on origin, so the run ends on that named
# outcome. Reaching it at all is the claim: every precondition was materialized.
assert_has "$zero_prep_out" 'LAND verdict=landed-local-reap-failed'
assert test "$zero_prep_status" -ne 0
merge_sha=$(git -C "$clone" rev-parse main)
assert test "$(git -C "$clone" log -1 --format='%cn <%ce>' "$merge_sha")" = 'BPA Landing Gate <landing-gate@bpa.invalid>'
assert test "$(git -C "$clone" log -1 --format='%an <%ae>' "$merge_sha")" = 'BPA Landing Gate <landing-gate@bpa.invalid>'

echo "== case 2: the identity is the gate's even when the host has one =="
# The identity is supplied unconditionally, not as a fallback for a bare host.
# A fallback would leave two behaviours and exercise only one of them here.
make_source configured-host stub no-donor
make_bare_clone configured-host
git -C "$clone" config user.email someone-else@example.test
git -C "$clone" config user.name 'Someone Else'
report_for "$fixture_root/configured-host.md" "$lane_sha"
set +e
"$land" --branch configured-host-lane --item-id configured-host-lane \
  --report "$fixture_root/configured-host.md" --repo "$clone" --no-push \
  >"$fixture_root/configured-host.out" 2>&1
set -e
assert_has "$fixture_root/configured-host.out" 'LAND step=merge status=pass'
assert test "$(git -C "$clone" log -1 --format='%cn <%ce>' main)" = 'BPA Landing Gate <landing-gate@bpa.invalid>'

echo "== case 3: an unresolvable donor is refused by name, before any mutation =="
# Red before the fix: the prover died on `v2-deprecated^{commit}` deep inside a
# post-merge step and the gate reported `blocker=rebuild-proof-failed`, naming
# neither the ref nor the hand-step. Now it never gets that far.
make_source missing-donor real no-donor
make_bare_clone missing-donor
report_for "$fixture_root/missing-donor.md" "$lane_sha"
missing_donor_out="$fixture_root/missing-donor.out"
pre_merge_main=$(git -C "$clone" rev-parse main)
set +e
bare_host "$land" --branch missing-donor-lane --item-id missing-donor-lane \
  --report "$fixture_root/missing-donor.md" --repo "$clone" --no-push >"$missing_donor_out" 2>&1
missing_donor_status=$?
set -e
assert test "$missing_donor_status" -ne 0
assert_has "$missing_donor_out" 'ERROR: meteorite donor branch unresolvable: v2-deprecated'
assert_has "$missing_donor_out" 'missing: refs/heads/v2-deprecated, refs/remotes/origin/v2-deprecated, and refs/heads/v2-deprecated on remote origin'
assert_has "$missing_donor_out" 'LAND step=preflight status=fail missing=meteorite-donor'
assert_has "$missing_donor_out" 'LAND step=preflight status=fail'
# Refused before the merge, and refused instead of a generic blocker.
assert_lacks "$missing_donor_out" 'LAND step=merge status=pass'
assert_lacks "$missing_donor_out" 'blocker=rebuild-proof-failed'
assert test "$(git -C "$clone" rev-parse main)" = "$pre_merge_main"

echo "== case 4: a donor present only as a remote-tracking ref resolves =="
# This is the exact bare-clone shape: origin carries the branch, the clone has
# refs/remotes/origin/v2-deprecated and no refs/heads/v2-deprecated.
make_source tracking-donor real with-donor
make_bare_clone tracking-donor
assert git -C "$clone" rev-parse --verify --quiet refs/remotes/origin/v2-deprecated >/dev/null
tracking_out="$fixture_root/tracking-donor-preflight.out"
# Status is captured rather than left to `set -e`: an exit trap kills the run
# with no message, so a regression here would be red without naming its case.
set +e
bare_host bash "$clone/meteorite/prove-candidate.sh" --preflight >"$tracking_out" 2>&1
tracking_status=$?
set -e
assert_has "$tracking_out" 'resolved-from=refs/remotes/origin/v2-deprecated'
assert test "$tracking_status" -eq 0
donor_sha=$(git -C "$clone" rev-parse refs/remotes/origin/v2-deprecated)
assert_has "$tracking_out" "sha=$donor_sha"

echo "== case 5: a narrowed clone has the donor materialized by fetch =="
# A --single-branch clone has no remote-tracking ref for the donor either. The
# gate materializes it rather than requiring a hand-step, and the proof is
# unweakened: it comes from the remote, which must actually carry the branch.
make_source fetched-donor real with-donor
make_bare_clone fetched-donor --single-branch --branch main
assert_not git -C "$clone" rev-parse --verify --quiet refs/remotes/origin/v2-deprecated >/dev/null
fetched_out="$fixture_root/fetched-donor-preflight.out"
set +e
bare_host bash "$clone/meteorite/prove-candidate.sh" --preflight >"$fetched_out" 2>&1
fetched_status=$?
set -e
assert_has "$fetched_out" 'resolved-from=refs/remotes/origin/v2-deprecated (materialized by fetch)'
assert test "$fetched_status" -eq 0
assert git -C "$clone" rev-parse --verify --quiet refs/remotes/origin/v2-deprecated >/dev/null

echo "== case 6: the prover refuses a donor that exists nowhere tracked =="
# The proof must NOT be weakened into "carry on without a donor". Absence from
# every tracked location is still a hard refusal; only its wording changed.
make_source absent-donor real no-donor
make_bare_clone absent-donor
absent_out="$fixture_root/absent-donor-preflight.out"
set +e
bare_host bash "$clone/meteorite/prove-candidate.sh" --preflight >"$absent_out" 2>&1
absent_status=$?
set -e
assert test "$absent_status" -eq 2
assert_has "$absent_out" 'ERROR: meteorite donor branch unresolvable: v2-deprecated'
assert_lacks "$absent_out" 'resolved-from='

echo "== case 7: the gate identity is well-formed and the probe proves commit capability =="
# land_preflight_preconditions is exercised directly so the two identity
# failures it can name are distinguishable from the donor one.
# shellcheck disable=SC1090
source "$lib"
assert test -n "$LAND_GATE_IDENTITY_NAME"
assert test -n "$LAND_GATE_IDENTITY_EMAIL"
probe_out="$fixture_root/probe.out"
set +e
( bare_host bash -c 'source "$1"; land_preflight_preconditions "$2"' _ "$lib" "$clone" ) >"$probe_out" 2>&1
probe_status=$?
set -e
# The donor is absent in this fixture, so the whole preflight refuses -- but by
# NAME, and the identity half is not what failed.
assert test "$probe_status" -ne 0
assert_has "$probe_out" 'missing=meteorite-donor'
assert_lacks "$probe_out" 'commit-capability'
assert_lacks "$probe_out" 'missing=gate-identity'

echo "PASS gate/land-bare-clone.test.sh assertions=$pass_count"
