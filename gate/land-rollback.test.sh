#!/usr/bin/env bash
# V3-0.3 regression lock: an aborted landing must leave the target ref and
# working tree exactly as they were, for every abort path that follows a
# successful merge -- not only the happy-path case the existing land.test.sh
# "verify-fail" fixture covers (a self-contained verify command with no side
# effects, where a plain `git reset --hard ORIG_HEAD` always succeeds).
#
# Observed defect (2026-08-03, twice): gate/land.sh printed
# "LAND post-merge-verify failure: merge reset to ORIG_HEAD" and
# "LAND verdict=aborted", yet local main sat ADVANCED at the merge commit and
# the working tree was dirty. Root cause: `git reset --hard ORIG_HEAD` can
# fail (this repo's gate scripts run under `set -u`/`pipefail`, never
# `set -e`), and land.sh did not check the reset's exit status before
# declaring the rollback done. A coder-authored `verify:` command (trusted
# only to run, never to behave) that spawns a git process which is killed or
# still alive when the gate reads its exit status leaves a stale
# $GIT_DIR/index.lock behind; every subsequent `git reset --hard` in that
# checkout then fails the same way, silently, forever.
#
# These fixtures reproduce that exact mechanism deterministically instead of
# depending on background-process timing.
set -u
set -o pipefail

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
land="$root/gate/land.sh"
# The lane itself can inherit TMPDIR below /root, whose parent directories are
# not traversable by the dropped-privilege actor used in fixture 6. Put the
# fixture under the system temporary directory, just as hygiene/reap.test.ts's
# privilege fixture does, so chmod on the named fixture can establish the
# whole traversal precondition instead of being defeated by an ancestor.
fixture_root=$(env -u TMPDIR -u TMP -u TEMP mktemp -d)
cleanup() {
  # Some fixtures below chattr +i a file to make a rollback genuinely
  # unrecoverable; clear that before the trap tries to rm -rf the fixture.
  find "$fixture_root" -name index.lock -exec chattr -i {} + 2>/dev/null || true
  rm -rf "$fixture_root"
}
trap cleanup EXIT

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
  assert grep -Fq "$2" "$1"
}

assert_output_lacks() {
  assert_not grep -Fq "$2" "$1"
}

capability_forced_missing() {
  [[ ",${INFRA_TEST_FORCE_MISSING_CAPABILITIES:-}," == *",$1,"* ]]
}

make_fixture() {
  name="$1"
  bare="$fixture_root/$name-origin.git"
  repo="$fixture_root/$name-repo"
  git init --bare --initial-branch=main "$bare" >/dev/null
  git clone "$bare" "$repo" >/dev/null
  git -C "$repo" config user.email land@example.test
  git -C "$repo" config user.name Land
  env -u BUN_BIN bun "$root/gate/review-rounds.ts" init --state "$repo/.git/bpa-review-rounds.json" --cap 3 --no-progress-limit 3 >/dev/null
  printf 'base\n' > "$repo/base.txt"
  printf 'import { test, expect } from "bun:test"; test("fixture", () => expect(true).toBe(true));\n' > "$repo/base.test.ts"
  git -C "$repo" add base.txt base.test.ts
  git -C "$repo" commit -m base >/dev/null
  git -C "$repo" push -u origin main >/dev/null
  printf 'ref: refs/heads/main\n' > "$bare/HEAD"
}

make_lane() {
  repo="$1"
  lane="$2"
  git -C "$repo" checkout -b "$lane" >/dev/null
  printf 'lane\n' > "$repo/lane.txt"
  git -C "$repo" add lane.txt
  git -C "$repo" commit -m lane >/dev/null
  sha=$(git -C "$repo" rev-parse HEAD)
  git -C "$repo" checkout main >/dev/null
  printf '%s\n' "$sha"
}

report() {
  path="$1"
  sha="$2"
  verify="$3"
  printf 'commit: %s fixture\nverify: %s\nresult: clean\nsecret-scan: clean\nremaining: none\n' "$sha" "$verify" > "$path"
}

