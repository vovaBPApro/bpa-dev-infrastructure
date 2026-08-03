#!/usr/bin/env bash
# Regression lock for repository-global refs/stash across sibling worktrees.
set -euo pipefail

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
checker="$root/hygiene/check-shared-stash.sh"
fixture_root=$(mktemp -d)
trap 'rm -rf "$fixture_root"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

repo="$fixture_root/repo"
lane_one="$fixture_root/lane-one"
lane_two="$fixture_root/lane-two"
git init --initial-branch=main "$repo" >/dev/null
git -C "$repo" config user.email lanes@example.test
git -C "$repo" config user.name Lanes
printf 'base\n' > "$repo/base.txt"
git -C "$repo" add base.txt
git -C "$repo" commit -m base >/dev/null
git -C "$repo" branch ag-one
git -C "$repo" branch ag-two
git -C "$repo" worktree add "$lane_one" ag-one >/dev/null
git -C "$repo" worktree add "$lane_two" ag-two >/dev/null

scratch_and_restore() {
  local lane="$1" own_file="$2" foreign_file="$3"
  printf '%s\n' "$own_file" > "$lane/$own_file"
  git -C "$lane" add -A
  git -C "$lane" commit --no-verify -m "scratch: set work aside" >/dev/null
  test ! -e "$lane/$foreign_file" || fail "$lane saw foreign file $foreign_file"
  git -C "$lane" reset --soft HEAD^
  git -C "$lane" diff --cached --name-only --diff-filter=A | grep -Fxq "$own_file" || fail "$lane did not restore $own_file"
  test ! -e "$lane/$foreign_file" || fail "$lane restored foreign file $foreign_file"
}

scratch_and_restore "$lane_one" one.txt two.txt &
pid_one=$!
scratch_and_restore "$lane_two" two.txt one.txt &
pid_two=$!
wait "$pid_one"
wait "$pid_two"
echo "PASS: two concurrent lanes restored only their own scratch-committed files"

bad_out="$fixture_root/bad.out"
printf 'bad path\n' > "$repo/stashed.txt"
git -C "$repo" add stashed.txt
git -C "$repo" stash push -m collision-fixture >/dev/null
if "$checker" "$repo" >"$bad_out" 2>&1; then
  fail "checker accepted refs/stash with multiple worktrees"
fi
grep -Fq 'hazard=refs/stash-is-repo-global' "$bad_out" || fail "checker did not name the shared refs/stash hazard"
grep -Fq 'scratch commit' "$bad_out" || fail "checker did not name the safe alternative"
cat "$bad_out"
echo "PASS: checker rejects a shared stash and names the collision and safe alternative"
