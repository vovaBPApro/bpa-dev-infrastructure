#!/usr/bin/env bash
# Self-contained tests for workspace.sh; fixtures use local file:// bare repos only.
set -euo pipefail

TEST_ROOT="$(mktemp -d)"
cleanup() { rm -rf "$TEST_ROOT"; }
trap cleanup EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
assert_file() { [[ -e "$1" ]] || fail "expected path: $1"; }
assert_not_file() { [[ ! -e "$1" ]] || fail "unexpected path: $1"; }
assert_eq() { [[ "$1" == "$2" ]] || fail "expected [$1], got [$2]"; }
expect_fail() {
  if "$@" >/dev/null 2>"$TEST_ROOT/error"; then
    fail "expected failure: $*"
  fi
}

SOURCE="$TEST_ROOT/source"
REMOTE="$TEST_ROOT/fixture.git"
WORKSPACE="$TEST_ROOT/workspace"
mkdir -p "$SOURCE" "$WORKSPACE"
git init -q -b main "$SOURCE"
git -C "$SOURCE" config user.email tests@example.invalid
git -C "$SOURCE" config user.name Workspace-Test
printf 'one\n' > "$SOURCE/product.txt"
git -C "$SOURCE" add product.txt
git -C "$SOURCE" commit -qm initial
git init -q --bare "$REMOTE"
git -C "$SOURCE" remote add origin "file://$REMOTE"
git -C "$SOURCE" push -qu origin main
git -C "$REMOTE" symbolic-ref HEAD refs/heads/main

cp "$(dirname "$0")/workspace.sh" "$WORKSPACE/workspace.sh"
chmod +x "$WORKSPACE/workspace.sh"
printf 'fixture=file://%s\n' "$REMOTE" > "$WORKSPACE/repos.conf"

"$WORKSPACE/workspace.sh" sync
REPO="$WORKSPACE/repos/fixture"
assert_file "$REPO/.git"
assert_eq "$(git -C "$REPO" rev-parse HEAD)" "$(git -C "$SOURCE" rev-parse HEAD)"
git -C "$REPO" config user.email tests@example.invalid
git -C "$REPO" config user.name Workspace-Test

printf 'two\n' >> "$SOURCE/product.txt"
git -C "$SOURCE" commit -qam upstream
git -C "$SOURCE" push -q origin main
"$WORKSPACE/workspace.sh" sync
assert_eq "$(git -C "$REPO" rev-parse HEAD)" "$(git -C "$SOURCE" rev-parse HEAD)"

printf 'local\n' > "$REPO/local.txt"
expect_fail "$WORKSPACE/workspace.sh" sync
assert_file "$REPO/local.txt"
git -C "$REPO" clean -qfd

printf 'diverged\n' > "$REPO/diverged.txt"
git -C "$REPO" add diverged.txt
git -C "$REPO" commit -qm diverged
expect_fail "$WORKSPACE/workspace.sh" sync
git -C "$REPO" reset -q --hard origin/main

"$WORKSPACE/workspace.sh" lane fixture coder-one
LANE="$WORKSPACE/lanes/coder-one"
assert_file "$LANE/.git"
assert_eq "$(git -C "$LANE" branch --show-current)" ag-coder-one
printf 'lane\n' > "$LANE/lane.txt"
git -C "$LANE" add lane.txt
git -C "$LANE" commit -qm lane-work
UNMERGED="$(git -C "$LANE" rev-parse --short HEAD)"
expect_fail "$WORKSPACE/workspace.sh" reap coder-one
reap_evidence=0
while IFS= read -r line; do
  [[ "$line" == *"$UNMERGED"* ]] && reap_evidence=1
done < "$TEST_ROOT/error"
[[ "$reap_evidence" -eq 1 ]] || fail 'unmerged reap refusal did not list the commit'
git -C "$REPO" merge -q --no-ff ag-coder-one -m merge-lane
git -C "$REPO" push -q origin main
"$WORKSPACE/workspace.sh" reap coder-one
assert_not_file "$LANE"
if git -C "$REPO" show-ref --verify --quiet refs/heads/ag-coder-one; then
  fail 'lane branch was not deleted'
fi

LIST="$($WORKSPACE/workspace.sh ls)"
has_repo=0
has_lane=0
while IFS= read -r record; do
  [[ "$record" == $'repo\tfixture\t'* ]] && has_repo=1
  [[ "$record" == $'lane\t'* ]] && has_lane=1
done <<< "$LIST"
[[ "$has_repo" -eq 1 ]] || fail 'repository did not appear in list'
[[ "$has_lane" -eq 0 ]] || fail 'reaped lane appeared in list'
printf 'workspace tests: PASS\n'
