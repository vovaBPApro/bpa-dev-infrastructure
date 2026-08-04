#!/usr/bin/env bash
# Locks V3-0.47: bookkeeping pushes must stop aborting landings, WITHOUT
# weakening the property that a landing may only publish a tree it measured.
#
# Fail-before evidence for every lock here is the pre-fix gate:
#   - before freshness  -> `LAND step=freshness status=fail`, exit 2, and an
#     operator hand-running `git merge --ff-only` on the shared canonical
#     checkout (V3-0.15, V3-0.29 round 4, V3-0.23 round 3);
#   - between freshness and merge -> `LAND review-rounds
#     attempt-persist-mismatch`, which fired only AFTER the attempt refs were
#     pushed to origin, durably spending one of the item's three review rounds;
#   - between merge and push -> `LAND step=push status=fail` after the full
#     ten-minute chain, with no statement of the cause (V3-1.9a).
#
# The tests below assert the new behavior at all three positions, that a
# genuinely stale target and a genuinely stale lane are still refused, and that
# the fence cannot be used to publish anything the landing gate would have
# required a review for.
set -u
set -o pipefail

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
land="$root/gate/land.sh"
fence="$root/gate/bookkeeping-push.sh"
fixture_root=$(mktemp -d)
trap 'rm -rf "$fixture_root"' EXIT
mkdir -p "$fixture_root/fake-bin"
printf '#!/usr/bin/env bash\ntest "$1" = info\n' > "$fixture_root/fake-bin/docker"
chmod +x "$fixture_root/fake-bin/docker"
export PATH="$fixture_root/fake-bin:$PATH"

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
  if ! grep -Fq "$2" "$1"; then
    echo "expected '$2' in $1" >&2
    sed -e 's/^/  | /' "$1" >&2
    exit 1
  fi
}

# Always dump the captured gate output on a status mismatch: the fixture root
# is removed on exit, so a bare "expected 0, got 2" would be undiagnosable.
assert_status() {
  if [ "$1" -ne "$2" ]; then
    echo "expected exit $2, got $1" >&2
    sed -e 's/^/  | /' "$3" >&2
    exit 1
  fi
}

assert_status_not() {
  if [ "$1" -eq "$2" ]; then
    echo "expected exit != $2" >&2
    sed -e 's/^/  | /' "$3" >&2
    exit 1
  fi
}

assert_output_lacks() {
  if grep -Fq "$2" "$1"; then
    echo "unexpected '$2' in $1" >&2
    sed -e 's/^/  | /' "$1" >&2
    exit 1
  fi
}

# A bare origin, a canonical checkout (the shared land-main analogue), and a
# SECOND clone that plays the orchestrator's bookkeeping writer. Two clones is
# the point: the writer must be able to move origin without touching the
# canonical checkout, which is exactly the production shape.
make_fixture() {
  name="$1"
  bare="$fixture_root/$name-origin.git"
  repo="$fixture_root/$name-repo"
  writer="$fixture_root/$name-writer"
  git init --bare --initial-branch=main "$bare" >/dev/null
  git clone "$bare" "$repo" >/dev/null 2>&1
  git -C "$repo" config user.email land@example.test
  git -C "$repo" config user.name Land
  printf 'base\n' > "$repo/base.txt"
  printf 'import { test, expect } from "bun:test"; test("fixture", () => expect(true).toBe(true));\n' > "$repo/base.test.ts"
  mkdir -p "$repo/hygiene" "$repo/instance/parked" "$repo/gate" "$repo/meteorite"
  cp "$root/hygiene/check-retained-branches.ts" "$repo/hygiene/check-retained-branches.ts"
  printf 'main\n' > "$repo/instance/hygiene-protected-branches.txt"
  printf '| row | active |\n' > "$repo/instance/workboard.md"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$repo/gate/keep.sh"
  sed -n '/^# BEGIN TRUSTED TEST PROVER$/,/^# END TRUSTED TEST PROVER$/p' "$root/gate/land.test.sh" | sed '1d;$d' > "$repo/meteorite/prove-candidate.sh"
  chmod +x "$repo/meteorite/prove-candidate.sh" "$repo/gate/keep.sh"
  git -C "$repo" add base.txt base.test.ts hygiene/check-retained-branches.ts instance gate/keep.sh meteorite/prove-candidate.sh
  git -C "$repo" commit -m base >/dev/null
  git -C "$repo" push -u origin main >/dev/null 2>&1
  printf 'ref: refs/heads/main\n' > "$bare/HEAD"
  git clone "$bare" "$writer" >/dev/null 2>&1
  git -C "$writer" config user.email book@example.test
  git -C "$writer" config user.name Book
}

# One bookkeeping commit, published from the writer clone straight to origin --
# the exact write pattern this row exists to make survivable.
writer_push() {
  name="$1"
  text="$2"
  writer="$fixture_root/$name-writer"
  git -C "$writer" fetch origin >/dev/null 2>&1 || return 1
  git -C "$writer" reset --hard origin/main >/dev/null 2>&1 || return 1
  printf '| %s | active |\n' "$text" >> "$writer/instance/workboard.md"
  git -C "$writer" add instance/workboard.md
  git -C "$writer" commit -m "[ORCH] $text" >/dev/null || return 1
  git -C "$writer" push origin main >/dev/null 2>&1
}

