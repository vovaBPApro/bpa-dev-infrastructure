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

echo 'reap safety tests: pass'
