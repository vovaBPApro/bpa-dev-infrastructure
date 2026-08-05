#!/usr/bin/env bash
# Regression lock for gate/push-guard.sh (G3).
#
# The mistake this locks: the orchestrator verified a commit with three targeted
# commands, pushed, and left `main` red because a tracked test it never ran
# asserted the old value. So the load-bearing case here is REFUSAL -- a tracked
# test that is red must stop the push -- and the proof that the case is
# load-bearing is the mutant at the end, which is this guard with the baseline
# call removed and which lets the same red fixture through.
#
# Not `set -e`: most cases here assert a NON-zero status, and every status is
# read directly from the command rather than through a pipe.
set -uo pipefail

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
guard="$root/gate/push-guard.sh"
fixture=$(mktemp -d "${TMPDIR:-/tmp}/bpa-push-guard-test.XXXXXX")
trap 'rm -rf "$fixture"' EXIT

failures=0
RC=0
OUT=""

fail() {
  printf 'FAIL %s\n' "$1" >&2
  failures=$((failures + 1))
}

pass() { printf 'ok %s\n' "$1"; }

# Runs the guard and captures status directly. `$?` here is the guard's own,
# never a pipeline's last element ("a kill is not a pass").
run() {
  OUT=$("$@" 2>&1)
  RC=$?
  return 0
}

expect_status() {
  local label="$1" want="$2"
  if [ "$RC" -eq "$want" ]; then pass "$label (exit $RC)"; else
    fail "$label: expected exit $want, got $RC
$OUT"
  fi
}

expect_output() {
  local label="$1" needle="$2"
  if printf '%s' "$OUT" | grep -Fq -- "$needle"; then pass "$label"; else
    fail "$label: output does not contain '$needle'
$OUT"
  fi
}

expect_no_output() {
  local label="$1" needle="$2"
  if printf '%s' "$OUT" | grep -Fq -- "$needle"; then
    fail "$label: output unexpectedly contains '$needle'
$OUT"
  else pass "$label"; fi
}

# A minimal repository the gate's baseline passes: one tracked, passing test.
new_repo() {
  local dir="$1"
  mkdir -p "$dir"
  git init --quiet --initial-branch=main "$dir"
  git -C "$dir" config user.email push-guard@example.test
  git -C "$dir" config user.name 'Push Guard Fixture'
  cat >"$dir/green.test.ts" <<'EOF'
import { expect, test } from "bun:test";
test("the fixture is green", () => {
  expect(1 + 1).toBe(2);
});
EOF
  git -C "$dir" add -A
  git -C "$dir" commit --quiet -m base
}

# The guard resolves bun only from the fixed host baseline and refuses a
# caller-supplied BUN_BIN, exactly as the landing gate does. The shell tier can
# be invoked from inside gate/land.sh, which exports it, so drop it here for the
# same reason tools/shell-test-tier.test.ts drops it.
unset BUN_BIN

# --------------------------------------------------------------------------
# 1. green: the guard allows, and runs the guarded command
# --------------------------------------------------------------------------
green="$fixture/green"
new_repo "$green"

run bash "$guard" --repo "$green"
expect_status "green repo is allowed" 0
expect_output "green repo names the baseline" "PUSH-GUARD verdict=allowed checks=baseline"

marker="$fixture/pushed-green"
run bash "$guard" --repo "$green" -- touch "$marker"
expect_status "green repo runs the guarded command" 0
if [ -e "$marker" ]; then pass "guarded command ran on green"; else
  fail "guarded command did not run on green"
fi

# --------------------------------------------------------------------------
# 2. RED: a tracked test fails -> refused, and the guarded command does NOT run
#    This is the case that reproduces the 2026-08-05 red-main pushes.
# --------------------------------------------------------------------------
red="$fixture/red"
new_repo "$red"
cat >"$red/stale-assertion.test.ts" <<'EOF'
import { expect, test } from "bun:test";
// Stands in for daemon/autonomy-keepalive.test.ts asserting the old fleet cap.
test("asserts a value the change moved", () => {
  expect(3).toBe(5);
});
EOF
git -C "$red" add -A
git -C "$red" commit --quiet -m 'a tracked test the targeted checks never ran'