# The same write, wrapped as a report `verify:` command. gate/completion-guard.ts
# runs `verify:` when the gate is invoked WITHOUT --run-verify, and gate/land.sh
# runs it post-merge/pre-push WITH --run-verify. One hook, both interior
# positions, deterministically -- no sleep-and-hope racing.
make_writer_script() {
  name="$1"
  text="$2"
  path="$3"
  cat > "$path" <<SCRIPT
#!/usr/bin/env bash
set -u
writer="$fixture_root/$name-writer"
git -C "\$writer" fetch origin >/dev/null 2>&1 || exit 1
git -C "\$writer" reset --hard origin/main >/dev/null 2>&1 || exit 1
printf '| %s | active |\n' "$text" >> "\$writer/instance/workboard.md"
git -C "\$writer" add instance/workboard.md || exit 1
git -C "\$writer" commit -m "[ORCH] $text" >/dev/null || exit 1
git -C "\$writer" push origin main >/dev/null 2>&1 || exit 1
echo "1 pass"
echo "0 fail"
SCRIPT
  chmod +x "$path"
}

# A lane on a fresh file (no conflict with bookkeeping) unless $4 is given, in
# which case the lane edits base.txt and can genuinely collide with main.
make_lane() {
  repo="$1"
  lane="$2"
  contested="${3:-}"
  git -C "$repo" checkout -q -b "$lane" main
  if [ -n "$contested" ]; then
    printf 'lane-side\n' > "$repo/base.txt"
    git -C "$repo" add base.txt
  else
    printf 'lane\n' > "$repo/lane.txt"
    git -C "$repo" add lane.txt
  fi
  git -C "$repo" commit -m lane >/dev/null
  sha=$(git -C "$repo" rev-parse HEAD)
  git -C "$repo" checkout -q main
  printf '%s\n' "$sha"
}

report() {
  printf 'commit: %s fixture\nverify: %s\nresult: clean\nsecret-scan: clean\nremaining: none\n' "$2" "${3:-true}" > "$1"
}

attempt_refs() {
  git -C "$1" ls-remote --refs origin 'refs/bpa-review-attempts/*' 2>/dev/null
}

echo '--- 1. bookkeeping pushed BEFORE freshness: the landing completes -------'
# Pre-fix this was `LAND step=freshness status=fail` and a hand-run
# fast-forward of the shared checkout. The gate now absorbs the move itself and
# lands onto the tip it just measured.
make_fixture before
before_lane=$(make_lane "$fixture_root/before-repo" ag-before)
assert writer_push before before-freshness
book_sha=$(git -C "$fixture_root/before-writer" rev-parse HEAD)
assert test "$(git -C "$fixture_root/before-repo" rev-parse main)" != "$book_sha"
report "$fixture_root/before-report.md" "$before_lane"
before_output="$fixture_root/before-output.txt"
env -u BUN_BIN "$land" --branch ag-before --item-id ag-before \
  --report "$fixture_root/before-report.md" --repo "$fixture_root/before-repo" \
  >"$before_output" 2>&1
before_status=$?
assert_status "$before_status" 0 "$before_output"
assert_output_has "$before_output" 'LAND freshness advanced'
assert_output_has "$before_output" 'LAND step=freshness status=pass'
assert_output_has "$before_output" 'LAND verdict=landed sha='
# The landed tip must CONTAIN the bookkeeping commit, not bypass it: absorbing
# the move is only honest if the merge really sat on top of it.
landed=$(git -C "$fixture_root/before-repo" rev-parse main)
assert git -C "$fixture_root/before-repo" merge-base --is-ancestor "$book_sha" "$landed"
assert git -C "$fixture_root/before-repo" merge-base --is-ancestor "$before_lane" "$landed"
assert test "$(git -C "$fixture_root/before-repo" ls-remote --refs origin refs/heads/main | awk '{print $1}')" = "$landed"
echo 'PASS before-freshness: bookkeeping move absorbed, landing completed, no hand-run fast-forward'

echo '--- 2. bookkeeping pushed BETWEEN freshness and merge: refused, no round spent ---'
# The stated reason is the fence bypass, not "something unrelated moved": this
# landing has held the repository landing lock since before freshness, so a
# write that reached origin/main since then did not come through
# gate/bookkeeping-push.sh.
make_fixture middle
middle_lane=$(make_lane "$fixture_root/middle-repo" ag-middle)
make_writer_script middle mid-walk "$fixture_root/middle-writer.sh"
report "$fixture_root/middle-report.md" "$middle_lane" "bash $fixture_root/middle-writer.sh"
middle_before_main=$(git -C "$fixture_root/middle-repo" rev-parse main)
middle_output="$fixture_root/middle-output.txt"
env -u BUN_BIN "$land" --branch ag-middle --item-id ag-middle \
  --report "$fixture_root/middle-report.md" --repo "$fixture_root/middle-repo" \
  >"$middle_output" 2>&1
middle_status=$?
assert_status "$middle_status" 2 "$middle_output"
assert_output_has "$middle_output" 'LAND freshness fence-bypassed'
assert_output_has "$middle_output" 'detail=write-outside-landing-lock-use-gate/bookkeeping-push.sh'
assert_output_has "$middle_output" 'LAND verdict=aborted'
# This is the regression lock proper. Pre-fix the same interleaving failed at
# `attempt-persist-mismatch`, which runs AFTER the attempt refs are pushed to
# origin -- so the abort spent one of the item's three review rounds on a write
# that had nothing to do with the item.
assert test -z "$(attempt_refs "$fixture_root/middle-repo")"
assert_output_lacks "$middle_output" 'attempt-persist-mismatch'
assert test "$(git -C "$fixture_root/middle-repo" rev-parse main)" = "$middle_before_main"
assert git -C "$fixture_root/middle-repo" show-ref --verify --quiet refs/heads/ag-middle
echo 'PASS mid-walk: refused with a named cause, zero review rounds consumed, lane branch retained'

