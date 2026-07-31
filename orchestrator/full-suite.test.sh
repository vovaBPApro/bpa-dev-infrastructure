#!/usr/bin/env bash
# Real-subprocess fixtures for the nightly full-suite timer tick and digest row.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FULL_SUITE_SCRIPT="${FULL_SUITE_SCRIPT:-$SCRIPT_DIR/full-suite.sh}"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

grep -Fxq 'EnvironmentFile=-$ENV_FILE' "$SCRIPT_DIR/../bootstrap/units/bpa-full-suite.service.in"
grep -Fxq 'EnvironmentFile=-$ENV_FILE' "$SCRIPT_DIR/../bootstrap/units/orch-morning-report.service.in"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
assert() { "$@" || fail "$*"; }
assert_not() { if "$@"; then fail "unexpected success: $*"; fi; }
contains() { grep -Fq -- "$1" "$2" || fail "missing: $1"; }
not_exists() { [[ ! -e "$1" ]] || fail "unexpected file: $1"; }

make_suite_tree() {
  local root="$1" failing="${2:-true}"
  mkdir -p "$root/gate" "$root/orchestrator"
  printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$root/gate/pass.test.sh"
  printf '%s\n' '#!/usr/bin/env bash' "exit $([[ "$failing" == true ]] && printf 7 || printf 0)" > "$root/orchestrator/fail.test.sh"
  chmod +x "$root/gate/pass.test.sh" "$root/orchestrator/fail.test.sh"
}

add_frozen_reference_suite() {
  local root="$1"
  mkdir -p "$root/migration-prep/reference-daemon/test"
  printf '%s\n' '#!/usr/bin/env bash' 'exit 23' > "$root/migration-prep/reference-daemon/test/frozen.test.sh"
  chmod +x "$root/migration-prep/reference-daemon/test/frozen.test.sh"
}

run_tick() {
  local root="$1" runtime="$2" outbox="$3"
  ORCH_CONFIG_FILE="$SCRATCH/no-runtime.env" ORCH_INSTALL_ROOT="$root" ORCH_RUNTIME_DIR="$runtime" \
    FULL_SUITE_LOG="$runtime/full-suite.log" NUDGE_OUTBOX_FILE="$outbox" \
    FULL_SUITE_NUDGE_REPEAT_MS=3600000 "$FULL_SUITE_SCRIPT"
}

# Regression lock for the live-state stomp: discard the entire inherited
# ORCH_* namespace, including unknown future names, and run in a copied tree.
ISOLATION_ROOT="$SCRATCH/isolation-repo"
ISOLATION_RUNTIME="$SCRATCH/isolation-runtime"
LIVE_HEARTBEAT="$SCRATCH/live.heartbeat"
LIVE_STATE="$SCRATCH/live.state.db"
mkdir -p "$ISOLATION_ROOT"
printf 'operator heartbeat\n' > "$LIVE_HEARTBEAT"
printf 'operator state\n' > "$LIVE_STATE"
printf '%s\n' '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  '[[ -z "${ORCH_HEARTBEAT_FILE+x}" ]]' \
  '[[ -z "${ORCH_FUTURE_STATE_POINTER+x}" ]]' \
  '[[ "$PWD" != "'"$ISOLATION_ROOT"'" ]]' \
  '[[ "$ORCH_STATE_DB" == "$ORCH_RUNTIME_DIR/state.db" ]]' \
  'printf isolated > relative-write' > "$ISOLATION_ROOT/isolation.test.sh"
chmod +x "$ISOLATION_ROOT/isolation.test.sh"
before_isolation="$(md5sum "$LIVE_HEARTBEAT" "$LIVE_STATE")"
assert env ORCH_HEARTBEAT_FILE="$LIVE_HEARTBEAT" ORCH_FUTURE_STATE_POINTER="$LIVE_STATE" \
  ORCH_STATE_DB="$LIVE_STATE" ORCH_CONFIG_FILE="$SCRATCH/no-runtime.env" \
  ORCH_INSTALL_ROOT="$ISOLATION_ROOT" ORCH_RUNTIME_DIR="$ISOLATION_RUNTIME" \
  FULL_SUITE_LOG="$ISOLATION_RUNTIME/full-suite.log" "$FULL_SUITE_SCRIPT"
