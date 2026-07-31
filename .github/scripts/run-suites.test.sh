#!/usr/bin/env bash
# Regression lock: no green-on-SKIP.
#
# A cross-vendor review found that run-suites.sh could record a SKIP row for a
# tracked, assigned suite whose requirement was unmet, never execute it, and
# still exit 0 — the coverage guard only proves a row EXISTS, not that the
# suite RAN, and the final check grepped FAIL alone. This lock plants exactly
# that situation in a scratch repo and asserts the runner exits non-zero.
#
# Cases:
#   1. unmet requirement  -> SKIP row is named AND the run exits non-zero
#   2. SUITES_ALLOW_SKIP=1 -> same run is waived (local-machine escape hatch)
#   3. fully runnable      -> passes with exit 0 and no skip noise
#   4. subject absent      -> NOT-APPLICABLE is distinct from PASS and SKIP
set -uo pipefail

RUNNER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/run-suites.sh"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/skip-gate-lock.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

FAILURES=0
check() { # description condition-already-evaluated-rc
  local desc="$1" rc="$2"
  if (( rc == 0 )); then
    printf 'ok    %s\n' "$desc"
  else
    printf 'FAIL  %s\n' "$desc" >&2
    FAILURES=$(( FAILURES + 1 ))
  fi
}

# Build a minimal repo the runner can discover suites in. group_members() uses
# `git ls-files`, so files must be in the index; no commit is needed.
make_repo() {
  local repo="$1"
  mkdir -p "$repo/.github/scripts"
  cp "$RUNNER" "$repo/.github/scripts/run-suites.sh"
  chmod +x "$repo/.github/scripts/run-suites.sh"
  git -C "$repo" init -q
}

run_runner() { # repo, extra env pairs...
  local repo="$1"; shift
  ( cd "$repo" && env -u SUITES_ALLOW_SKIP "$@" bash .github/scripts/run-suites.sh shell )
}

# ── Case 1: a suite with an unmet requirement must fail the run ────────────
# The planted suite mentions the daemon server entrypoint, which
# requirements_for() maps to the daemon-deps requirement; the scratch repo has
# no daemon/node_modules, so the requirement is unmet on every host — no
# reliance on what this machine has installed. The token is assembled so THIS
# file does not itself match the requirement grep when discovered by the outer
# runner.
REQ_TOKEN="daemon/ser""ver.ts"
REPO1="$WORK/repo-skip"
make_repo "$REPO1"
mkdir -p "$REPO1/planted"
cat > "$REPO1/planted/needs-daemon.test.sh" <<EOF
#!/usr/bin/env bash
# This suite boots ${REQ_TOKEN} and must not run without daemon deps.
exit 0
EOF
git -C "$REPO1" add -A

out1="$(run_runner "$REPO1" 2>&1)"
rc1=$?
check "unmet-requirement run exits non-zero (green-on-SKIP is the bug)" "$(( rc1 == 0 ? 1 : 0 ))"
grep -q 'SKIP  planted/needs-daemon.test.sh' <<<"$out1"
check "the skip is still named per-suite (honest degradation preserved)" "$?"
grep -q 'daemon/node_modules missing' <<<"$out1"
check "the skip carries its named unmet requirement" "$?"
grep -q 'SKIP-GATE FAIL: 1 suite(s) skipped' <<<"$out1"
check "the failure is attributed to the skip gate with a count" "$?"
if (( rc1 == 0 )); then
  printf '───── runner output (unexpected green) ─────\n%s\n─────\n' "$out1" >&2
fi

# ── Case 2: SUITES_ALLOW_SKIP=1 waives the gate, and only that ─────────────
out2="$(run_runner "$REPO1" SUITES_ALLOW_SKIP=1 2>&1)"
rc2=$?
check "SUITES_ALLOW_SKIP=1 waives the skip gate for local runs" "$(( rc2 == 0 ? 0 : 1 ))"
grep -q 'SKIP-GATE waived' <<<"$out2"
check "the waiver is loud, not silent" "$?"

# ── Case 3: a runnable group still passes clean ────────────────────────────
REPO3="$WORK/repo-pass"
make_repo "$REPO3"
mkdir -p "$REPO3/planted"
cat > "$REPO3/planted/plain.test.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
git -C "$REPO3" add -A

out3="$(run_runner "$REPO3" 2>&1)"
rc3=$?
check "requirement-free group passes with exit 0" "$(( rc3 == 0 ? 0 : 1 ))"
grep -q 'PASS  planted/plain.test.sh' <<<"$out3"
check "the planted suite actually executed" "$?"
grep -q 'SKIP-GATE' <<<"$out3"
check "no skip-gate output on a zero-skip run" "$(( $? == 0 ? 1 : 0 ))"

# ── Case 4: a checker with no subject is named NOT-APPLICABLE ──────────────
REPO4="$WORK/repo-not-applicable"
make_repo "$REPO4"
mkdir -p "$REPO4/tools/subject"
cat > "$REPO4/tools/subject/check.ts" <<'EOF'
console.log('NOT-APPLICABLE SUBJECT: positive runtime evidence absent');
EOF
git -C "$REPO4" add -A
out4="$(cd "$REPO4" && bash .github/scripts/run-suites.sh checks 2>&1)"
rc4=$?
check "not-applicable checker exits the group cleanly" "$(( rc4 == 0 ? 0 : 1 ))"
grep -q 'N/A   tools/subject/check.ts' <<<"$out4"
check "not-applicable is reported distinctly from PASS" "$?"
grep -q 'SKIP-GATE' <<<"$out4"
check "not-applicable does not enter the skip gate" "$(( $? == 0 ? 1 : 0 ))"

if (( FAILURES > 0 )); then
  printf '%d assertion(s) failed\n' "$FAILURES" >&2
  exit 1
fi
printf 'all skip-gate lock assertions passed\n'
exit 0
