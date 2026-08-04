#!/usr/bin/env bash
# Locks gate/lane-exit.sh: the exit-side mirror of gate/completion-guard.ts,
# invoked at lane-completion time instead of only at landing time
# (instance/workboard.md V3-0.2).
#
# Proves the guard actually rejects the three shapes that made the old
# landing-only invocation cruel (instance/workboard.md V3-0.2 background):
#   1. a report naming an intermediate SHA, not the branch tip;
#   2. a lane with no report at all;
#   3. a report committed INTO its own branch (the mathematically impossible
#      "amend commit: to match the new tip" convention) -- this is really
#      case (1) in disguise: a report can never state the hash of the commit
#      that carries it, so committing it always produces a stale commit: line.
# ...and that a genuinely valid, externally-pinned report is accepted.
#
# Nested-gate note (instance/workboard.md "Nested gate invocations"): this
# script does not itself invoke gate/land.sh, so it is not subject to the
# BUN_BIN caller-override refusal and needs no `env -u BUN_BIN` when run
# standalone. A caller that wraps THIS test under gate/land.sh's own verify
# step would need it, same as any other gate test.
set -u
set -o pipefail

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
lane_exit="$root/gate/lane-exit.sh"
fixture_root=$(mktemp -d)
trap 'rm -rf "$fixture_root"' EXIT

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
  output="$1"
  expected="$2"
  assert grep -Fq "$expected" "$output"
}

valid_report() {
  # $1 sha, $2 out file, $3 result (default clean)
  sha="$1"
  out="$2"
  result="${3:-clean}"
  {
    printf 'commit: %s fixture\n' "$sha"
    printf 'verify: true\n'
    printf 'result: %s\n' "$result"
    printf 'secret-scan: clean\n'
    printf 'remaining: none\n'
  } > "$out"
}

make_repo() {
  repo="$fixture_root/repo"
  git init --initial-branch=main "$repo" >/dev/null
  git -C "$repo" config user.email lane@example.test
  git -C "$repo" config user.name Lane
  printf 'base\n' > "$repo/base.txt"
  git -C "$repo" add base.txt
  git -C "$repo" commit -m base >/dev/null
  git -C "$repo" checkout -b ag-lane-1 >/dev/null
  printf 'work\n' > "$repo/work.txt"
  git -C "$repo" add work.txt
  git -C "$repo" commit -m work >/dev/null
}

