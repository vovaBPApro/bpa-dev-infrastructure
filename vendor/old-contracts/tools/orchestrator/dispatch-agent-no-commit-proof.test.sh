#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BASE_REF="${NO_COMMIT_PROOF_BASE_REF:-fd647ef7b13d81769712a8eb2f9e22afa8856be3}"
CANDIDATE_REF="${NO_COMMIT_PROOF_CANDIDATE_REF:-f9960a3052ca10a5e3752454ed9e3d675e7d179b}"
PARENT_REF="${NO_COMMIT_PROOF_PARENT_REF:-809175d92c56f32af29489bf509cec60ce3fde42}"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

pass() { printf 'PASS %s\n' "$1"; }
fail() { printf 'FAIL %s\n%s\n' "$1" "${2:-}" >&2; exit 1; }

make_repo() {
  local repo="$1"
  git init -q "$repo"
  git -C "$repo" config user.email "no-commit-proof@example.test"
  git -C "$repo" config user.name "No Commit Proof Test"
  git -C "$repo" switch -q -c dev
  printf 'base\n' > "$repo/README.md"
  git -C "$repo" add README.md
  git -C "$repo" commit -qm base
}

run_case() {
  local case_name="$1" report_launch_id="$2" report_branch="$3" report_head_sha="$4" report_kind="${5:-valid}"
  local root repo worktree runtime context log branch head_sha merged_sha proof gate_log report_extra command rc
  root="$tmpdir/$case_name"
  repo="$root/repo"
  worktree="$root/worktree"
  runtime="$root/runtime"
  context="$root/context.env"
  log="$root/lane.log"
  branch="ag-no-commit-$case_name"
  mkdir -p "$root" "$runtime/lane-reports/proofs/$case_name" "$root/lane-tmp" "$tmpdir/home"
  make_repo "$repo"
  git -C "$repo" worktree add -q -b "$branch" "$worktree" dev
  head_sha="$(git -C "$worktree" rev-parse HEAD)"
  merged_sha="$head_sha"
  proof="$runtime/lane-reports/proofs/$case_name/proof.txt"
  gate_log="$runtime/lane-reports/proofs/$case_name/gate.log"
  printf 'proof\n' > "$proof"
  printf 'merge-gate: recorded landed marker refs/landed/%s -> %s\nPASS: merge-gate completed\nPASS: suites=1 pushed=0 log=%s\n' \
    "$branch" "$merged_sha" "$gate_log" > "$gate_log"
  report_extra=""
  if [ "$report_kind" = "blockers" ]; then
    report_extra=" --blocker $(printf '%q' 'operator reported blocker')"
  fi
  [ "$report_branch" = current ] && report_branch="$branch"
  [ "$report_head_sha" = current ] && report_head_sha="$head_sha"
  if [ "$report_launch_id" = no-report ]; then
    command='true'
  else
    command="DISPATCH_RUNTIME_DIR=$(printf '%q' "$runtime") LANE_REPORT_DIR=$(printf '%q' "$runtime/lane-reports") $(printf '%q' "$ROOT/tools/orchestrator/lane-report.sh") --lane $(printf '%q' "$branch") --provider codex --model fixture --status done --branch $(printf '%q' "$report_branch") --head-sha $(printf '%q' "$report_head_sha") --launch-id $(printf '%q' "$report_launch_id") --no-commits true --verification-scope fixture --merged-sha $(printf '%q' "$merged_sha") --gate-log-path $(printf '%q' "$gate_log") --lock-proof $(printf '%q' "$proof") --clear-blockers$report_extra"
  fi
  cat > "$context" <<EOF
BASE=dev
BR=$branch
CMD=$(printf '%q' "$command")
CODEX_HOME=''
CODEX_HOME_SHARED=''
HOME=$(printf '%q' "$tmpdir/home")
LANE_TMPDIR=$(printf '%q' "$root/lane-tmp")
LOG=$(printf '%q' "$log")
LANE_REPORT_HELPER=$(printf '%q' "$ROOT/tools/orchestrator/lane-report.sh")
NAME=no-commit-$case_name
MODE=operator
ORCH_DISPATCH_REPO=''
ORCH_DISPATCH_WORKTREE=''
ORCH_REAL_PNPM=''
ORCH_REAL_STAGING_LOOP=''
ORCH_REAL_SYSTEMCTL=''
ORCH_REAL_SYSTEMD_RUN=''
PATH=$(printf '%q' "$PATH")
PROVIDER=codex
REPO=$(printf '%q' "$repo")
SHARED_SYMLINK_CHECK=''
SHARED_SYMLINK_ROOT=$(printf '%q' "$root/shared")
WT=$(printf '%q' "$worktree")
OWNER_LAUNCH_ID=current-launch
OWNER_PID=1
OWNER_PID_START=1
EOF
  set +e
  DISPATCH_RUNTIME_DIR="$runtime" LANE_REPORT_DIR="$runtime/lane-reports" bash "$ROOT/tools/orchestrator/dispatch-agent.sh" --internal-run-lane "$context" >/dev/null 2>&1
  rc=$?
  set -e
  printf '%s:%s:%s:%s:%s\n' "$repo" "$worktree" "$runtime" "$branch" "$rc"
}