run bash "$guard" --repo "$red"
expect_status "red tracked test is refused" 1
expect_output "refusal names the failing check" "PUSH-GUARD verdict=refused check=framework:test detail=tests-failed"

red_marker="$fixture/pushed-red"
run bash "$guard" --repo "$red" -- touch "$red_marker"
expect_status "red repo refuses with a guarded command" 1
if [ -e "$red_marker" ]; then
  fail "the guarded command RAN despite a red tracked test — the guard does not guard"
else
  pass "guarded command was not run on red"
fi

# --------------------------------------------------------------------------
# 3. the other baseline checks are named individually
# --------------------------------------------------------------------------
parse="$fixture/parse"
new_repo "$parse"
printf 'export const broken = (\n' >"$parse/unparseable.ts"
git -C "$parse" add -A
git -C "$parse" commit --quiet -m unparseable
run bash "$guard" --repo "$parse"
expect_status "unparseable source is refused" 1
expect_output "refusal names the parse check" "PUSH-GUARD verdict=refused check=declared:parse detail=unparseable-source"

lint="$fixture/lint"
new_repo "$lint"
cat >"$lint/package.json" <<'EOF'
{
  "name": "push-guard-lint-fixture",
  "private": true,
  "scripts": { "lint": "exit 7" }
}
EOF
git -C "$lint" add -A
git -C "$lint" commit --quiet -m 'declared lint script that fails'
run bash "$guard" --repo "$lint"
expect_status "failing declared lint script is refused" 1
expect_output "refusal names the declared script" "PUSH-GUARD verdict=refused check=declared:lint detail=script-exited-non-zero"

notests="$fixture/notests"
mkdir -p "$notests"
git init --quiet --initial-branch=main "$notests"
git -C "$notests" config user.email push-guard@example.test
git -C "$notests" config user.name 'Push Guard Fixture'
printf 'export const x = 1;\n' >"$notests/only-source.ts"
git -C "$notests" add -A
git -C "$notests" commit --quiet -m 'no tracked tests at all'
run bash "$guard" --repo "$notests"
expect_status "a repo with no tracked tests is refused" 1
expect_output "refusal names no-tests-tracked" "detail=no-tests-tracked"

# --------------------------------------------------------------------------
# 4. break-glass, at each of its three outcomes
# --------------------------------------------------------------------------
journal="$fixture/journal/ops-journal.log"

# 4a. unset -> the checks decide, and nothing is journaled (covered above, but
#     assert the journal stayed empty so a silent override cannot hide here).
rm -rf "$fixture/journal"
run env ORCH_OPS_JOURNAL="$journal" bash "$guard" --repo "$red"
expect_status "override unset: the checks still decide" 1
if [ -e "$journal" ]; then fail "override unset: journal was written anyway"; else
  pass "override unset: nothing journaled"
fi

# 4b. set but empty -> refused, nothing journaled, guarded command not run.
empty_marker="$fixture/pushed-empty-override"
run env ORCH_OPS_JOURNAL="$journal" PUSH_GUARD_OVERRIDE='   ' \
  bash "$guard" --repo "$green" -- touch "$empty_marker"
expect_status "override set-but-empty is refused" 4
expect_output "empty override names itself" "PUSH-GUARD verdict=refused reason=override-empty"
if [ -e "$journal" ]; then fail "empty override: journal was written"; else
  pass "empty override: nothing journaled"
fi
if [ -e "$empty_marker" ]; then fail "empty override: guarded command ran"; else
  pass "empty override: guarded command was not run"
fi

# 4c. set with a reason -> allowed over a RED repo, loudly, and journaled.
glass_marker="$fixture/pushed-break-glass"
run env ORCH_OPS_JOURNAL="$journal" PUSH_GUARD_OVERRIDE='hotfix for an already-broken main' \
  bash "$guard" --repo "$red" -- touch "$glass_marker"
