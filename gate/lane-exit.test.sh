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

# A reviewer lane's terminal artifact is its review record. The four fields
# below are the contract gate/land-lib.sh has always required of a review
# artifact; this writes them in the same shape real reviewer lanes on this
# installation produce, which is what the guard is checked against.
review_record() {
  # $1 verdict, $2 reviewed sha, $3 out file
  verdict="$1"
  sha="$2"
  out="$3"
  {
    printf 'verdict: %s\n' "$verdict"
    printf 'reviewer: independent-reviewer <rev@example.test>\n'
    printf 'reviewed-sha: %s\n' "$sha"
    printf 'independence: separate session; did not author the change\n'
  } > "$out"
}

echo "== scenario: reviewer lane with a contract-valid ACCEPT record exits 0 =="
make_repo
subject=$(git -C "$repo" rev-parse HEAD)
record="$fixture_root/rev-accept.report.md"
review_record ACCEPT "$subject" "$record"
out="$fixture_root/rev-accept.out"
"$lane_exit" --report "$record" --repo "$repo" --branch ag-lane-1 --role reviewer >"$out" 2>&1
status=$?
cat "$out"
assert [ "$status" -eq 0 ]
assert_output_has "$out" "LANE-EXIT verdict=clear"
assert_output_has "$out" "PASS review-contract verdict=ACCEPT"
rm -rf "$fixture_root"/repo "$fixture_root"/*.md "$fixture_root"/*.out
echo "PASS: a reviewer that produced a valid ACCEPT is terminal, not failed"
echo

echo "== scenario: reviewer lane with a REJECT record also exits 0 (review completed) =="
# A REJECT is a finished review. Landing refuses it; lane exit must not, or the
# status signal calls a working reviewer 'failed' all over again.
make_repo
subject=$(git -C "$repo" rev-parse HEAD)
record="$fixture_root/rev-reject.report.md"
review_record REJECT "$subject" "$record"
out="$fixture_root/rev-reject.out"
"$lane_exit" --report "$record" --repo "$repo" --branch ag-lane-1 --role reviewer >"$out" 2>&1
status=$?
cat "$out"
assert [ "$status" -eq 0 ]
assert_output_has "$out" "PASS review-contract verdict=REJECT"
rm -rf "$fixture_root"/repo "$fixture_root"/*.md "$fixture_root"/*.out
echo "PASS: a completed REJECT review ends terminal"
echo

echo "== scenario: reviewer lane with no record at all fails closed and NAMES it =="
make_repo
out="$fixture_root/rev-missing.out"
"$lane_exit" --report "$fixture_root/absent.md" --repo "$repo" --branch ag-lane-1 --role reviewer >"$out" 2>&1
status=$?
cat "$out"
assert [ "$status" -eq 2 ]
assert_output_has "$out" "LANE-EXIT verdict=blocked"
assert_output_has "$out" "missing=no-review-record-written"
rm -rf "$fixture_root"/repo "$fixture_root"/*.out
echo "PASS: a reviewer with no artifact fails closed, naming what is absent"
echo

echo "== scenario: truncated record fails closed naming the MISSING FIELD, not 'invalid' =="
# Truncation is the real failure mode: a reviewer killed mid-write leaves a
# prefix of a valid record. Each cut must name the first field it lost.
make_repo
subject=$(git -C "$repo" rev-parse HEAD)
full="$fixture_root/rev-full.md"
review_record ACCEPT "$subject" "$full"
for cut in 1:reviewer 2:reviewed-sha 3:independence; do
  lines=${cut%%:*}
  expect=${cut##*:}
  trunc="$fixture_root/rev-trunc.report.md"
  head -n "$lines" "$full" > "$trunc"
  out="$fixture_root/rev-trunc-$lines.out"
  "$lane_exit" --report "$trunc" --repo "$repo" --branch ag-lane-1 --role reviewer >"$out" 2>&1
  status=$?
  assert [ "$status" -eq 2 ]
  assert_output_has "$out" "missing=$expect"
  echo "  truncated to $lines line(s) -> names missing '$expect'"
  rm -f "$trunc" "$out"
done
rm -rf "$fixture_root"/repo "$fixture_root"/*.md
echo "PASS: every truncation names the field it lost"
echo

echo "== scenario: the coder contract is NOT relaxed for a coder lane =="
# The trap this fix must not fall into: trading a false 'failed' for a false
# 'pass'. A review record is not a coder report and must still be rejected
# when the lane is a coder.
make_repo
subject=$(git -C "$repo" rev-parse HEAD)
record="$fixture_root/coder-given-review.report.md"
review_record ACCEPT "$subject" "$record"
out="$fixture_root/coder-given-review.out"
"$lane_exit" --report "$record" --repo "$repo" --branch ag-lane-1 --role coder >"$out" 2>&1
status=$?
cat "$out"
assert [ "$status" -eq 2 ]
assert_output_has "$out" "FAIL report-shape"
rm -rf "$fixture_root"/repo "$fixture_root"/*.md "$fixture_root"/*.out
echo "PASS: a review record still fails the coder contract"
echo

echo "== scenario: a coder report is NOT accepted under the reviewer contract =="
make_repo
tip=$(git -C "$repo" rev-parse HEAD)
report="$fixture_root/coder.report.md"
valid_report "$tip" "$report"
out="$fixture_root/reviewer-given-coder.out"
"$lane_exit" --report "$report" --repo "$repo" --branch ag-lane-1 --role reviewer >"$out" 2>&1
status=$?
cat "$out"
assert [ "$status" -eq 2 ]
assert_output_has "$out" "missing=verdict"
rm -rf "$fixture_root"/repo "$fixture_root"/*.md "$fixture_root"/*.out
echo "PASS: the two contracts do not accept each other's artifacts"
echo

echo "== scenario: default role stays coder when --role is absent =="
make_repo
tip=$(git -C "$repo" rev-parse HEAD)
report="$fixture_root/default.report.md"
valid_report "$tip" "$report"
out="$fixture_root/default.out"
"$lane_exit" --report "$report" --repo "$repo" --branch ag-lane-1 >"$out" 2>&1
status=$?
assert [ "$status" -eq 0 ]
assert_output_has "$out" "role=coder"
rm -rf "$fixture_root"/repo "$fixture_root"/*.md "$fixture_root"/*.out
echo "PASS: omitting --role is unchanged, pre-existing coder behaviour"
echo

# --------------------------------------------------------------------------
# Ledger-state execution site (V3-3.1).
#
# The mechanism these scenarios lock is not the ledger predicate -- that is
# covered by tools/instructions/hr-state.test.ts -- it is that the predicate is
# RUN. Before this row, `check.ts --strict` and the ledger checkers behind it
# were wired into nothing: no gate, no unit, no timer invoked them against the
# real corpus, so they reported green over 82 uncleared HR records for as long
# as they existed. A predicate nobody runs is the same shape as a rule nobody
# enforces, so "it runs" is itself an acceptance row with its own lock.
# --------------------------------------------------------------------------

# Installs a minimal instruction-checker into the fixture repo, tracked, whose
# verdict the scenario chooses. Nothing here re-implements the real checker: the
# question under test is whether lane-exit.sh runs it and honours its status.
install_checker() {
  local exit_code="$1"
  mkdir -p "$repo/tools/instructions"
  cat > "$repo/tools/instructions/check.ts" <<EOF
#!/usr/bin/env bun
console.log("stub instruction checker: exiting ${exit_code}");
process.exit(${exit_code});
EOF
  git -C "$repo" add tools/instructions/check.ts
  git -C "$repo" commit -m "add checker" >/dev/null
}

echo "== scenario: a RED ledger blocks lane exit, even with a valid report =="
make_repo
install_checker 1
tip=$(git -C "$repo" rev-parse HEAD)
report="$fixture_root/red-ledger.report.md"
valid_report "$tip" "$report"
out="$fixture_root/red-ledger.out"
"$lane_exit" --report "$report" --repo "$repo" --branch ag-lane-1 --role coder >"$out" 2>&1
status=$?
cat "$out"
# The report itself is contract-valid, so without the wiring this exits 0. The
# ONLY thing that can make it 2 is the ledger check actually having run.
assert [ "$status" -eq 2 ]
assert_output_has "$out" "step=ledger-state"
rm -rf "$fixture_root"/repo "$fixture_root"/*.md "$fixture_root"/*.out
echo "PASS: the checker has an execution site, and a red verdict blocks"
echo

echo "== scenario: a GREEN ledger does not block a valid report =="
make_repo
install_checker 0
tip=$(git -C "$repo" rev-parse HEAD)
report="$fixture_root/green-ledger.report.md"
valid_report "$tip" "$report"
out="$fixture_root/green-ledger.out"
"$lane_exit" --report "$report" --repo "$repo" --branch ag-lane-1 --role coder >"$out" 2>&1
status=$?
cat "$out"
assert [ "$status" -eq 0 ]
assert_output_has "$out" "stub instruction checker"
rm -rf "$fixture_root"/repo "$fixture_root"/*.md "$fixture_root"/*.out
echo "PASS: a green ledger is not a blocker"
echo

echo "== scenario: a repo that does not TRACK the checker is not-applicable =="
make_repo
tip=$(git -C "$repo" rev-parse HEAD)
report="$fixture_root/no-checker.report.md"
valid_report "$tip" "$report"
out="$fixture_root/no-checker.out"
"$lane_exit" --report "$report" --repo "$repo" --branch ag-lane-1 --role coder >"$out" 2>&1
status=$?
cat "$out"
# This gate is generic: it must still land lanes in a product repo that never
# carried this control plane's instruction tooling.
assert [ "$status" -eq 0 ]
assert_output_has "$out" "status=not-applicable"
rm -rf "$fixture_root"/repo "$fixture_root"/*.md "$fixture_root"/*.out
echo "PASS: absence of the tooling is scoped out, not silently skipped"
echo

echo "== scenario: DELETING a tracked checker does not skip the check =="
make_repo
install_checker 1
rm "$repo/tools/instructions/check.ts"   # still tracked in the index
tip=$(git -C "$repo" rev-parse HEAD)
report="$fixture_root/deleted-checker.report.md"
valid_report "$tip" "$report"
out="$fixture_root/deleted-checker.out"
"$lane_exit" --report "$report" --repo "$repo" --branch ag-lane-1 --role coder >"$out" 2>&1
status=$?
cat "$out"
# The guard is keyed on tracked-ness, not on `[[ -f ]]`. A filesystem-existence
# guard is the fail-open shape this repository keeps getting burned by: it would
# let `rm` disable an evidence gate silently.
assert [ "$status" -eq 2 ]
assert_output_has "$out" "step=ledger-state"
rm -rf "$fixture_root"/repo "$fixture_root"/*.md "$fixture_root"/*.out
echo "PASS: the escape hatch is a reviewable diff, not an rm"
echo

echo "ALL PASS"