before_prompt="$tmpdir/prompt.md"
printf 'operator fixture\n' > "$before_prompt"
set +e
git show "$BASE_REF:tools/orchestrator/dispatch-agent.sh" > "$tmpdir/dispatch-before.sh"
chmod +x "$tmpdir/dispatch-before.sh"
"$tmpdir/dispatch-before.sh" --provider codex --name no-commit-before --base HEAD --prompt "$before_prompt" --mode operator --dry-run >/dev/null 2>&1
before_rc=$?
set -e
[ "$before_rc" = 64 ] || fail "RED-before operator mode is unsupported" "expected rc=64, got $before_rc"
pass "RED-before: base rejects explicit operator no-code mode"

candidate_helper="$tmpdir/lane-report-candidate.sh"
git show "$CANDIDATE_REF:tools/orchestrator/lane-report.sh" > "$candidate_helper"
chmod +x "$candidate_helper"

parent_helper="$tmpdir/lane-report-parent.sh"
git show "$PARENT_REF:tools/orchestrator/lane-report.sh" > "$parent_helper"
chmod +x "$parent_helper"

write_landing_report() {
  local case_name="$1" kind="$2" helper_runtime report_path proof_path gate_log actual_sha other_sha merged_sha blockers
  helper_runtime="$tmpdir/landing-$case_name"
  mkdir -p "$helper_runtime/lane-reports"
  report_path="$helper_runtime/lane-reports/ag-landing-$case_name.json"
  proof_path="$helper_runtime/proof.txt"
  gate_log="$helper_runtime/gate.log"
  actual_sha="$(git rev-parse HEAD)"
  other_sha="$(git rev-parse HEAD^)"
  merged_sha="$actual_sha"
  blockers='[]'
  printf 'proof\n' > "$proof_path"

  case "$kind" in
    valid)
      printf 'merge-gate: recorded landed marker refs/landed/ag-landing-%s -> %s\nPASS: merge-gate completed\nPASS: suites=1 pushed=0 log=%s\n' "$case_name" "$merged_sha" "$gate_log" > "$gate_log"
      ;;
    blockers)
      blockers='["operator reported blocker"]'
      printf 'merge-gate: recorded landed marker refs/landed/ag-landing-%s -> %s\nPASS: merge-gate completed\n' "$case_name" "$merged_sha" > "$gate_log"
      ;;
    malformed-sha)
      merged_sha='not-a-sha'
      printf 'merge-gate: recorded landed marker refs/landed/ag-landing-%s -> %s\nPASS: merge-gate completed\n' "$case_name" "$actual_sha" > "$gate_log"
      ;;
    arbitrary-log)
      printf 'arbitrary text only\n' > "$gate_log"
      ;;
    mismatched-sha)
      printf 'merge-gate: recorded landed marker refs/landed/ag-landing-%s -> %s\nPASS: merge-gate completed\n' "$case_name" "$other_sha" > "$gate_log"
      ;;
    missing-sha-binding)
      printf 'PASS: merge-gate completed\nPASS: suites=1 pushed=0 log=%s\n' "$gate_log" > "$gate_log"
      ;;
    omitted-sha)
      printf 'arbitrary text only\n' > "$gate_log"
      merged_sha=''
      ;;
    *) fail "unknown landing fixture" "$kind" ;;
  esac

  python3 - "$report_path" "$case_name" "$actual_sha" "$merged_sha" "$gate_log" "$proof_path" "$blockers" <<'PY'
import json
import sys
from pathlib import Path