echo '--- 2b. the same lane then lands on retry, because nothing was consumed --'
# "Refuse" is only an acceptable answer at this position if the retry is free.
middle_retry_output="$fixture_root/middle-retry-output.txt"
report "$fixture_root/middle-report.md" "$middle_lane"
env -u BUN_BIN "$land" --branch ag-middle --item-id ag-middle \
  --report "$fixture_root/middle-report.md" --repo "$fixture_root/middle-repo" \
  >"$middle_retry_output" 2>&1
middle_retry_status=$?
assert_status "$middle_retry_status" 0 "$middle_retry_output"
assert_output_has "$middle_retry_output" 'LAND freshness advanced'
assert_output_has "$middle_retry_output" 'LAND verdict=landed sha='
echo 'PASS mid-walk retry: absorbed at freshness and landed on the next attempt'

echo '--- 3. bookkeeping pushed BETWEEN merge and push: refused, cause named ---'
# This position is deliberately NOT absorbed. Fast-forwarding and re-pushing
# here would publish a merge whose parent no check ever walked -- the false
# green Hard Floor 7 forbids.
make_fixture after
after_lane=$(make_lane "$fixture_root/after-repo" ag-after)
make_writer_script after post-merge "$fixture_root/after-writer.sh"
report "$fixture_root/after-report.md" "$after_lane" "bash $fixture_root/after-writer.sh"
after_measured=$(git -C "$fixture_root/after-repo" rev-parse main)
after_output="$fixture_root/after-output.txt"
env -u BUN_BIN "$land" --branch ag-after --item-id ag-after \
  --report "$fixture_root/after-report.md" --repo "$fixture_root/after-repo" \
  --run-verify >"$after_output" 2>&1
after_status=$?
assert_status_not "$after_status" 0 "$after_output"
assert_output_has "$after_output" 'LAND step=merge status=pass'
assert_output_has "$after_output" 'LAND step=post-merge-verify status=pass'
assert_output_has "$after_output" 'LAND push target-advanced-during-landing'
assert_output_has "$after_output" 'detail=write-outside-landing-lock-use-gate/bookkeeping-push.sh'
assert_output_has "$after_output" 'LAND step=push status=fail'
# The merge must be gone, nothing of the lane may have reached origin, and the
# shared canonical checkout must be left on the tip the gate MEASURED. That tip
# was already published, so a concurrent reader of the shared checkout never
# observes an unpublished state -- the transient a reviewer twice mistook for
# fact (V3-0.54) is a local merge that exists only while the walk is running.
# The checkout is left strictly BEHIND origin, which is exactly the state
# instance 4 of this row reported; it is now harmless rather than a blocker,
# because the next landing absorbs it at freshness (test 1).
after_remote=$(git -C "$fixture_root/after-repo" ls-remote --refs origin refs/heads/main | awk '{print $1}')
after_local=$(git -C "$fixture_root/after-repo" rev-parse main)
assert test "$after_local" = "$after_measured"
assert git -C "$fixture_root/after-repo" merge-base --is-ancestor "$after_local" "$after_remote"
assert test "$after_local" != "$after_remote"
assert_not git -C "$fixture_root/after-repo" merge-base --is-ancestor "$after_lane" "$after_remote"
assert test -z "$(git -C "$fixture_root/after-repo" status --porcelain)"
# This position is NOT free, and the round-1 report read as if it were (round-2
# review, F4). The attempt refs are pushed to origin before the merge, by
# necessity -- releasing them would collide with the forgery detection the
# review policy relies on -- so a refusal here durably spends one of the item's
# three review rounds. Assert it, so the cost stays visible in the evidence
# rather than being re-discovered by the next reader: unlike case 2, the origin
# attempt namespace is NOT empty after this refusal.
assert test -n "$(attempt_refs "$fixture_root/after-repo")"
echo 'PASS post-merge: push fence intact, cause named, merge rolled back onto the published tip'
echo 'PASS post-merge cost: the refusal is recorded as having spent a review round'

echo '--- 4. a genuinely stale target is still refused (divergence) -----------'
# The only case newly absorbed is "local strictly behind a published origin".
# A canonical checkout carrying a commit origin does not have -- an unpushed
# merge a previous landing left behind -- must still be refused, because that
# is the state in which a landing could publish something no gate walked.
make_fixture diverged
diverged_lane=$(make_lane "$fixture_root/diverged-repo" ag-diverged)
printf 'local-only\n' > "$fixture_root/diverged-repo/local.txt"
git -C "$fixture_root/diverged-repo" add local.txt
git -C "$fixture_root/diverged-repo" commit -q -m 'local-only commit on main'
assert writer_push diverged diverging
report "$fixture_root/diverged-report.md" "$diverged_lane"
diverged_output="$fixture_root/diverged-output.txt"
diverged_main=$(git -C "$fixture_root/diverged-repo" rev-parse main)
env -u BUN_BIN "$land" --branch ag-diverged --item-id ag-diverged \
  --report "$fixture_root/diverged-report.md" --repo "$fixture_root/diverged-repo" \
  >"$diverged_output" 2>&1
