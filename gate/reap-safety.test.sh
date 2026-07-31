#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck source=gate/land-lib.sh
source "$root/gate/land-lib.sh"

fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
git -C "$fixture" init -q -b main
git -C "$fixture" config user.name Test
git -C "$fixture" config user.email test@example.test
printf 'base\n' > "$fixture/base.txt"
git -C "$fixture" add base.txt
git -C "$fixture" commit -qm base
git -C "$fixture" branch merged
printf 'main\n' > "$fixture/main.txt"
git -C "$fixture" add main.txt
git -C "$fixture" commit -qm main
main_sha=$(git -C "$fixture" rev-parse main)

land_assert_reap_safe "$fixture" merged "$main_sha" TEST > "$fixture/merged.out"
grep -Fq 'safety=pass branch=merged carried-by=' "$fixture/merged.out"

git -C "$fixture" checkout -qb unique merged
printf 'unique\n' > "$fixture/unique.txt"
git -C "$fixture" add unique.txt
git -C "$fixture" commit -qm unique
git -C "$fixture" checkout -q main
if land_assert_reap_safe "$fixture" unique "$main_sha" TEST > "$fixture/unique.out" 2>&1; then
  echo 'unique branch was incorrectly declared safe to reap' >&2
  exit 1
fi
grep -Fq 'safety=refused branch=unique detail=unique-content' "$fixture/unique.out"
git -C "$fixture" show-ref --verify --quiet refs/heads/unique

# A patch carried by a different commit is safe even though the lane commit is
# not an ancestor of main (the historical fix-import-signs shape).
git -C "$fixture" checkout -qb equivalent merged
printf 'equivalent\n' > "$fixture/equivalent.txt"
git -C "$fixture" add equivalent.txt
git -C "$fixture" commit -qm lane-equivalent
equivalent_sha=$(git -C "$fixture" rev-parse HEAD)
git -C "$fixture" checkout -q main
git -C "$fixture" cherry-pick "$equivalent_sha" >/dev/null
main_sha=$(git -C "$fixture" rev-parse main)
if git -C "$fixture" merge-base --is-ancestor equivalent "$main_sha"; then
  echo 'equivalent fixture unexpectedly became an ancestor' >&2
  exit 1
fi
land_assert_reap_safe "$fixture" equivalent "$main_sha" TEST > "$fixture/equivalent.out"
grep -Fq 'safety=pass branch=equivalent carried-by=' "$fixture/equivalent.out"

# Uncommitted and untracked lane work must block deletion.
dirty_worktree="$fixture-dirty"
git -C "$fixture" worktree add -q "$dirty_worktree" equivalent
printf 'uncommitted\n' > "$dirty_worktree/uncommitted.txt"
if land_assert_reap_safe "$fixture" equivalent "$main_sha" TEST > "$fixture/dirty.out" 2>&1; then
  echo 'dirty worktree was incorrectly declared safe to reap' >&2
  exit 1
fi
grep -Fq 'safety=refused branch=equivalent detail=dirty-worktree' "$fixture/dirty.out"
git -C "$fixture" worktree remove --force "$dirty_worktree"

# A remote branch without a local ref cannot be inspected completely and is
# retained fail-closed.
remote="$fixture-remote.git"
git init -q --bare "$remote"
git -C "$fixture" remote add origin "$remote"
git -C "$fixture" push -q origin unique
git -C "$fixture" branch -D unique >/dev/null
if land_assert_reap_safe "$fixture" unique "$main_sha" TEST > "$fixture/remote-only.out" 2>&1; then
  echo 'remote-only branch was incorrectly declared safe to reap' >&2
  exit 1
fi
grep -Fq 'safety=refused branch=unique detail=remote-only' "$fixture/remote-only.out"
git --git-dir="$remote" show-ref --verify --quiet refs/heads/unique

echo 'reap safety tests: pass'