report_path, case_name, head_sha, merged_sha, gate_log, proof_path, blockers = sys.argv[1:]
report = {
    "lane": f"ag-landing-{case_name}",
    "provider": "codex",
    "model": "fixture",
    "status": "done",
    "branch": f"ag-landing-{case_name}",
    "head_sha": head_sha,
    "launch_id": "landing-launch",
    "no_commits": True,
    "verification_scope": "landing validation fixture",
    "gate_log_path": gate_log,
    "lock_proof_paths": [proof_path],
    "started_at": "2026-07-19T00:00:00Z",
    "updated_at": "2026-07-19T00:01:00Z",
    "blockers": json.loads(blockers),
}
if merged_sha:
    report["merged_sha"] = merged_sha
Path(report_path).write_text(json.dumps(report))
PY
  printf '%s:%s\n' "$helper_runtime" "ag-landing-$case_name"
}

validate_landing_report() {
  local helper="$1" helper_runtime="$2" lane="$3"
  DISPATCH_RUNTIME_DIR="$helper_runtime" LANE_REPORT_DIR="$helper_runtime/lane-reports" "$helper" \
    --validate "$lane" --expect-launch-id landing-launch --expect-branch "$lane" \
    --expect-head-sha "$(git rev-parse HEAD)" --require-no-commits >/dev/null 2>&1
}

for rejected_case in blockers malformed-sha arbitrary-log mismatched-sha missing-sha-binding; do
  IFS=: read -r landing_runtime landing_lane < <(write_landing_report "$rejected_case" "$rejected_case")
  if ! validate_landing_report "$candidate_helper" "$landing_runtime" "$landing_lane"; then
    fail "RED-before candidate accepts $rejected_case" "candidate unexpectedly rejected the forged landing proof"
  fi
  if validate_landing_report "$ROOT/tools/orchestrator/lane-report.sh" "$landing_runtime" "$landing_lane"; then
    fail "GREEN-after rejects $rejected_case" "revised validator accepted the forged landing proof"
  fi
done
pass "RED-before/GREEN-after: candidate accepts and revision rejects contradictory or forged landing evidence"

IFS=: read -r landing_runtime landing_lane < <(write_landing_report omitted-sha omitted-sha)
if ! validate_landing_report "$parent_helper" "$landing_runtime" "$landing_lane"; then
  fail "RED-before parent accepts gate log without merged SHA" "parent unexpectedly rejected the omitted-SHA gate log"
fi
if validate_landing_report "$ROOT/tools/orchestrator/lane-report.sh" "$landing_runtime" "$landing_lane"; then
  fail "GREEN-after rejects gate log without merged SHA" "revised validator accepted omitted-SHA gate log evidence"
fi
pass "RED-before/GREEN-after: gate log without merged SHA is rejected"

IFS=: read -r landing_runtime landing_lane < <(write_landing_report valid valid)
validate_landing_report "$ROOT/tools/orchestrator/lane-report.sh" "$landing_runtime" "$landing_lane" \
  || fail "GREEN-after valid exact gate fixture remains accepted"
pass "GREEN-after: exact merge-gate PASS marker and merged SHA binding remain valid"

write_non_landing_report() {
  local proof_kind="$1" helper_runtime report_path proof_path
  helper_runtime="$tmpdir/non-landing-$proof_kind"
  mkdir -p "$helper_runtime/lane-reports"
  report_path="$helper_runtime/lane-reports/ag-non-landing-$proof_kind.json"
  proof_path="$helper_runtime/proof.txt"
  printf 'proof\n' > "$proof_path"

  python3 - "$report_path" "$proof_kind" "$(git rev-parse HEAD)" "$proof_path" <<'PY'
import json
import sys
from pathlib import Path

report_path, proof_kind, head_sha, proof_path = sys.argv[1:]
report = {
    "lane": f"ag-non-landing-{proof_kind}",
    "provider": "codex",
    "model": "fixture",
    "status": "done",
    "branch": f"ag-non-landing-{proof_kind}",
    "head_sha": head_sha,
    "launch_id": "non-landing-launch",
    "no_commits": True,
    "verification_scope": "non-landing validation fixture",
    "started_at": "2026-07-19T00:00:00Z",
    "updated_at": "2026-07-19T00:01:00Z",
    "blockers": [],
}
if proof_kind == "durable":
    report["lock_proof_paths"] = [proof_path]
else:
    report["live_lock_proof"] = proof_path
Path(report_path).write_text(json.dumps(report))
PY
  printf '%s:%s\n' "$helper_runtime" "ag-non-landing-$proof_kind"
}

validate_non_landing_report() {
  local helper_runtime="$1" lane="$2"
  DISPATCH_RUNTIME_DIR="$helper_runtime" LANE_REPORT_DIR="$helper_runtime/lane-reports" "$ROOT/tools/orchestrator/lane-report.sh" \
    --validate "$lane" --expect-launch-id non-landing-launch --expect-branch "$lane" \
    --expect-head-sha "$(git rev-parse HEAD)" --require-no-commits >/dev/null 2>&1
}