expect_status "override with a reason allows a red repo" 0
expect_output "break-glass announces itself on stderr" "WARN PUSH-GUARD baseline SKIPPED"
expect_output "break-glass verdict is explicit" "PUSH-GUARD verdict=allowed reason=break-glass"
if [ -e "$glass_marker" ]; then pass "break-glass: guarded command ran"; else
  fail "break-glass: guarded command did not run"
fi
if [ -f "$journal" ] \
  && grep -Fq 'PUSH_GUARD_OVERRIDE' "$journal" \
  && grep -Fq 'hotfix for an already-broken main' "$journal"; then
  pass "break-glass is journaled with its reason"
else
  fail "break-glass journal missing or reasonless: $(cat "$journal" 2>&1)"
fi

# A newline in the reason must not forge a second journal row: the reason is
# JSON-encoded, so the journal keeps exactly one line per use.
rm -rf "$fixture/journal"
run env ORCH_OPS_JOURNAL="$journal" \
  PUSH_GUARD_OVERRIDE=$'hotfix\n2026-01-01T00:00:00+00:00\tPUSH_GUARD_OVERRIDE\tforged' \
  bash "$guard" --repo "$green"
expect_status "a newline in the reason is still allowed" 0
if [ "$(wc -l <"$journal")" -eq 1 ]; then pass "a newline in the reason cannot forge a journal row"; else
  fail "override reason forged extra journal rows: $(cat "$journal")"
fi

# 4d. set with a reason but unjournalable -> refused. A break-glass use that
#     cannot be recorded is refused, as dispatch-check.ts refuses one.
printf 'not a directory\n' >"$fixture/blocked"
unjournalable_marker="$fixture/pushed-unjournalable"
run env ORCH_OPS_JOURNAL="$fixture/blocked/ops-journal.log" \
  PUSH_GUARD_OVERRIDE='cannot be recorded' \
  bash "$guard" --repo "$green" -- touch "$unjournalable_marker"
expect_status "unjournalable override is refused" 4
expect_output "unjournalable override names itself" "reason=override-unjournalable"
if [ -e "$unjournalable_marker" ]; then fail "unjournalable override: guarded command ran"; else
  pass "unjournalable override: guarded command was not run"
fi

# --------------------------------------------------------------------------
# 5. argument and preflight refusals
# --------------------------------------------------------------------------
run bash "$guard" --repo "$green" --unknown-flag
expect_status "an unknown flag is a usage error" 2

run bash "$guard" --repo "$fixture/not-a-repo"
expect_status "a non-repository path is refused" 3
expect_output "non-repository refusal names itself" "detail=not-a-git-repository"

run env BUN_BIN=/bin/false bash "$guard" --repo "$green"
expect_status "a caller-supplied BUN_BIN is refused" 3
expect_output "caller bun override refusal is named" "detail=caller-bun-override-refused"

# --------------------------------------------------------------------------
# 5b. the tree must be what the push will send.
#
# The checks run the working tree; the push sends HEAD. A guard that verified a
# green working tree and let a red HEAD through would be the same defect wearing
# a different hat, so a modified tracked file is refused outright.
# --------------------------------------------------------------------------
dirty="$fixture/dirty"
new_repo "$dirty"
cat >"$dirty/green.test.ts" <<'EOF'
import { expect, test } from "bun:test";
test("the working tree is green while HEAD is not", () => {
  expect(1 + 1).toBe(2);
});
EOF
printf 'import { expect, test } from "bun:test";\ntest("red at HEAD", () => { expect(1).toBe(2); });\n' \
  >"$dirty/head-is-red.test.ts"
git -C "$dirty" add -A
git -C "$dirty" commit --quiet -m 'HEAD carries a red test'
# ...and now the working tree "fixes" it without committing, exactly as an
# unstaged local edit would.
printf 'import { expect, test } from "bun:test";\ntest("red at HEAD", () => { expect(1).toBe(1); });\n' \
  >"$dirty/head-is-red.test.ts"