diverged_status=$?
assert_status "$diverged_status" 2 "$diverged_output"
assert_output_has "$diverged_output" 'LAND freshness diverged'
assert_output_has "$diverged_output" 'LAND step=freshness status=fail'
assert test "$(git -C "$fixture_root/diverged-repo" rev-parse main)" = "$diverged_main"
echo 'PASS diverged target: still refused, ref untouched'

echo '--- 5. a genuinely stale lane is still refused (real conflict) ----------'
# Absorbing the move must not launder a lane whose work no longer applies. The
# fast-forward advances main only; the lane is NOT rebased, so a real collision
# still fails at merge, on the merged content rather than on a ref-equality
# proxy.
make_fixture stale
stale_lane=$(make_lane "$fixture_root/stale-repo" ag-stale contested)
stale_writer="$fixture_root/stale-writer"
git -C "$stale_writer" fetch origin >/dev/null 2>&1
git -C "$stale_writer" reset --hard origin/main >/dev/null 2>&1
printf 'main-side\n' > "$stale_writer/base.txt"
git -C "$stale_writer" add base.txt
git -C "$stale_writer" commit -q -m 'main moved under the lane'
git -C "$stale_writer" push origin main >/dev/null 2>&1
report "$fixture_root/stale-report.md" "$stale_lane"
stale_output="$fixture_root/stale-output.txt"
env -u BUN_BIN "$land" --branch ag-stale --item-id ag-stale \
  --report "$fixture_root/stale-report.md" --repo "$fixture_root/stale-repo" \
  >"$stale_output" 2>&1
stale_status=$?
assert_status_not "$stale_status" 0 "$stale_output"
assert_output_has "$stale_output" 'LAND freshness advanced'
assert_output_has "$stale_output" 'LAND step=merge status=fail'
stale_remote=$(git -C "$fixture_root/stale-repo" ls-remote --refs origin refs/heads/main | awk '{print $1}')
assert_not git -C "$fixture_root/stale-repo" merge-base --is-ancestor "$stale_lane" "$stale_remote"
echo 'PASS stale lane: fast-forward does not launder a conflicting lane'

echo '--- 6. the fence publishes bookkeeping and verifies origin --------------'
make_fixture fence
printf '| fenced | active |\n' >> "$fixture_root/fence-repo/instance/workboard.md"
git -C "$fixture_root/fence-repo" add instance/workboard.md
git -C "$fixture_root/fence-repo" commit -q -m '[ORCH] fenced bookkeeping'
fence_local=$(git -C "$fixture_root/fence-repo" rev-parse main)
fence_output="$fixture_root/fence-output.txt"
env -u BUN_BIN bash "$fence" --repo "$fixture_root/fence-repo" >"$fence_output" 2>&1
fence_status=$?
assert_status "$fence_status" 0 "$fence_output"
assert_output_has "$fence_output" 'BOOKKEEPING step=preflight status=pass'
assert_output_has "$fence_output" 'BOOKKEEPING step=secret-scan status=pass'
assert_output_has "$fence_output" 'BOOKKEEPING verdict=published'
assert test "$(git -C "$fixture_root/fence-repo" ls-remote --refs origin refs/heads/main | awk '{print $1}')" = "$fence_local"
echo 'PASS fence publish: bookkeeping reached origin through the lock'

echo '--- 7. the fence replaces the hand-run fast-forward ---------------------'
assert writer_push fence catch-up
fence_catchup_output="$fixture_root/fence-catchup-output.txt"
env -u BUN_BIN bash "$fence" --repo "$fixture_root/fence-repo" >"$fence_catchup_output" 2>&1
fence_catchup_status=$?
assert_status "$fence_catchup_status" 0 "$fence_catchup_output"
assert_output_has "$fence_catchup_output" 'BOOKKEEPING verdict=nothing-to-push'
assert test "$(git -C "$fixture_root/fence-repo" rev-parse main)" = "$(git -C "$fixture_root/fence-repo" rev-parse origin/main)"
echo 'PASS fence catch-up: a behind checkout is advanced by mechanism, not by hand'

echo '--- 8a. the fence rebases a diverged bookkeeping commit -----------------'
# Local bookkeeping plus remote bookkeeping that do not collide: replayed onto
# the published tip and published, with no operator step.
printf 'local note\n' > "$fixture_root/fence-repo/instance/local-note.md"
git -C "$fixture_root/fence-repo" add instance/local-note.md
git -C "$fixture_root/fence-repo" commit -q -m '[ORCH] local bookkeeping'
assert writer_push fence remote-bookkeeping
fence_rebase_output="$fixture_root/fence-rebase-output.txt"
env -u BUN_BIN bash "$fence" --repo "$fixture_root/fence-repo" >"$fence_rebase_output" 2>&1
fence_rebase_status=$?
assert_status "$fence_rebase_status" 0 "$fence_rebase_output"
assert_output_has "$fence_rebase_output" 'BOOKKEEPING step=rebase status=pass'
assert_output_has "$fence_rebase_output" 'BOOKKEEPING verdict=published'
fence_tip=$(git -C "$fixture_root/fence-repo" rev-parse main)
assert test "$fence_tip" = "$(git -C "$fixture_root/fence-repo" ls-remote --refs origin refs/heads/main | awk '{print $1}')"
assert git -C "$fixture_root/fence-repo" cat-file -e "$fence_tip:instance/local-note.md"
echo 'PASS fence rebase: local and remote bookkeeping reconciled under the lock'