echo "== scenario: valid, externally-pinned report exits 0 =="
make_repo
tip=$(git -C "$repo" rev-parse HEAD)
report="$fixture_root/valid.report.md"
valid_report "$tip" "$report"
out="$fixture_root/valid.out"
"$lane_exit" --report "$report" --repo "$repo" --branch ag-lane-1 >"$out" 2>&1
status=$?
cat "$out"
assert [ "$status" -eq 0 ]
assert_output_has "$out" "LANE-EXIT verdict=clear"
rm -rf "$fixture_root"/repo "$fixture_root"/*.md "$fixture_root"/*.out
echo "PASS: valid report exits 0"
echo

echo "== scenario: honest NO-GO passes through (parked row, not a violation) =="
make_repo
tip=$(git -C "$repo" rev-parse HEAD)
report="$fixture_root/nogo.report.md"
valid_report "$tip" "$report" "NO-GO"
out="$fixture_root/nogo.out"
"$lane_exit" --report "$report" --repo "$repo" --branch ag-lane-1 >"$out" 2>&1
status=$?
cat "$out"
assert [ "$status" -eq 3 ]
assert_output_has "$out" "LANE-EXIT verdict=clear"
rm -rf "$fixture_root"/repo "$fixture_root"/*.md "$fixture_root"/*.out
echo "PASS: NO-GO report exits 3 and is not treated as blocked"
echo

echo "== scenario 1: report names an intermediate SHA, not the branch tip =="
make_repo
stale=$(git -C "$repo" rev-parse HEAD)
printf 'more work\n' > "$repo/more.txt"
git -C "$repo" add more.txt
git -C "$repo" commit -m more >/dev/null
report="$fixture_root/stale.report.md"
valid_report "$stale" "$report"
out="$fixture_root/stale.out"
"$lane_exit" --report "$report" --repo "$repo" --branch ag-lane-1 >"$out" 2>&1
status=$?
cat "$out"
assert [ "$status" -eq 2 ]
assert_output_has "$out" "LANE-EXIT verdict=blocked"
assert_output_has "$out" "FAIL branch-tip"
rm -rf "$fixture_root"/repo "$fixture_root"/*.md "$fixture_root"/*.out
echo "PASS: intermediate-SHA report is rejected before landing, not just at landing"
echo

echo "== scenario 2: no report file at all =="
make_repo
report="$fixture_root/does-not-exist.report.md"
out="$fixture_root/missing.out"
"$lane_exit" --report "$report" --repo "$repo" --branch ag-lane-1 >"$out" 2>&1
status=$?
cat "$out"
assert [ "$status" -eq 2 ]
assert_output_has "$out" "LANE-EXIT verdict=blocked"
assert_output_has "$out" "FAIL report-file missing"
rm -rf "$fixture_root"/repo "$fixture_root"/*.out
echo "PASS: a lane with no report at all cannot end clean"
echo

echo "== scenario 3: report committed INTO its own branch (the impossible case) =="
make_repo
# The lane commits real work (already done by make_repo), then -- following
# the discredited convention -- writes a report claiming the CURRENT tip and
# commits the report file itself into the branch. The commit that carries the
# report is now a NEW commit; its hash cannot have been known when the report
# body was written, so the report's commit: line is necessarily stale the
# instant the report lands in the tree. This is the same defect as scenario 1,
# produced the way lanes actually produced it (report-pinning-convention).
pre_report_tip=$(git -C "$repo" rev-parse HEAD)
report_in_tree="$repo/report.md"
valid_report "$pre_report_tip" "$report_in_tree"
git -C "$repo" add report.md
git -C "$repo" commit -m "report (committed into the branch, the impossible convention)" >/dev/null
out="$fixture_root/impossible.out"
"$lane_exit" --report "$report_in_tree" --repo "$repo" --branch ag-lane-1 >"$out" 2>&1
status=$?
cat "$out"
assert [ "$status" -eq 2 ]
assert_output_has "$out" "LANE-EXIT verdict=blocked"
assert_output_has "$out" "FAIL branch-tip"
rm -rf "$fixture_root"/repo "$fixture_root"/*.out
echo "PASS: a report committed into its own branch can never match the tip, and is rejected"
echo

echo "== scenario 4: a red suite hidden behind a pipe cannot reach state: terminal =="
# instance/workboard.md V3-0.40. gate/lane-exit.sh calls the guard WITHOUT
# --defer-verify, so the guard runs the lane's own verify: command -- and a
# shell pipeline exits with the status of its LAST command. Before the fix
# this scenario printed `PASS verify-run` / `LANE-EXIT verdict=clear exit=0`
# on a genuinely failing suite, which is the exact false green Hard Floor 7
# forbids. The bare-`exit 1` control below proves the guard was refusing the
# unpiped form all along, so the difference is the pipe and nothing else.
make_repo
tip=$(git -C "$repo" rev-parse HEAD)
for verify in 'exit 1 | cat' 'exit 1 | sed -E "s/^ +//"' 'exit 1'; do
  report="$fixture_root/piped.report.md"
  {
    printf 'commit: %s fixture\n' "$tip"
    printf 'verify: %s\n' "$verify"
    printf 'result: clean\n'
    printf 'secret-scan: clean\n'
    printf 'remaining: none\n'
  } > "$report"
  out="$fixture_root/piped.out"
  "$lane_exit" --report "$report" --repo "$repo" --branch ag-lane-1 >"$out" 2>&1
  status=$?
  cat "$out"
  assert [ "$status" -eq 2 ]
  assert_output_has "$out" "LANE-EXIT verdict=blocked"
  assert_output_has "$out" "FAIL verify-run"
  rm -f "$fixture_root"/*.md "$fixture_root"/*.out
done
# A passing pipeline is still a passing lane: the fix enforces the real exit
# status, it does not ban pipes.
report="$fixture_root/piped-ok.report.md"
{
  printf 'commit: %s fixture\n' "$tip"
  printf 'verify: exit 0 | cat\n'
  printf 'result: clean\n'
  printf 'secret-scan: clean\n'
  printf 'remaining: none\n'
} > "$report"
out="$fixture_root/piped-ok.out"
"$lane_exit" --report "$report" --repo "$repo" --branch ag-lane-1 >"$out" 2>&1
status=$?
cat "$out"
assert [ "$status" -eq 0 ]
assert_output_has "$out" "LANE-EXIT verdict=clear"
rm -rf "$fixture_root"/repo "$fixture_root"/*.md "$fixture_root"/*.out
echo "PASS: a lane cannot end clean on a red check hidden by a pipeline"
echo

echo "ALL PASS"
