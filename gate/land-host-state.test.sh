#!/usr/bin/env bash
# V3-2.9 invocation lock. Hard Floor 5 requires non-git host state to be
# enumerated; tools/check-host-state.ts is the mechanism that keeps the
# enumeration true, and this file proves the mechanism is actually RUN.
#
# V3-0.28 exists because tracked-but-inert mechanisms are this repository's most
# common defect, and its detector was reopened for accepting a code comment as
# an executor. So the claim "the landing gate invokes it" is not made by grep
# here: two real landings are performed against fixture repositories, one whose
# enumeration is complete and one where the code writes to a path no row covers.
# The first must land; the second must abort at step=host-state with the target
# ref untouched.
set -u
set -o pipefail

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
land="$root/gate/land.sh"
fixture_root=$(env -u TMPDIR -u TMP -u TEMP mktemp -d)
mkdir -p "$fixture_root/fake-bin"
printf '#!/usr/bin/env bash\ntest "$1" = info\n' > "$fixture_root/fake-bin/docker"
chmod +x "$fixture_root/fake-bin/docker"
export PATH="$fixture_root/fake-bin:$PATH"
trap 'rm -rf "$fixture_root"' EXIT

assert() {
  if ! "$@"; then
    echo "assertion failed: $*" >&2
    exit 1
  fi
}
assert_output_has() { assert grep -Fq "$2" "$1"; }

# A fixture repository carrying the checker, a two-row enumeration, and one
# tracked file that writes exactly the enumerated paths.
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
  mkdir -p "$repo/hygiene" "$repo/instance/parked" "$repo/tools" "$repo/svc" "$repo/meteorite"
  cp "$root/hygiene/check-retained-branches.ts" "$repo/hygiene/check-retained-branches.ts"
  cp "$root/tools/check-host-state.ts" "$repo/tools/check-host-state.ts"
  printf 'main\n' > "$repo/instance/hygiene-protected-branches.txt"
  printf '| row | active |\n' > "$repo/instance/workboard.md"
  printf "const STATE = '/var/lib/fixture-widget';\n" > "$repo/svc/writer.sh"
  {
    printf '# id\tpath\twriter\tdisposition\tverify\tnote\n'
    printf 'widget\t/var/lib/fixture-widget\tsvc/writer.sh\tmust-survive\tbun tools/check-host-state.ts probe dir /var/lib/fixture-widget\tfixture row\n'
  } > "$repo/instance/host-state.tsv"
  printf '# prefix\treason\n' > "$repo/instance/host-state-exclusions.tsv"
  sed -n '/^# BEGIN TRUSTED TEST PROVER$/,/^# END TRUSTED TEST PROVER$/p' "$root/gate/land.test.sh" | sed '1d;$d' > "$repo/meteorite/prove-candidate.sh"
  chmod +x "$repo/meteorite/prove-candidate.sh"
  git -C "$repo" add base.txt base.test.ts hygiene tools svc instance meteorite/prove-candidate.sh
  git -C "$repo" commit -m base >/dev/null
  git -C "$repo" push -u origin main >/dev/null
  printf 'ref: refs/heads/main\n' > "$bare/HEAD"
}

report() {
  printf 'commit: %s fixture\nverify: %s\nresult: clean\nsecret-scan: clean\nremaining: none\n' "$2" "$3" > "$1"
}

# --- 1. Green after: a complete enumeration lands ---------------------------
make_fixture enumerated
repo="$fixture_root/enumerated-repo"
git -C "$repo" checkout -b ag-enumerated >/dev/null
printf 'lane\n' > "$repo/lane.txt"
git -C "$repo" add lane.txt
git -C "$repo" commit -m lane >/dev/null
lane_sha=$(git -C "$repo" rev-parse HEAD)
git -C "$repo" checkout main >/dev/null
report "$fixture_root/enumerated-report.md" "$lane_sha" 'true'
out="$fixture_root/enumerated-out.txt"
if ! "$land" --branch ag-enumerated --item-id ag-enumerated \
  --report "$fixture_root/enumerated-report.md" --repo "$repo" --no-push >"$out" 2>&1; then
  echo 'enumerated: gate rejected a complete enumeration' >&2
  cat "$out" >&2
  exit 1
fi
assert_output_has "$out" 'LAND step=host-state status=pass'

# --- 2. Red before: state the enumeration does not name blocks the landing --
# The lane teaches the tracked code to write somewhere no row covers -- the
# exact drift Hard Floor 5's enumeration clause exists to prevent.
make_fixture undeclared
repo="$fixture_root/undeclared-repo"
before=$(git -C "$repo" rev-parse main)
git -C "$repo" checkout -b ag-undeclared >/dev/null
printf "const NEW = '/var/lib/fixture-unenumerated';\n" >> "$repo/svc/writer.sh"
git -C "$repo" add svc/writer.sh
git -C "$repo" commit -m lane >/dev/null
lane_sha=$(git -C "$repo" rev-parse HEAD)
git -C "$repo" checkout main >/dev/null
report "$fixture_root/undeclared-report.md" "$lane_sha" 'true'
out="$fixture_root/undeclared-out.txt"
if "$land" --branch ag-undeclared --item-id ag-undeclared \
  --report "$fixture_root/undeclared-report.md" --repo "$repo" --no-push >"$out" 2>&1; then
  echo 'undeclared: gate landed a change that writes unenumerated host state' >&2
  cat "$out" >&2
  exit 1
fi
assert_output_has "$out" 'unenumerated host state: /var/lib/fixture-unenumerated'
assert_output_has "$out" 'LAND step=host-state status=fail'
assert_output_has "$out" 'LAND verdict=aborted sha=none'
# The abort must roll the merge back, not leave main advanced.
assert test "$(git -C "$repo" rev-parse main)" = "$before"
assert test "$(git -C "$repo" rev-parse HEAD)" = "$before"
assert test -z "$(git -C "$repo" status --porcelain)"

echo 'land-host-state: PASS'