echo '--- 8b. a conflicting rebase is refused and leaves a clean checkout -----'
# The refusal itself matters less than the state it leaves behind: an aborted
# rebase that left the shared canonical checkout dirty or mid-rebase would trip
# the next landing's working-tree guard, turning one collision into two.
printf '| conflict-local | active |\n' >> "$fixture_root/fence-repo/instance/workboard.md"
git -C "$fixture_root/fence-repo" add instance/workboard.md
git -C "$fixture_root/fence-repo" commit -q -m '[ORCH] conflicting local bookkeeping'
conflict_local=$(git -C "$fixture_root/fence-repo" rev-parse main)
assert writer_push fence conflict-remote
conflict_output="$fixture_root/fence-conflict-output.txt"
env -u BUN_BIN bash "$fence" --repo "$fixture_root/fence-repo" >"$conflict_output" 2>&1
conflict_status=$?
assert_status "$conflict_status" 4 "$conflict_output"
assert_output_has "$conflict_output" 'detail=rebase-conflict'
assert_output_has "$conflict_output" 'BOOKKEEPING verdict=refused'
assert test "$(git -C "$fixture_root/fence-repo" rev-parse main)" = "$conflict_local"
assert test -z "$(git -C "$fixture_root/fence-repo" status --porcelain)"
assert_not test -d "$fixture_root/fence-repo/.git/rebase-merge"
assert_not test -d "$fixture_root/fence-repo/.git/rebase-apply"
echo 'PASS fence conflict: refused with a named cause, checkout left clean and unmoved'

echo '--- 9. the fence is not a landing bypass -------------------------------'
# The whole reason the fence can be allowed to push to the integration branch
# without the gate is that it can only carry allowlisted bookkeeping paths.
make_fixture bypass
printf '#!/usr/bin/env bash\nexit 1\n' > "$fixture_root/bypass-repo/gate/keep.sh"
git -C "$fixture_root/bypass-repo" add gate/keep.sh
git -C "$fixture_root/bypass-repo" commit -q -m '[ORCH] smuggle gate change'
bypass_remote_before=$(git -C "$fixture_root/bypass-repo" ls-remote --refs origin refs/heads/main | awk '{print $1}')
bypass_output="$fixture_root/bypass-output.txt"
env -u BUN_BIN bash "$fence" --repo "$fixture_root/bypass-repo" >"$bypass_output" 2>&1
bypass_status=$?
assert_status "$bypass_status" 2 "$bypass_output"
assert_output_has "$bypass_output" 'detail=path-outside-allowlist'
assert_output_has "$bypass_output" 'gate/keep.sh'
assert_output_has "$bypass_output" 'BOOKKEEPING verdict=refused'
assert test "$(git -C "$fixture_root/bypass-repo" ls-remote --refs origin refs/heads/main | awk '{print $1}')" = "$bypass_remote_before"
echo 'PASS fence allowlist: a review-required path cannot ride the fence to origin'

echo '--- 10. the allowlist/review-policy overlap invariant is enforced -------'
# Enforced at run time, not merely documented: if the two lists ever came to
# overlap, the fence would become exactly the bypass test 9 forbids.
overlap_gate="$fixture_root/overlap-gate"
mkdir -p "$overlap_gate"
cp "$root/gate/bookkeeping-push.sh" "$root/gate/land-lib.sh" "$root/gate/review-policy.conf" "$overlap_gate/"
printf 'gate/\n' > "$overlap_gate/bookkeeping-paths.conf"
overlap_output="$fixture_root/overlap-output.txt"
env -u BUN_BIN bash "$overlap_gate/bookkeeping-push.sh" --repo "$fixture_root/bypass-repo" >"$overlap_output" 2>&1
overlap_status=$?
assert_status "$overlap_status" 2 "$overlap_output"
assert_output_has "$overlap_output" 'detail=allowlist-overlaps-review-policy'
echo 'PASS fence invariant: refuses to run when the allowlist overlaps review policy'

echo '--- 11. the fence waits for an in-flight landing, then proceeds ---------'
# This is the mechanism that makes positions 2 and 3 unreachable for any write
# that goes through it, replacing the manual `flock -n ... && echo free` check.
make_fixture wait
wait_repo="$fixture_root/wait-repo"
printf '| waited | active |\n' >> "$wait_repo/instance/workboard.md"
git -C "$wait_repo" add instance/workboard.md
git -C "$wait_repo" commit -q -m '[ORCH] queued bookkeeping'
wait_lock="$wait_repo/.git/bpa-land.lock"
wait_marker="$fixture_root/wait-marker"
( exec 9>"$wait_lock"; flock 9; : > "$wait_marker"; sleep 30 ) &
holder=$!
waited=0
while [ ! -e "$wait_marker" ] && [ "$waited" -lt 100 ]; do
  sleep 0.1
  waited=$((waited + 1))
done
assert test -e "$wait_marker"
wait_output="$fixture_root/wait-output.txt"
env -u BUN_BIN bash "$fence" --repo "$wait_repo" --wait-seconds 1 >"$wait_output" 2>&1
wait_status=$?
kill "$holder" >/dev/null 2>&1
wait "$holder" 2>/dev/null
assert_status "$wait_status" 3 "$wait_output"
assert_output_has "$wait_output" 'BOOKKEEPING lock held=yes'
assert_output_has "$wait_output" 'detail=lock-wait-timeout'
assert test "$(git -C "$wait_repo" ls-remote --refs origin refs/heads/main | awk '{print $1}')" != "$(git -C "$wait_repo" rev-parse main)"
wait_free_output="$fixture_root/wait-free-output.txt"
env -u BUN_BIN bash "$fence" --repo "$wait_repo" --wait-seconds 5 >"$wait_free_output" 2>&1
wait_free_status=$?
assert_status "$wait_free_status" 0 "$wait_free_output"
assert_output_has "$wait_free_output" 'BOOKKEEPING verdict=published'
echo 'PASS fence lock: held -> refused with a named reason; released -> published'