# --- 1. Recoverable stale index.lock at post-merge-verify -----------------
# The verify command leaves a lock file behind (as an interrupted/backgrounded
# git child of a real verify command would) and then fails. Before the fix,
# the inline `git reset --hard ORIG_HEAD` failed on this lock, the failure was
# swallowed, and main stayed advanced. After the fix, land_force_reset clears
# the stale lock -- safe because land.sh holds its own exclusive flock on this
# repo for the whole run, so no concurrent land.sh instance could be the
# lock's legitimate owner -- retries, and verifies main lands back exactly
# where it started, with a clean tree.
make_fixture stale-lock
lane_sha=$(make_lane "$fixture_root/stale-lock-repo" ag-stale-lock)
before=$(git -C "$fixture_root/stale-lock-repo" rev-parse main)
report "$fixture_root/stale-lock-report.md" "$lane_sha" 'touch .git/index.lock; exit 1'
out="$fixture_root/stale-lock-out.txt"
if "$land" --branch ag-stale-lock --item-id ag-stale-lock --report "$fixture_root/stale-lock-report.md" --repo "$fixture_root/stale-lock-repo" --run-verify --no-push >"$out" 2>&1; then
  echo 'stale-lock: gate accepted a failing verify command' >&2
  exit 1
fi
assert_output_has "$out" 'LAND step=post-merge-verify status=fail'
assert_output_has "$out" 'LAND verdict=aborted sha=none'
assert test "$(git -C "$fixture_root/stale-lock-repo" rev-parse main)" = "$before"
assert test "$(git -C "$fixture_root/stale-lock-repo" rev-parse HEAD)" = "$before"
assert test -z "$(git -C "$fixture_root/stale-lock-repo" status --porcelain)"
assert git -C "$fixture_root/stale-lock-repo" show-ref --verify --quiet refs/heads/ag-stale-lock

# --- 2. Same mechanism, different abort path: post-merge declared-checks --
# "for every abort path, not only this one." The post-merge declared-checks
# step (package.json "test") leaves the same stale lock and then fails; the
# rollback must still land main back at its pre-merge commit.
make_fixture stale-lock-declared
git -C "$fixture_root/stale-lock-declared-repo" checkout -b ag-stale-lock-declared >/dev/null
printf '{"scripts":{"test":"touch .git/index.lock && false"}}\n' > "$fixture_root/stale-lock-declared-repo/package.json"
git -C "$fixture_root/stale-lock-declared-repo" add package.json
git -C "$fixture_root/stale-lock-declared-repo" commit -m declared-stale-lock >/dev/null
declared_sha=$(git -C "$fixture_root/stale-lock-declared-repo" rev-parse HEAD)
git -C "$fixture_root/stale-lock-declared-repo" checkout main >/dev/null
declared_before=$(git -C "$fixture_root/stale-lock-declared-repo" rev-parse main)
report "$fixture_root/stale-lock-declared-report.md" "$declared_sha" true
declared_out="$fixture_root/stale-lock-declared-out.txt"
if "$land" --branch ag-stale-lock-declared --item-id ag-stale-lock-declared --report "$fixture_root/stale-lock-declared-report.md" --repo "$fixture_root/stale-lock-declared-repo" --no-push >"$declared_out" 2>&1; then
  echo 'stale-lock-declared: gate accepted a failing declared test script' >&2
  exit 1
fi
assert_output_has "$declared_out" 'LAND step=declared-checks status=fail'
assert_output_has "$declared_out" 'LAND verdict=aborted sha=none'
assert test "$(git -C "$fixture_root/stale-lock-declared-repo" rev-parse main)" = "$declared_before"
assert test -z "$(git -C "$fixture_root/stale-lock-declared-repo" status --porcelain)"