dirty_marker="$fixture/pushed-dirty"
run bash "$guard" --repo "$dirty" -- touch "$dirty_marker"
expect_status "a modified tracked file is refused" 3
expect_output "dirty-tree refusal names itself" "detail=dirty-tree"
expect_output "dirty-tree refusal lists the path" "head-is-red.test.ts"
if [ -e "$dirty_marker" ]; then
  fail "the guarded command RAN over a working tree that differs from HEAD"
else
  pass "dirty tree: guarded command was not run"
fi

# A staged-but-uncommitted change is refused for the same reason: `git ls-files`
# would collect it, `bun test` would run it, and the push would not send it.
git -C "$dirty" checkout --quiet -- head-is-red.test.ts
printf 'export const scratch = 1;\n' >"$dirty/staged-only.ts"
git -C "$dirty" add staged-only.ts
run bash "$guard" --repo "$dirty"
expect_status "a staged-but-uncommitted change is refused" 3
expect_output "staged change is reported as dirty-tree" "detail=dirty-tree"
git -C "$dirty" reset --quiet -- staged-only.ts

# An untracked file is NOT refused: it is not pushed, and the orchestrator's
# tree legitimately carries scratch. Refusing here would make the guard annoying
# enough to be routed around, which is how guards die.
run bash "$guard" --repo "$dirty"
expect_status "an untracked file alone does not refuse" 1
expect_output "untracked tree still reaches the baseline" "PUSH-GUARD verdict=refused check=framework:test"

# Break-glass escapes the tree check too, so the override is a complete escape
# rather than a partial one.
rm -rf "$fixture/journal"
printf 'import { expect, test } from "bun:test";\ntest("x", () => { expect(1).toBe(1); });\n' \
  >"$dirty/head-is-red.test.ts"
run env ORCH_OPS_JOURNAL="$journal" PUSH_GUARD_OVERRIDE='hotfix over a dirty tree' \
  bash "$guard" --repo "$dirty"
expect_status "break-glass escapes the tree check too" 0
expect_no_output "break-glass did not stop at the tree check" "detail=dirty-tree"

# --------------------------------------------------------------------------
# 6. the mutant: this guard with the baseline call removed.
#
# "It must be able to fail" — proven, not asserted. The mutant is byte-identical
# to gate/push-guard.sh except that it does not run the gate's baseline. If it
# refuses the red fixture anyway, then case 2 above passes for some reason other
# than the guard doing its job, and the lock is worthless.
# --------------------------------------------------------------------------
mutant="$fixture/mutant-push-guard.sh"
sed -e 's|^land_run_declared_checks "\$repo" "\$prefix" 2>"\$fail_log"$|true 2>"$fail_log"|' \
    -e "s|^source \"\$script_dir/land-lib.sh\"\$|source \"$root/gate/land-lib.sh\"|" \
    "$guard" >"$mutant"
if grep -Fq 'land_run_declared_checks "$repo" "$prefix"' "$mutant"; then
  fail "mutant construction failed: the baseline call is still present (did the guard's call site change?)"
fi
if ! grep -Fq "source \"$root/gate/land-lib.sh\"" "$mutant"; then
  fail "mutant construction failed: land-lib.sh source line was not rewritten"
fi

mutant_marker="$fixture/pushed-by-mutant"
run bash "$mutant" --repo "$red" -- touch "$mutant_marker"
if [ "$RC" -eq 0 ] && [ -e "$mutant_marker" ]; then
  pass "mutant (baseline removed) lets the red fixture through — case 2 is load-bearing"
else
  fail "mutant unexpectedly refused the red fixture (exit $RC); case 2 does not prove what it claims
$OUT"
fi

# --------------------------------------------------------------------------
if [ "$failures" -ne 0 ]; then
  printf 'push-guard regression: %d FAILURE(S)\n' "$failures" >&2
  exit 1
fi
printf 'push-guard regression: PASS\n'