echo '--- 12a. the fence refuses to flatten and publish a stranded landing ----'
# Round-2 review, F1 -- the blocking finding, reproduced from a clean fixture.
#
# The state: a canonical checkout whose target branch carries an unpushed
# [ORCH] merge of a lane, and an origin that has since moved. Case 4 above
# calls this state real ("an unpushed merge a previous landing left behind")
# and gate/land.sh refuses it as `freshness diverged`. Round 1's fence rebased
# it flat and PUBLISHED the lane's commits to the integration branch -- no
# walk, no declared checks, no review, no round -- because every path happened
# to sit under instance/.
#
# Fail-before: at 16ed6f57 this fixture produces `BOOKKEEPING step=rebase
# status=pass`, `verdict=published`, and the [CODER] commit on origin/main. A
# plain `git push origin main` in the same state is rejected as a
# non-fast-forward, so round 1 turned a fail-closed refusal into a publish.
make_fixture stranded
stranded_repo="$fixture_root/stranded-repo"
git -C "$stranded_repo" checkout -q -b ag-stranded main
mkdir -p "$stranded_repo/instance/decisions"
printf -- '---\nid: HR-9999\noperator-unpark: item=V3-X decision=HR-9999\n---\n' > "$stranded_repo/instance/decisions/HR-9999.md"
git -C "$stranded_repo" add instance/decisions/HR-9999.md
git -C "$stranded_repo" commit -q -m '[CODER] lane adds an unpark grant, instance/ only'
stranded_lane=$(git -C "$stranded_repo" rev-parse HEAD)
git -C "$stranded_repo" checkout -q main
# The landing gate merges --no-ff, so this is the shape a landing that died
# after merge and before push leaves behind.
git -C "$stranded_repo" merge -q --no-ff ag-stranded -m '[ORCH] land lane ag-stranded'
stranded_local=$(git -C "$stranded_repo" rev-parse main)
assert writer_push stranded moved-under-the-stranded-merge
stranded_remote_before=$(git -C "$stranded_repo" ls-remote --refs origin refs/heads/main | awk '{print $1}')
stranded_output="$fixture_root/stranded-output.txt"
env -u BUN_BIN bash "$fence" --repo "$stranded_repo" >"$stranded_output" 2>&1
stranded_status=$?
assert_status "$stranded_status" 2 "$stranded_output"
assert_output_has "$stranded_output" 'detail=merge-commit-in-range'
assert_output_has "$stranded_output" 'BOOKKEEPING verdict=refused'
# The publish must not have happened, and the checkout must be untouched --
# a refusal that still rewrote the shared checkout would be F3 by another door.
stranded_remote_after=$(git -C "$stranded_repo" ls-remote --refs origin refs/heads/main | awk '{print $1}')
assert test "$stranded_remote_after" = "$stranded_remote_before"
assert test "$(git -C "$stranded_repo" rev-parse main)" = "$stranded_local"
assert_not git -C "$stranded_repo" merge-base --is-ancestor "$stranded_lane" "$stranded_remote_after"
assert_output_lacks "$stranded_output" 'BOOKKEEPING step=rebase status=pass'
echo 'PASS fence entitlement: a stranded landing merge is refused, not flattened and published'

echo '--- 12b. ... and the lane commit is refused on its own, without the merge'
# Independence matters: if the merge commit were the only guard, a landing that
# fast-forwarded (or an operator who flattened by hand) would slip through. The
# [ORCH] predicate refuses the lane commit by itself.
make_fixture linear
linear_repo="$fixture_root/linear-repo"
mkdir -p "$linear_repo/instance/decisions"
printf -- '---\nid: HR-9998\noperator-unpark: item=V3-Y decision=HR-9998\n---\n' > "$linear_repo/instance/decisions/HR-9998.md"
git -C "$linear_repo" add instance/decisions/HR-9998.md
git -C "$linear_repo" commit -q -m '[CODER] lane adds an unpark grant, instance/ only'
linear_local=$(git -C "$linear_repo" rev-parse main)
assert writer_push linear moved-under-the-linear-commit
linear_remote_before=$(git -C "$linear_repo" ls-remote --refs origin refs/heads/main | awk '{print $1}')
linear_output="$fixture_root/linear-output.txt"
env -u BUN_BIN bash "$fence" --repo "$linear_repo" >"$linear_output" 2>&1
linear_status=$?
assert_status "$linear_status" 2 "$linear_output"
assert_output_has "$linear_output" 'detail=not-an-orch-commit'
assert test "$(git -C "$linear_repo" ls-remote --refs origin refs/heads/main | awk '{print $1}')" = "$linear_remote_before"
assert test "$(git -C "$linear_repo" rev-parse main)" = "$linear_local"
echo 'PASS fence entitlement: a non-[ORCH] commit cannot ride the fence to origin'