# --- 3. Genuinely unrecoverable lock: the gate must not lie ---------------
# chattr +i makes the lock file immutable -- even root cannot rm it -- so
# land_force_reset's clear-and-retry cannot succeed, ever. This is the case
# the fix must handle honestly: report contract says "aborted" means the ref
# did not move, so when the gate cannot prove that, it must say something
# else, never "verdict=aborted".
immutable_probe="$fixture_root/immutable-probe"
touch "$immutable_probe"
if ! capability_forced_missing immutable-file && chattr +i "$immutable_probe" 2>/dev/null; then
  chattr -i "$immutable_probe"
  make_fixture unrecoverable-lock
  unrecoverable_sha=$(make_lane "$fixture_root/unrecoverable-lock-repo" ag-unrecoverable-lock)
  unrecoverable_before=$(git -C "$fixture_root/unrecoverable-lock-repo" rev-parse main)
  report "$fixture_root/unrecoverable-lock-report.md" "$unrecoverable_sha" 'touch .git/index.lock; chattr +i .git/index.lock; exit 1'
  unrecoverable_out="$fixture_root/unrecoverable-lock-out.txt"
  if "$land" --branch ag-unrecoverable-lock --item-id ag-unrecoverable-lock --report "$fixture_root/unrecoverable-lock-report.md" --repo "$fixture_root/unrecoverable-lock-repo" --run-verify --no-push >"$unrecoverable_out" 2>&1; then
    echo 'unrecoverable-lock: gate reported success despite an unrecoverable rollback' >&2
    exit 1
  fi
  assert_output_has "$unrecoverable_out" 'LAND verdict=rollback-failed'
  assert_output_lacks "$unrecoverable_out" 'LAND verdict=aborted'
  chattr -i "$fixture_root/unrecoverable-lock-repo/.git/index.lock" 2>/dev/null || true
else
  echo 'land-rollback: EXCLUDED case=unrecoverable-lock capability=immutable-file'
fi

# --- 4. Defect 1 (review round 2): a live lock must never be deleted ------
# The verify: command's own child is still alive and holds an open fd on
# .git/index.lock when land.sh reaches rollback -- the "still running" half
# of the mechanism this file's own comments name as the root cause, and the
# one case an unconditional `rm -f` cannot tell apart from genuine debris.
# setsid detaches the lock-holder into its own session so it survives past
# the verify: command's own exit, the way an orphaned real git child would.
# land_force_reset must find it live via /proc, refuse to delete it, and
# report `verdict=rollback-failed` -- never a false `verdict=aborted` -- while
# leaving main exactly where the (necessarily failed) reset left it.
proc_lock_probe="$fixture_root/proc-lock-probe"
exec {proc_lock_probe_fd}>"$proc_lock_probe"
flock "$proc_lock_probe_fd"
proc_lock_probe_inode="$(stat -Lc '%i' "$proc_lock_probe")"
proc_locks_visible=false
if ! capability_forced_missing proc-lock-observability && awk -v inode="$proc_lock_probe_inode" '
  $2 == "FLOCK" { split($6, key, ":"); if (key[3] == inode) found = 1 }
  END { exit(found ? 0 : 1) }
' /proc/locks; then
  proc_locks_visible=true
fi
exec {proc_lock_probe_fd}>&-

if "$proc_locks_visible"; then
  make_fixture live-lock
  live_lock_sha=$(make_lane "$fixture_root/live-lock-repo" ag-live-lock)
  live_lock_before=$(git -C "$fixture_root/live-lock-repo" rev-parse main)
  live_lock_cmd='setsid sh -c "exec 8>.git/index.lock; sleep 20" </dev/null >/dev/null 2>&1 & sleep 0.3; exit 1'
  report "$fixture_root/live-lock-report.md" "$live_lock_sha" "$live_lock_cmd"
  live_lock_out="$fixture_root/live-lock-out.txt"
  if "$land" --branch ag-live-lock --item-id ag-live-lock --report "$fixture_root/live-lock-report.md" --repo "$fixture_root/live-lock-repo" --run-verify --no-push >"$live_lock_out" 2>&1; then
    echo 'live-lock: gate reported success while a live process held the lock' >&2
    exit 1
  fi
  assert_output_has "$live_lock_out" 'LAND verdict=rollback-failed'
  assert_output_lacks "$live_lock_out" 'LAND verdict=aborted'
  # The lock was genuinely live, so recovery was genuinely impossible: main
  # must still show the (unrecovered) advance, proving nothing was deleted out
  # from under the live holder to force a false recovery.
  assert_not test "$(git -C "$fixture_root/live-lock-repo" rev-parse main)" = "$live_lock_before"