after_isolation="$(md5sum "$LIVE_HEARTBEAT" "$LIVE_STATE")"
[[ "$before_isolation" == "$after_isolation" ]] || fail 'live ORCH_* targets changed'
not_exists "$ISOLATION_ROOT/relative-write"
contains 'pass=1 fail=0' "$ISOLATION_RUNTIME/full-suite.log"

MORNING_SCRIPT="${MORNING_SCRIPT:-$SCRIPT_DIR/morning.sh}"

# A TypeScript-only red tree must be discovered, reported, and make the core
# runner fail. This is the regression lock for the previously invisible suites.
TS_RED_ROOT="$SCRATCH/ts-red-repo"
TS_RED_RUNTIME="$SCRATCH/ts-red-runtime"
mkdir -p "$TS_RED_ROOT"
printf '%s\n' \
  'import { expect, test } from "bun:test";' \
  'test("red fixture", () => expect(1).toBe(2));' > "$TS_RED_ROOT/red.test.ts"
assert_not run_tick "$TS_RED_ROOT" "$TS_RED_RUNTIME" "$SCRATCH/ts-red.outbox"
contains 'suite=red.test.ts rc=' "$TS_RED_RUNTIME/full-suite.log"
contains 'failed=red.test.ts' "$TS_RED_RUNTIME/full-suite.log"

# TypeScript and shell discovery are additive: a green TS suite still runs
# when a shell suite is red, and the aggregate remains red.
MIXED_ROOT="$SCRATCH/mixed-repo"
MIXED_RUNTIME="$SCRATCH/mixed-runtime"
mkdir -p "$MIXED_ROOT"
printf '%s\n' \
  'import { expect, test } from "bun:test";' \
  'test("green fixture", () => expect(1).toBe(1));' > "$MIXED_ROOT/green.test.ts"
printf '%s\n' '#!/usr/bin/env bash' 'printf "shell-red-ran\n"' 'exit 9' > "$MIXED_ROOT/red.test.sh"
chmod +x "$MIXED_ROOT/red.test.sh"
assert_not run_tick "$MIXED_ROOT" "$MIXED_RUNTIME" "$SCRATCH/mixed.outbox"
contains 'suite=green.test.ts rc=0' "$MIXED_RUNTIME/full-suite.log"
contains 'shell-red-ran' "$MIXED_RUNTIME/full-suite.log"
contains 'suite=red.test.sh rc=9' "$MIXED_RUNTIME/full-suite.log"
grep -Eq 'FULL-SUITE ts=.* fail=[1-9][0-9]* ' "$MIXED_RUNTIME/full-suite.log" \
  || fail 'aggregate fail count was not positive'

FAIL_ROOT="$SCRATCH/failing-repo"
FAIL_RUNTIME="$SCRATCH/failing-runtime"
FAIL_OUTBOX="$SCRATCH/failing.outbox"
make_suite_tree "$FAIL_ROOT"
assert_not run_tick "$FAIL_ROOT" "$FAIL_RUNTIME" "$FAIL_OUTBOX"
contains 'FULL-SUITE SUITE ts=' "$FAIL_RUNTIME/full-suite.log"
contains 'suite=gate/pass.test.sh rc=0' "$FAIL_RUNTIME/full-suite.log"
contains 'suite=orchestrator/fail.test.sh rc=7' "$FAIL_RUNTIME/full-suite.log"
contains 'FULL-SUITE ts=' "$FAIL_RUNTIME/full-suite.log"
contains 'pass=1 fail=1 skipped=0 failed=orchestrator/fail.test.sh skipped_list=none' "$FAIL_RUNTIME/full-suite.log"
contains 'NUDGE full-suite pass=1 fail=1 failed=orchestrator/fail.test.sh' "$FAIL_OUTBOX"
first_nudges="$(wc -l < "$FAIL_OUTBOX")"
assert_not run_tick "$FAIL_ROOT" "$FAIL_RUNTIME" "$FAIL_OUTBOX"
[[ "$(wc -l < "$FAIL_OUTBOX")" == "$first_nudges" ]] || fail 'full-suite nudge ignored rate limit'