echo '--- 12c. ... and a commit that also lives on another ref is refused -----'
# The third guard: an [ORCH]-subjected commit that is also reachable from a
# lane branch or a tag is that lane's work awaiting a landing, whatever its
# subject says.
make_fixture claimed
claimed_repo="$fixture_root/claimed-repo"
# A distinct file, so the rebase this refusal prevents WOULD have succeeded --
# otherwise the case could pass for the incidental reason that the replay
# conflicts, which is not the property under test.
printf '| claimed | active |\n' > "$claimed_repo/instance/claimed-row.md"
git -C "$claimed_repo" add instance/claimed-row.md
git -C "$claimed_repo" commit -q -m '[ORCH] bookkeeping also claimed by a lane'
git -C "$claimed_repo" branch ag-claimed
claimed_local=$(git -C "$claimed_repo" rev-parse main)
assert writer_push claimed moved-under-the-claimed-commit
claimed_output="$fixture_root/claimed-output.txt"
env -u BUN_BIN bash "$fence" --repo "$claimed_repo" >"$claimed_output" 2>&1
claimed_status=$?
assert_status "$claimed_status" 2 "$claimed_output"
assert_output_has "$claimed_output" 'detail=commit-reachable-from-other-ref'
assert_output_has "$claimed_output" 'ref=refs/heads/ag-claimed'
assert test "$(git -C "$claimed_repo" rev-parse main)" = "$claimed_local"
echo 'PASS fence entitlement: a commit claimed by another ref is refused'

echo '--- 13. --dry-run is read-only ------------------------------------------'
# Round-2 review, F3. Round 1 fast-forwarded and rebased BEFORE testing the
# flag, so an operator reaching for --dry-run on the shared canonical checkout
# to see what would happen had already rewritten it when the command returned.
# Fail-before at 16ed6f57: `BOOKKEEPING step=rebase status=pass` and main moved.
#
# Both reconciliation shapes are covered, because round 1 mutated in both.
make_fixture dry
dry_repo="$fixture_root/dry-repo"
assert writer_push dry ahead-of-the-checkout
dry_behind_before=$(git -C "$dry_repo" rev-parse main)
dry_behind_output="$fixture_root/dry-behind-output.txt"
env -u BUN_BIN bash "$fence" --repo "$dry_repo" --dry-run >"$dry_behind_output" 2>&1
dry_behind_status=$?
assert_status "$dry_behind_status" 0 "$dry_behind_output"
assert_output_has "$dry_behind_output" 'BOOKKEEPING verdict=dry-run'
assert_output_has "$dry_behind_output" 'would-fast-forward='
assert test "$(git -C "$dry_repo" rev-parse main)" = "$dry_behind_before"
# Again a distinct file: the diverged dry run must report a rebase that WOULD
# have gone through, not one that would have died on a conflict anyway.
printf '| dry local | active |\n' > "$dry_repo/instance/dry-row.md"
git -C "$dry_repo" add instance/dry-row.md
git -C "$dry_repo" commit -q -m '[ORCH] local bookkeeping for the dry run'
assert writer_push dry diverging-under-the-dry-run
dry_diverged_before=$(git -C "$dry_repo" rev-parse main)
dry_diverged_remote_before=$(git -C "$dry_repo" ls-remote --refs origin refs/heads/main | awk '{print $1}')
dry_diverged_output="$fixture_root/dry-diverged-output.txt"
env -u BUN_BIN bash "$fence" --repo "$dry_repo" --dry-run >"$dry_diverged_output" 2>&1
dry_diverged_status=$?
assert_status "$dry_diverged_status" 0 "$dry_diverged_output"
assert_output_has "$dry_diverged_output" 'would-rebase='
assert_output_has "$dry_diverged_output" 'checkout=unmodified'
assert_output_lacks "$dry_diverged_output" 'BOOKKEEPING step=rebase status=pass'
assert test "$(git -C "$dry_repo" rev-parse main)" = "$dry_diverged_before"
assert test "$(git -C "$dry_repo" ls-remote --refs origin refs/heads/main | awk '{print $1}')" = "$dry_diverged_remote_before"
assert test -z "$(git -C "$dry_repo" status --porcelain)"
# The read-only path must still have decided entitlement -- a dry run that
# skipped the guards would report a publish the real run refuses.
assert_output_has "$dry_diverged_output" 'BOOKKEEPING step=entitlement status=pass'
echo 'PASS fence dry-run: reports without moving a single ref, in both shapes'

echo '--- 14. the lock wait is derived from the landing hold, not a literal ---'
# Round-2 review, F5. Round 1 defaulted --wait-seconds to a literal 1800, which
# sits at ~86 % of the worst-case hold one landing can take (meteorite bound
# plus five full-suite runs). A literal also stops tracking the moment the
# meteorite bound is raised. These assertions go red if either happens again.
# Read the helpers in a subshell rather than sourcing them here: land-lib.sh
# defines a large surface and this file has its own assert/report helpers.
lib_eval() { env -u BUN_BIN bash -c 'set -u; . "$1"; shift; "$@"' _ "$root/gate/land-lib.sh" "$@"; }
hold_default=$(lib_eval land_landing_hold_seconds)
wait_default=$(lib_eval land_bookkeeping_wait_default)
assert test "$wait_default" -gt "$hold_default"
# The fence's OWN default must be the derived value, so re-hardcoding a number
# is caught even if the helper stays correct.
fence_default=$(env -u BUN_BIN bash "$fence" --print-wait-default)
assert test "$fence_default" = "$wait_default"
# It must track the meteorite bound: raise that by 600 and the fence's patience
# must rise by at least as much.
raised_default=$(LAND_METEORITE_TIMEOUT_SECONDS=1500 env -u BUN_BIN bash "$fence" --print-wait-default)
assert test "$raised_default" -ge "$((fence_default + 600))"
# ... and the number of full-suite runs a landing performs.
runs_default=$(LAND_SUITE_BUDGET_SECONDS=400 env -u BUN_BIN bash "$fence" --print-wait-default)
assert test "$runs_default" -ge "$((fence_default + 500))"
echo "PASS fence wait bound: derived ($wait_default s) and strictly above the landing hold ($hold_default s)"