else
  echo 'land-rollback: EXCLUDED case=live-lock capability=proc-lock-observability'
fi

# --- 5. Defect 2 (review round 2): HEAD-only verification misses a dirty --
#        tree left behind by a reset that otherwise fully succeeded.
# No lock is involved here: `git reset --hard` runs clean on the first try
# and HEAD lands exactly on the pre-merge commit -- but reset --hard never
# removes untracked debris, and the failing verify: command left an untracked
# file behind. HEAD-equality alone would call this a clean rollback; it is
# not, and the observed production defect's own symptom ("git status showed
# staged deletions") was exactly this axis, not ref position.
make_fixture dirty-tree
dirty_sha=$(make_lane "$fixture_root/dirty-tree-repo" ag-dirty-tree)
dirty_before=$(git -C "$fixture_root/dirty-tree-repo" rev-parse main)
report "$fixture_root/dirty-tree-report.md" "$dirty_sha" 'echo leftover > untracked-debris.txt; exit 1'
dirty_out="$fixture_root/dirty-tree-out.txt"
if "$land" --branch ag-dirty-tree --item-id ag-dirty-tree --report "$fixture_root/dirty-tree-report.md" --repo "$fixture_root/dirty-tree-repo" --run-verify --no-push >"$dirty_out" 2>&1; then
  echo 'dirty-tree: gate reported success while an untracked file survived rollback' >&2
  exit 1
fi
assert_output_has "$dirty_out" 'LAND verdict=rollback-failed'
assert_output_lacks "$dirty_out" 'LAND verdict=aborted'
assert test "$(git -C "$fixture_root/dirty-tree-repo" rev-parse main)" = "$dirty_before"
assert test -n "$(git -C "$fixture_root/dirty-tree-repo" status --porcelain)"

# --- 6. Defect (review round 3): an unreadable /proc/<pid>/fd must never --
#        glob away silently into "stale".
# land_lock_is_stale scans /proc/<pid>/fd for every candidate pid. If a
# candidate's fd/ directory cannot be read (mode 0700, owned by a UID the
# scanner is not running as -- e.g. a root-owned process left by a verify:
# step that used sudo or Docker, scanned by a non-root land.sh, or the
# reverse), bash's glob for that pid's fd/* contributes nothing, silently:
# no error, no non-zero status. The pre-round-3 code walked the combined glob
# `/proc/[0-9]*/fd/*` and never noticed a candidate it could not see, so it
# reported "stale" for a lock that was genuinely live.
#
# End-to-end note: reproducing this through gate/land.sh's own CLI entry
# point was attempted and abandoned for this environment. Dropping privilege
# for Bun (tried via both `setpriv` and `su`) leaves `process.env.PATH`
# unset inside the Bun runtime here, so completion-guard.ts's own `git`
# subprocess spawn fails with EACCES before a landing ever reaches the
# rollback step -- a property of this sandbox's Bun runtime under a dropped
# UID, not of gate/land.sh, and it blocks testing *through the CLI*
# specifically, not the property itself. This fixture instead calls
# land_force_reset directly -- the exact function gate/land.sh's rollback
# paths call, not a reimplementation of it -- while a lock is held open by a
# root-owned process and land_force_reset runs as `nobody`, the UID the
# scanner cannot inspect. Confirmed against the pre-fix function: it deleted
# the live lock and returned success (exit 0). The fix must refuse, leave
# the lock in place, and return failure.
if ! "$proc_locks_visible"; then
  echo 'land-rollback: EXCLUDED case=uid-fd-visibility capability=proc-lock-observability'