for proof_kind in durable live; do
  IFS=: read -r non_landing_runtime non_landing_lane < <(write_non_landing_report "$proof_kind")
  validate_non_landing_report "$non_landing_runtime" "$non_landing_lane" \
    || fail "GREEN-after non-landing $proof_kind proof remains accepted"
done
pass "GREEN-after: durable and live non-landing operator proofs remain valid without landing evidence"

IFS=: read -r _repo blocked_worktree blocked_runtime blocked_branch blocked_rc < <(run_case done-with-blockers current-launch current current blockers)
[ "$blocked_rc" = 1 ] || fail "done report with blockers exits failed" "expected rc=1, got $blocked_rc"
blocked_report="$blocked_runtime/lane-reports/$blocked_branch.json"
grep -Fq '"status":"failed"' "$blocked_report" || fail "done report with blockers is replaced with failed terminal state"
grep -Fq 'lane runner exited non-zero (rc=1)' "$blocked_report" || fail "done report with blockers records synthetic blocker"
[ ! -e "$blocked_worktree" ] || fail "done report with blockers empty worktree is reaped"
pass "GREEN-after: contradictory done plus blockers remains failed"

IFS=: read -r valid_repo valid_worktree valid_runtime valid_branch valid_rc < <(run_case valid current-launch current current)
[ "$valid_rc" = 0 ] || fail "GREEN-after valid operator report completes" "expected rc=0, got $valid_rc"
valid_report="$valid_runtime/lane-reports/$valid_branch.json"
grep -Fq '"status":"done"' "$valid_report" || fail "valid operator report stays done"
grep -Fq '"no_commits":true' "$valid_report" || fail "valid operator report marks no_commits"
[ ! -e "$valid_worktree" ] || fail "valid operator worktree is safely cleaned"
git -C "$valid_repo" show-ref --verify --quiet "refs/heads/$valid_branch" || fail "valid operator terminal branch is preserved"
pass "GREEN-after: identity-bound operator proof completes and cleans safely"

IFS=: read -r _repo unproved_worktree unproved_runtime unproved_branch unproved_rc < <(run_case unproved no-report current current)
[ "$unproved_rc" = 1 ] || fail "unproved operator lane exits failed" "expected rc=1, got $unproved_rc"
unproved_report="$unproved_runtime/lane-reports/$unproved_branch.json"
grep -Fq '"status":"failed"' "$unproved_report" || fail "unproved operator report is failed"
grep -Fq 'lane runner exited non-zero (rc=1)' "$unproved_report" || fail "unproved operator report records synthetic blocker"
[ ! -e "$unproved_worktree" ] || fail "unproved empty operator worktree is reaped"
pass "GREEN-after: unproved empty operator lane remains failed"

IFS=: read -r unproved_repo unproved_worktree unproved_runtime unproved_branch unproved_rc < <(run_case forged wrong-launch current current)
[ "$unproved_rc" = 1 ] || fail "forged launch report exits failed" "expected rc=1, got $unproved_rc"
unproved_report="$unproved_runtime/lane-reports/$unproved_branch.json"
grep -Fq '"status":"failed"' "$unproved_report" || fail "forged launch report is replaced with failed terminal state"
grep -Fq 'lane runner exited non-zero (rc=1)' "$unproved_report" || fail "forged launch report records synthetic blocker"
[ ! -e "$unproved_worktree" ] || fail "failed empty operator worktree is reaped"
pass "GREEN-after: forged launch ID cannot clear an empty lane"

for mismatch in branch head; do
  if [ "$mismatch" = branch ]; then
    IFS=: read -r _repo worktree runtime branch rc < <(run_case "mismatch-$mismatch" current-launch forged-branch current)
  else
    IFS=: read -r _repo worktree runtime branch rc < <(run_case "mismatch-$mismatch" current-launch current forged-head)
  fi
  [ "$rc" = 1 ] || fail "$mismatch mismatch exits failed" "expected rc=1, got $rc"
  grep -Fq '"status":"failed"' "$runtime/lane-reports/$branch.json" || fail "$mismatch mismatch cannot claim done"
  [ ! -e "$worktree" ] || fail "$mismatch mismatch empty worktree is reaped"
done
pass "GREEN-after: branch and head mismatches cannot clear an operator lane"

echo "operator no-commit proof regression lock passed"