echo '--- 15. the fence runs the tracked checkers on the tip it will publish --'
# Round-2 review, F2. This row's own argument for serialising rather than
# tolerating is that a malformed ledger row pushed as bookkeeping can turn a
# passing declared check red. Having made that argument, the fence must not
# then publish those same paths unchecked -- otherwise the next landing dies at
# `baseline-checks` and the discarded-walk loss this row exists to prevent
# happens one landing later, with a less obvious cause. The lock is already
# held and both checkers cost ~0.1 s.
#
# A stand-in checker, not the real one: the property under test is that the
# fence runs what the tracked tree declares and refuses on a non-zero exit,
# which a fixture can prove without dragging in the real checker's inputs.
make_fixture checks
checks_repo="$fixture_root/checks-repo"
mkdir -p "$checks_repo/tools"
printf '#!/usr/bin/env bash\nexit 1\n' > "$checks_repo/tools/check-decision-ledger-drift.sh"
git -C "$checks_repo" add tools/check-decision-ledger-drift.sh
git -C "$checks_repo" commit -q -m '[ORCH] add a failing ledger checker'
checks_remote_before=$(git -C "$checks_repo" ls-remote --refs origin refs/heads/main | awk '{print $1}')
checks_output="$fixture_root/checks-output.txt"
env -u BUN_BIN bash "$fence" --repo "$checks_repo" >"$checks_output" 2>&1
checks_status=$?
# The commit adding the checker sits outside the allowlist, so it is refused on
# paths -- publish it as an operator would, then let the fence meet it.
assert_status "$checks_status" 2 "$checks_output"
git -C "$checks_repo" push -q origin main
printf '| checked | active |\n' > "$checks_repo/instance/checked-row.md"
git -C "$checks_repo" add instance/checked-row.md
git -C "$checks_repo" commit -q -m '[ORCH] bookkeeping onto a tree whose checker fails'
checks_local=$(git -C "$checks_repo" rev-parse main)
checks_remote_before=$(git -C "$checks_repo" ls-remote --refs origin refs/heads/main | awk '{print $1}')
checks_red_output="$fixture_root/checks-red-output.txt"
env -u BUN_BIN bash "$fence" --repo "$checks_repo" >"$checks_red_output" 2>&1
checks_red_status=$?
assert_status "$checks_red_status" 2 "$checks_red_output"
assert_output_has "$checks_red_output" 'detail=check-failed check=ledger-drift'
assert_output_has "$checks_red_output" 'BOOKKEEPING verdict=refused'
# Refused AFTER the guards passed and BEFORE the push: nothing reached origin.
assert_output_has "$checks_red_output" 'BOOKKEEPING step=entitlement status=pass'
assert test "$(git -C "$checks_repo" ls-remote --refs origin refs/heads/main | awk '{print $1}')" = "$checks_remote_before"
assert test "$(git -C "$checks_repo" rev-parse main)" = "$checks_local"
# Green checker: the same bookkeeping now publishes, and the check is named in
# the evidence rather than silently skipped.
printf '#!/usr/bin/env bash\nexit 0\n' > "$checks_repo/tools/check-decision-ledger-drift.sh"
git -C "$checks_repo" add tools/check-decision-ledger-drift.sh
git -C "$checks_repo" commit -q -m '[ORCH] repair the ledger checker'
checks_green_output="$fixture_root/checks-green-output.txt"
env -u BUN_BIN bash "$fence" --repo "$checks_repo" >"$checks_green_output" 2>&1
checks_green_status=$?
# tools/ is outside the allowlist, so this repair cannot ride the fence either
# -- which is itself the allowlist working. Publish it, then re-run.
assert_status "$checks_green_status" 2 "$checks_green_output"
assert_output_has "$checks_green_output" 'detail=path-outside-allowlist'
git -C "$checks_repo" push -q origin main
printf '| checked again | active |\n' > "$checks_repo/instance/checked-row-2.md"
git -C "$checks_repo" add instance/checked-row-2.md
git -C "$checks_repo" commit -q -m '[ORCH] bookkeeping onto a tree whose checker passes'
checks_ok_local=$(git -C "$checks_repo" rev-parse main)
checks_ok_output="$fixture_root/checks-ok-output.txt"
env -u BUN_BIN bash "$fence" --repo "$checks_repo" >"$checks_ok_output" 2>&1
checks_ok_status=$?
assert_status "$checks_ok_status" 0 "$checks_ok_output"
assert_output_has "$checks_ok_output" 'BOOKKEEPING step=checks status=pass check=ledger-drift'
assert_output_has "$checks_ok_output" 'BOOKKEEPING verdict=published'
assert test "$(git -C "$checks_repo" ls-remote --refs origin refs/heads/main | awk '{print $1}')" = "$checks_ok_local"
# A checker absent from the tracked tree is reported as absent, never passed
# silently -- the fixtures above have no tools/instructions/check.ts.
assert_output_has "$checks_ok_output" 'check=instructions detail=absent-from-tree'
echo 'PASS fence checks: the reconciled tip is checked before it is published, and absence is named'

echo 'PASS gate/bookkeeping-fence.test.sh'