elif ! command -v setpriv >/dev/null 2>&1 || ! id nobody >/dev/null 2>&1; then
  echo 'uid-fd-visibility: SKIPPED (setpriv or the nobody user is unavailable in this environment)'
else
  # Lives under $fixture_root (not a separate mktemp -d) so the trap-driven
  # cleanup() sweeps it -- including its now-nobody-owned contents, which
  # root can still remove -- even if an assertion below exits early.
  uid_fixture="$fixture_root/uid-fixture"
  mkdir -p "$uid_fixture"
  chmod 777 "$uid_fixture"
  # $fixture_root itself is 700 (mktemp -d default); grant search-only
  # access so `nobody` can traverse down into $uid_fixture without gaining
  # any visibility into the other (root-owned) fixtures alongside it.
  chmod o+x "$fixture_root"
  uid_repo="$uid_fixture/repo"
  mkdir -p "$uid_repo"
  git init -q --initial-branch=main "$uid_repo"
  git -C "$uid_repo" config user.email land@example.test
  git -C "$uid_repo" config user.name Land
  printf 'base\n' > "$uid_repo/base.txt"
  git -C "$uid_repo" add base.txt
  git -C "$uid_repo" commit -qm base
  uid_pre_merge_sha=$(git -C "$uid_repo" rev-parse HEAD)
  printf 'advanced\n' > "$uid_repo/advanced.txt"
  git -C "$uid_repo" add advanced.txt
  git -C "$uid_repo" commit -qm advanced
  uid_advanced_sha=$(git -C "$uid_repo" rev-parse HEAD)

  # land-lib.sh in this checkout is mode 700 (root-only); `nobody` cannot
  # source it in place, so a readable copy travels with the rest of the
  # nobody-owned fixture instead of chmod'ing the tracked file.
  uid_lib_copy="$uid_fixture/land-lib.sh"
  cp "$root/gate/land-lib.sh" "$uid_lib_copy"
  uid_home="$uid_fixture/home"
  mkdir -p "$uid_home"
  printf '[safe]\n\tdirectory = *\n' > "$uid_home/.gitconfig"
  chown -R nobody:nogroup "$uid_fixture"
  chmod 644 "$uid_lib_copy"

  # Root-owned lock holder, started only after the fixture is handed to
  # nobody, so its /proc/<pid>/fd is exactly the kind of directory the
  # scanning (nobody) side cannot list.
  uid_lock="$uid_repo/.git/index.lock"
  setsid sh -c "exec 8>'$uid_lock'; sleep 20" </dev/null >/dev/null 2>&1 &
  uid_holder_pid=$!
  sleep 0.3

  uid_driver="$uid_fixture/driver.sh"
  {
    printf 'source "%s"\n' "$uid_lib_copy"
    printf 'land_force_reset "%s" "%s"\n' "$uid_repo" "$uid_pre_merge_sha"
    printf 'echo "RESULT_EXIT=$?"\n'
  } > "$uid_driver"
  chmod 644 "$uid_driver"
  chown nobody:nogroup "$uid_driver"

  uid_out="$uid_fixture/out.txt"
  if ! setpriv --reuid=65534 --regid=65534 --clear-groups \
    test -r "$uid_lib_copy" -a -r "$uid_driver" -a -x "$uid_repo"; then
    echo 'uid-fd-visibility: fixture setup failed: dropped-privilege actor cannot traverse/read fixture inputs' >&2
    exit 1
  fi
  setpriv --reuid=65534 --regid=65534 --clear-groups env HOME="$uid_home" \
    bash "$uid_driver" > "$uid_out" 2>&1

  kill "$uid_holder_pid" 2>/dev/null

  if ! grep -Fq 'RESULT_EXIT=1' "$uid_out"; then
    echo 'uid-fd-visibility: fixture failed before the subject assertion' >&2
    cat "$uid_out" >&2
    exit 1
  fi
  assert test -e "$uid_lock"
  assert test "$(git -c safe.directory='*' -C "$uid_repo" rev-parse HEAD)" = "$uid_advanced_sha"

  rm -rf "$uid_fixture"
