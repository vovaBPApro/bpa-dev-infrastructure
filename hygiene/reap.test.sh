#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scratch_root='/tmp/claude-1000/-home-bpa-shell/c0d3fe14-9341-4751-94a9-07a28e7dd2a7/scratchpad'
mkdir -p "$scratch_root"
fixture="$(mktemp -d "$scratch_root/hygiene-test.XXXXXX")"
trap 'rm -rf -- "$fixture"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
assert_exists() { [[ -e "$1" ]] || fail "expected to exist: $1"; }
assert_missing() { [[ ! -e "$1" ]] || fail "expected to be absent: $1"; }
assert_contains() { grep -Fq -- "$2" "$1" || fail "missing output: $2"; }

repo="$fixture/repo"
merged_wt="$fixture/merged-wt"
orphan_wt="$fixture/orphan-wt"
junk_root="$fixture/junk"
git init -q -b main "$repo"
git -C "$repo" config user.email hygiene@example.test
git -C "$repo" config user.name Hygiene
printf 'base\n' > "$repo/base.txt"
git -C "$repo" add base.txt
git -C "$repo" commit -qm base
git -C "$repo" worktree add -q -b merged "$merged_wt"
git -C "$repo" worktree add -q -b orphan "$orphan_wt"
rm -rf -- "$orphan_wt"
git -C "$repo" checkout -qb unmerged
printf 'unmerged\n' > "$repo/unmerged.txt"
git -C "$repo" add unmerged.txt
GIT_AUTHOR_DATE='2000-01-01T00:00:00Z' GIT_COMMITTER_DATE='2000-01-01T00:00:00Z' git -C "$repo" commit -qm unmerged
git -C "$repo" checkout -q main

mkdir -p "$junk_root/a/__pycache__" "$junk_root/tmp-worktrees"
touch "$junk_root/a/__pycache__/cache.pyc" "$junk_root/tmp-worktrees/stale"
touch -d '40 days ago' "$junk_root/old.log"
touch "$junk_root/new.log"

before_help="$(find "$fixture" -printf '%P:%s:%TY-%Tm-%Td-%TH:%TM:%TS\n' | sort)"
"$script_dir/reap.sh" --help > /dev/null
after_help="$(find "$fixture" -printf '%P:%s:%TY-%Tm-%Td-%TH:%TM:%TS\n' | sort)"
[[ "$before_help" == "$after_help" ]] || fail '--help changed the fixture'

"$script_dir/reap.sh" branches --repo "$repo" --stale-days 30 > "$fixture/branches-dry.out"
"$script_dir/reap.sh" worktrees --repo "$repo" > "$fixture/worktrees-dry.out"
"$script_dir/reap.sh" disk --root "$junk_root" --stale-days 30 > "$fixture/disk-dry.out"
assert_contains "$fixture/branches-dry.out" 'merged branch: merged'
assert_contains "$fixture/branches-dry.out" 'unmerged stale branch (report-only): unmerged'
assert_contains "$fixture/worktrees-dry.out" 'orphaned worktree metadata:'
assert_contains "$fixture/disk-dry.out" 'known junk (__pycache__)'
assert_exists "$merged_wt"
git -C "$repo" show-ref --verify --quiet refs/heads/merged
git -C "$repo" show-ref --verify --quiet refs/heads/unmerged
git -C "$repo" worktree list --porcelain | grep -Fq "worktree $orphan_wt" || fail 'dry run pruned orphan metadata'
assert_exists "$junk_root/a/__pycache__"
assert_exists "$junk_root/old.log"

"$script_dir/reap.sh" branches --repo "$repo" --stale-days 30 --apply > "$fixture/branches-apply.out"
"$script_dir/reap.sh" worktrees --repo "$repo" --apply > "$fixture/worktrees-apply.out"
"$script_dir/reap.sh" disk --root "$junk_root" --stale-days 30 --apply > "$fixture/disk-apply.out"
assert_missing "$merged_wt"
! git -C "$repo" show-ref --verify --quiet refs/heads/merged || fail 'merged branch survived apply'
git -C "$repo" show-ref --verify --quiet refs/heads/unmerged
! git -C "$repo" worktree list --porcelain | grep -Fq "worktree $orphan_wt" || fail 'orphan metadata survived apply'
assert_missing "$junk_root/a/__pycache__"
assert_missing "$junk_root/tmp-worktrees"
assert_missing "$junk_root/old.log"
assert_exists "$junk_root/new.log"

fake_crontab="$fixture/fake-crontab"
cron_file="$fixture/crontab"
# shellcheck disable=SC2016 # Variables are intentionally expanded by the fake cron process.
printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' \
  'if [[ "${1:-}" == "-l" ]]; then [[ -f "$FAKE_CRONTAB_FILE" ]] && cat "$FAKE_CRONTAB_FILE"; else cp "$1" "$FAKE_CRONTAB_FILE"; fi' > "$fake_crontab"
chmod +x "$fake_crontab"
printf '%s\n' 'MAILTO=hygiene@example.test' > "$cron_file"
FAKE_CRONTAB_FILE="$cron_file" CRONTAB_CMD="$fake_crontab" HYGIENE_LOG_DIR="$fixture/cron-logs" "$script_dir/install-cron.sh" > "$fixture/cron-install.out"
assert_contains "$cron_file" '# BEGIN bpa-dev-infrastructure hygiene'
assert_contains "$cron_file" 'MAILTO=hygiene@example.test'
cron_first="$(cksum "$cron_file")"
FAKE_CRONTAB_FILE="$cron_file" CRONTAB_CMD="$fake_crontab" HYGIENE_LOG_DIR="$fixture/cron-logs" "$script_dir/install-cron.sh" > /dev/null
[[ "$cron_first" == "$(cksum "$cron_file")" ]] || fail 'cron install was not deterministic'
FAKE_CRONTAB_FILE="$cron_file" CRONTAB_CMD="$fake_crontab" "$script_dir/install-cron.sh" --uninstall > "$fixture/cron-uninstall.out"
! grep -Fq '# BEGIN bpa-dev-infrastructure hygiene' "$cron_file" || fail 'cron uninstall left managed block'
assert_contains "$cron_file" 'MAILTO=hygiene@example.test'

if command -v shellcheck >/dev/null 2>&1; then
  shellcheck "$script_dir/reap.sh" "$script_dir/install-cron.sh" "$script_dir/reap.test.sh"
  shellcheck_result='shellcheck clean'
else
  shellcheck_result='shellcheck skipped: command unavailable (optional local lint dependency)'
  printf 'SKIP: %s\n' "$shellcheck_result"
fi
echo "PASS: help is side-effect-free; dry-run preserved fixture; apply removed only merged/orphaned/known junk; cron is deterministic; $shellcheck_result"
