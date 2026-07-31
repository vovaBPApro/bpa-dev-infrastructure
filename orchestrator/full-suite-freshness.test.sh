#!/usr/bin/env bash
# Regression lock: a hung nightly suite and stale green evidence must fail closed.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
contains() { grep -Fq -- "$1" "$2" || fail "missing: $1"; }

SUITE_ROOT="$SCRATCH/suites"
SUITE_RUNTIME="$SCRATCH/suite-runtime"
mkdir -p "$SUITE_ROOT"
printf '%s\n' '#!/usr/bin/env bash' 'sleep 30' > "$SUITE_ROOT/hung.test.sh"
chmod +x "$SUITE_ROOT/hung.test.sh"
set +e
timeout 5 env ORCH_CONFIG_FILE="$SCRATCH/no-runtime.env" ORCH_INSTALL_ROOT="$SUITE_ROOT" \
  ORCH_RUNTIME_DIR="$SUITE_RUNTIME" FULL_SUITE_LOG="$SUITE_RUNTIME/full-suite.log" \
  NUDGE_OUTBOX_FILE="$SUITE_RUNTIME/nudges.outbox" FULL_SUITE_TIMEOUT_S=1 \
  "$SCRIPT_DIR/full-suite.sh"
rc=$?
set -e
[[ "$rc" != 0 ]] || fail 'hung suite unexpectedly passed'
[[ "$rc" != 124 ]] || fail 'full-suite runner itself hung past the outer lock timeout'
contains 'suite=hung.test.sh rc=124' "$SUITE_RUNTIME/full-suite.log"
contains 'pass=0 fail=1 skipped=0 failed=hung.test.sh' "$SUITE_RUNTIME/full-suite.log"

REPO="$SCRATCH/repo"
RUNTIME="$SCRATCH/morning-runtime"
BIN="$SCRATCH/bin"
mkdir -p "$REPO" "$RUNTIME" "$BIN"
git -C "$REPO" init -q
git -C "$REPO" config user.email test@example.invalid
git -C "$REPO" config user.name test
printf 'fixture\n' > "$REPO/fixture"
git -C "$REPO" add fixture
git -C "$REPO" commit -qm fixture
printf '%s\n' '#!/usr/bin/env bash' 'printf "PASS fixture bootstrap\\n"' > "$SCRATCH/bootstrap.sh"
printf '%s\n' '#!/usr/bin/env bash' 'exit 1' > "$BIN/docker"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$BIN/systemctl"
chmod +x "$SCRATCH/bootstrap.sh" "$BIN/docker" "$BIN/systemctl"
BUN_PATH="$(command -v bun)"
MISSION_CLI="$SCRIPT_DIR/../core/mission-cli.ts"
INFRA_STATE_DB="$RUNTIME/state.db" "$BUN_PATH" "$MISSION_CLI" mission create freshness-fixture >/dev/null

run_morning() {
  env PATH="$BIN:$PATH" ORCH_CONFIG_FILE="$SCRATCH/no-runtime.env" ORCH_RUNTIME_DIR="$RUNTIME" \
    FULL_SUITE_LOG="$RUNTIME/full-suite.log" FULL_SUITE_MAX_AGE_S=3600 \
    MORNING_REPO_ROOT="$REPO" MORNING_BOOTSTRAP_SCRIPT="$SCRATCH/bootstrap.sh" \
    MORNING_MISSION_CLI="$MISSION_CLI" INFRA_STATE_DB="$RUNTIME/state.db" BUN_BIN="$BUN_PATH" \
    "$SCRIPT_DIR/morning.sh" --dry-run
}

old_ts="$(date -u -d '2 hours ago' +%Y-%m-%dT%H:%M:%SZ)"
printf 'FULL-SUITE ts=%s pass=2 fail=0 skipped=0 failed=none skipped_list=none duration_s=1\n' "$old_ts" > "$RUNTIME/full-suite.log"
if run_morning > "$SCRATCH/stale.out" 2> "$SCRATCH/stale.err"; then
  fail 'stale green summary produced a successful morning digest'
fi
contains 'FAIL — FULL-SUITE' "$SCRATCH/stale.out"
contains 'reason=stale' "$SCRATCH/stale.out"

fresh_ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf 'FULL-SUITE ts=%s pass=2 fail=0 skipped=0 failed=none skipped_list=none duration_s=1\n' "$fresh_ts" > "$RUNTIME/full-suite.log"
run_morning > "$SCRATCH/fresh.out"
contains 'PASS — FULL-SUITE (pass=2 fail=0 skipped=0 age_s=' "$SCRATCH/fresh.out"

printf 'full-suite freshness tests: PASS\n'