fi

# --- 7. Defect (review round 4): the fix for round 3 must not turn every ---
#        non-root scan into a permanent refusal.
# Requiring `[ -r "$fd_dir" ]` for EVERY pid (round 3's fix) closed the live-
# lock hole, but it fails closed on any unreadable pid, not only ones that
# could plausibly hold the lock -- and on a real host, most pids belong to
# other users. Scanning as a non-root uid against a lock file NO process
# holds still returned "not stale" every time, because the loop gave up on
# the first foreign-uid pid it could not inspect. land_force_reset's
# recovery branch was dead code for every non-root invocation.
#
# The fix scopes the readability requirement to pids that could plausibly
# hold the lock -- owned by root or by the scanner's own EUID, the only two
# identities that could have opened a file inside this repo's .git directory
# -- and skips (continues past) any other, unrelated uid instead of failing
# the whole check closed for it.
#
# A real host's ambient process mix is not a controlled variable (this
# sandbox alone has 200+ pids, mostly root-owned, and root pids are legitimate
# must-check candidates under the fix above, not skippable) so this fixture
# runs inside `unshare --pid --mount-proc --fork`: a fresh, otherwise-empty
# pid namespace where the process doing the scan is pid 1 itself, holding
# nothing relevant, plus one deliberately-added bystander owned by a THIRD,
# unrelated uid (daemon, uid 1) that the scan must skip rather than choke on.
# This is the same real land_lock_is_stale as fixture 6, exercised under the
# opposite condition: nothing plausible holds the lock, so it must clear.
if capability_forced_missing pid-mount-namespace || ! unshare --pid --mount-proc --fork true >/dev/null 2>&1; then
  echo 'land-rollback: EXCLUDED case=uid-dead-code capability=pid-mount-namespace'
elif ! command -v setpriv >/dev/null 2>&1 || ! id nobody >/dev/null 2>&1; then
  echo 'uid-dead-code: SKIPPED (unshare, setpriv, or the nobody user is unavailable in this environment)'
else
  deadcode_fixture="$fixture_root/deadcode-fixture"
  mkdir -p "$deadcode_fixture"
  chmod 777 "$deadcode_fixture"
  chmod o+x "$fixture_root"
  deadcode_lock="$deadcode_fixture/index.lock"
  touch "$deadcode_lock"
  chmod 666 "$deadcode_lock"

  deadcode_lib_copy="$deadcode_fixture/land-lib.sh"
  cp "$root/gate/land-lib.sh" "$deadcode_lib_copy"
  chmod 644 "$deadcode_lib_copy"

  deadcode_driver="$deadcode_fixture/driver.sh"
  {
    printf 'source "%s"\n' "$deadcode_lib_copy"
    printf 'if land_lock_is_stale "%s"; then\n' "$deadcode_lock"
    printf '  echo "RESULT: STALE"\n'
    printf 'else\n'
    printf '  echo "RESULT: NOT_STALE"\n'
    printf 'fi\n'
  } > "$deadcode_driver"
  chmod 644 "$deadcode_driver"

  deadcode_out="$deadcode_fixture/out.txt"
  unshare --pid --mount-proc --fork -- bash -c '
    setpriv --reuid=1 --regid=1 --clear-groups sleep 15 </dev/null >/dev/null 2>&1 &
    sleep 0.2
    exec setpriv --reuid=nobody --regid=nogroup --clear-groups bash "'"$deadcode_driver"'"
  ' > "$deadcode_out" 2>&1

  assert_output_has "$deadcode_out" 'RESULT: STALE'
  assert_output_lacks "$deadcode_out" 'RESULT: NOT_STALE'

  rm -rf "$deadcode_fixture"
fi

echo 'land rollback tests: pass'