PASS_ROOT="$SCRATCH/passing-repo"
PASS_RUNTIME="$SCRATCH/passing-runtime"
PASS_OUTBOX="$SCRATCH/passing.outbox"
make_suite_tree "$PASS_ROOT" false
assert run_tick "$PASS_ROOT" "$PASS_RUNTIME" "$PASS_OUTBOX"
contains 'pass=2 fail=0 skipped=0 failed=none skipped_list=none' "$PASS_RUNTIME/full-suite.log"
not_exists "$PASS_OUTBOX"

# Frozen reference suites are visibly skipped by the default exclusion and do
# not turn an otherwise green target-runtime sweep red.
EXCLUDED_ROOT="$SCRATCH/excluded-repo"
EXCLUDED_RUNTIME="$SCRATCH/excluded-runtime"
EXCLUDED_OUTBOX="$SCRATCH/excluded.outbox"
make_suite_tree "$EXCLUDED_ROOT" false
add_frozen_reference_suite "$EXCLUDED_ROOT"
assert run_tick "$EXCLUDED_ROOT" "$EXCLUDED_RUNTIME" "$EXCLUDED_OUTBOX"
contains 'suite=migration-prep/reference-daemon/test/frozen.test.sh rc=SKIP reason=excluded' "$EXCLUDED_RUNTIME/full-suite.log"
contains 'pass=2 fail=0 skipped=1 failed=none skipped_list=migration-prep/reference-daemon/test/frozen.test.sh' "$EXCLUDED_RUNTIME/full-suite.log"
not_exists "$EXCLUDED_OUTBOX"

# A bogus numeric rate interval must be logged and replaced with the safe
# default, without preventing the tick from reporting its red suite.
KNOB_RUNTIME="$SCRATCH/knob-runtime"
assert_not env ORCH_CONFIG_FILE="$SCRATCH/no-runtime.env" ORCH_INSTALL_ROOT="$FAIL_ROOT" ORCH_RUNTIME_DIR="$KNOB_RUNTIME" \
  FULL_SUITE_LOG="$KNOB_RUNTIME/full-suite.log" NUDGE_OUTBOX_FILE="$KNOB_RUNTIME/nudges.outbox" \
  FULL_SUITE_NUDGE_REPEAT_MS=garbage "$FULL_SUITE_SCRIPT"
contains 'FULL-SUITE invalid-knob name=FULL_SUITE_NUDGE_REPEAT_MS value=garbage using-default=21600000' "$KNOB_RUNTIME/full-suite.log"

# Invalid exclusion selectors fall back to the documented frozen-reference
# default instead of silently running or skipping an arbitrary path.
EXCLUDE_KNOB_RUNTIME="$SCRATCH/exclude-knob-runtime"
assert env ORCH_CONFIG_FILE="$SCRATCH/no-runtime.env" ORCH_INSTALL_ROOT="$EXCLUDED_ROOT" ORCH_RUNTIME_DIR="$EXCLUDE_KNOB_RUNTIME" \
  FULL_SUITE_LOG="$EXCLUDE_KNOB_RUNTIME/full-suite.log" NUDGE_OUTBOX_FILE="$EXCLUDE_KNOB_RUNTIME/nudges.outbox" \
  FULL_SUITE_EXCLUDE=garbage "$FULL_SUITE_SCRIPT"
contains 'FULL-SUITE invalid-knob name=FULL_SUITE_EXCLUDE value=garbage using-default=migration-prep/' "$EXCLUDE_KNOB_RUNTIME/full-suite.log"
contains 'pass=2 fail=0 skipped=1 failed=none skipped_list=migration-prep/reference-daemon/test/frozen.test.sh' "$EXCLUDE_KNOB_RUNTIME/full-suite.log"

MISSING_RUNTIME="$SCRATCH/missing-runtime"
assert_not env ORCH_CONFIG_FILE="$SCRATCH/no-runtime.env" ORCH_INSTALL_ROOT="$SCRATCH/absent-repo" ORCH_RUNTIME_DIR="$MISSING_RUNTIME" \
  FULL_SUITE_LOG="$MISSING_RUNTIME/full-suite.log" "$FULL_SUITE_SCRIPT"
contains 'FULL-SUITE SKIP reason=repo-root-absent' "$MISSING_RUNTIME/full-suite.log"

# The morning digest reads the last durable summary and remains fail-soft when
# it is absent. A minimal real git/Bun fixture keeps this a subprocess test.
MORNING_REPO="$SCRATCH/morning-repo"
MORNING_RUNTIME="$SCRATCH/morning-runtime"
MORNING_BIN="$SCRATCH/morning-bin"
mkdir -p "$MORNING_REPO" "$MORNING_RUNTIME" "$MORNING_BIN"
git -C "$MORNING_REPO" init -q
git -C "$MORNING_REPO" config user.email test@example.invalid
git -C "$MORNING_REPO" config user.name test
printf 'fixture\n' > "$MORNING_REPO/fixture"
git -C "$MORNING_REPO" add fixture
git -C "$MORNING_REPO" commit -qm fixture
printf '%s\n' '#!/usr/bin/env bash' 'printf "PASS fixture bootstrap\\n"' > "$SCRATCH/bootstrap.sh"
printf '%s\n' '#!/usr/bin/env bash' 'exit 1' > "$MORNING_BIN/docker"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$MORNING_BIN/systemctl"
chmod +x "$SCRATCH/bootstrap.sh" "$MORNING_BIN/docker" "$MORNING_BIN/systemctl"
BUN_PATH="$(command -v bun)"
MISSION_CLI="$SCRIPT_DIR/../core/mission-cli.ts"
INFRA_STATE_DB="$MORNING_RUNTIME/state.db" "$BUN_PATH" "$MISSION_CLI" mission create full-suite-fixture >/dev/null
run_morning() {
  env PATH="$MORNING_BIN:$PATH" ORCH_CONFIG_FILE="$SCRATCH/no-runtime.env" ORCH_RUNTIME_DIR="$MORNING_RUNTIME" \
  FULL_SUITE_LOG="$MORNING_RUNTIME/full-suite.log" MORNING_REPO_ROOT="$MORNING_REPO" MORNING_BOOTSTRAP_SCRIPT="$SCRATCH/bootstrap.sh" \
  MORNING_MISSION_CLI="$MISSION_CLI" INFRA_STATE_DB="$MORNING_RUNTIME/state.db" BUN_BIN="$BUN_PATH" \
  "$MORNING_SCRIPT" --dry-run
}

# Feed the exact, durable production summary emitted by full-suite.sh into the
# morning parser. This locks both scripts to the same summary format.
tail -n 1 "$FAIL_RUNTIME/full-suite.log" > "$MORNING_RUNTIME/full-suite.log"
MORNING_FAIL="$SCRATCH/morning-fail.out"
MORNING_FAIL_ERR="$SCRATCH/morning-fail.err"
assert_not run_morning > "$MORNING_FAIL" 2> "$MORNING_FAIL_ERR"
contains 'FAIL — FULL-SUITE (pass=1 fail=1 skipped=0 failed=orchestrator/fail.test.sh skipped_list=none age_s=' "$MORNING_FAIL"
assert_not grep -Fq 'SKIP — FULL-SUITE' "$MORNING_FAIL"
contains 'Morning readiness failed; digest was not delivered.' "$MORNING_FAIL_ERR"

tail -n 1 "$PASS_RUNTIME/full-suite.log" > "$MORNING_RUNTIME/full-suite.log"
MORNING_OUTPUT="$SCRATCH/morning-pass.out"
assert run_morning > "$MORNING_OUTPUT"
contains 'PASS — FULL-SUITE (pass=2 fail=0 skipped=0 age_s=' "$MORNING_OUTPUT"
rm -f "$MORNING_RUNTIME/full-suite.log"
MORNING_SKIP="$SCRATCH/morning-skip.out"
assert run_morning > "$MORNING_SKIP"
contains 'SKIP — FULL-SUITE (summary log absent)' "$MORNING_SKIP"

printf 'full-suite tests: PASS\n'
