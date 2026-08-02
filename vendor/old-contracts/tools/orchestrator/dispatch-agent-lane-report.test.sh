#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NEW_DISPATCH="$ROOT/tools/orchestrator/dispatch-agent.sh"
LANE_REPORT="$ROOT/tools/orchestrator/lane-report.sh"

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"; rm -f /tmp/ag-report-old.log /tmp/ag-report-new.log /tmp/ag-report-preflight.log /tmp/ag-report-write-fail.log' EXIT
OLD_DISPATCH="$tmpdir/dispatch-agent-legacy.sh"

pass() { printf 'PASS %s\n' "$1"; }
fail() {
  printf 'FAIL %s\n%s\n' "$1" "${2:-}" >&2
  exit 1
}

CASE_FILTER="${DISPATCH_AGENT_LANE_REPORT_CASE_FILTER:-}"
NEW_FAIL_FAST_CASE="headroom-preflight-fail-fast-no-spawn"

assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  if ! grep -Fq "$needle" <<<"$haystack"; then
    fail "$label" "expected to find: $needle"$'\n'"output:"$'\n'"$haystack"
  fi
}

require_cc() {
  command -v cc >/dev/null 2>&1 || fail "fixture toolchain present" "cc is required: cannot build ENOSPC or headroom-preflight C fixtures"
}

git_cfg() {
  git -C "$1" config user.email "dispatch-report-test@example.test"
  git -C "$1" config user.name "Dispatch Report Test"
}

make_repo() {
  local repo="$1"
  git init -q "$repo"
  git_cfg "$repo"
  git -C "$repo" checkout -q -b dev
  printf 'init\n' > "$repo/README.md"
  mkdir -p "$repo/node_modules" "$repo/packages/fixture/node_modules/vitest"
  printf '{"name":"dispatch-lane-report-fixture","devDependencies":{"vitest":"*"}}\n' > "$repo/packages/fixture/package.json"
  git -C "$repo" add README.md packages/fixture/package.json
  git -C "$repo" commit -q -m "init"
}

write_codex_stub() {
  local bin_dir="$1"
  cat > "$bin_dir/codex" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [ -n "${FAKE_CODEX_RUN_LOG:-}" ]; then
  printf 'codex invoked\n' >> "$FAKE_CODEX_RUN_LOG"
fi
if [ -n "${FAKE_CODEX_VITEST_ENV_LOG:-}" ]; then
  printf 'cap=%s maxForks=%s fileParallelism=%s\n' \
    "${ORCH_LANE_VITEST_CAP_ACTIVE:-}" \
    "${ORCH_LANE_VITEST_MAX_FORKS:-}" \
    "${ORCH_LANE_VITEST_FILE_PARALLELISM:-}" >> "$FAKE_CODEX_VITEST_ENV_LOG"
fi
if [ "${FAKE_CODEX_COMMIT:-0}" = "1" ]; then
  printf 'terminal proof retry fixture\n' > terminal-proof-retry.txt
  git add terminal-proof-retry.txt
  git commit -qm "fixture terminal proof retry"
fi
printf 'OpenAI Codex v0.142.4\n'
printf 'provider: openai\n'
printf 'session id: lane-report-test\n'
exit 0
EOF
  chmod +x "$bin_dir/codex"
}

write_pnpm_stub() {
  local bin_dir="$1"
  cat > "$bin_dir/pnpm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = "exec" ] && [ "${2:-}" = "vitest" ] && [ "${3:-}" = "--version" ]; then
  case " $* " in
    *' --poolOptions.forks.maxForks=2 '* ) ;;
    *) exit 64 ;;
  esac
  case " $* " in
    *' --no-file-parallelism '* ) ;;
    *) exit 64 ;;
  esac
  [ "${ORCH_LANE_VITEST_CAP_ACTIVE:-}" = "1" ] || exit 64
  [ "${ORCH_LANE_VITEST_MAX_FORKS:-}" = "2" ] || exit 64
  [ "${ORCH_LANE_VITEST_FILE_PARALLELISM:-}" = "false" ] || exit 64
  printf 'vitest fixture\n'
  exit 0
fi
exit 64
EOF
  chmod +x "$bin_dir/pnpm"
}

write_legacy_dispatch_script() {
  cat > "$OLD_DISPATCH" <<'EOF'
#!/usr/bin/env bash
set -u

PROVIDER=""; NAME=""; BASE=""; PROMPT=""; MODEL=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --provider) PROVIDER="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --base) BASE="$2"; shift 2 ;;
    --prompt) PROMPT="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    *) shift ;;
  esac
done

REPO="$(git rev-parse --show-toplevel)"
WT="$REPO/.claude/worktrees/ag-$NAME"
BR="ag-$NAME"
LOG="/tmp/ag-$NAME.log"

git worktree remove --force "$WT" 2>/dev/null || true
git branch -D "$BR" 2>/dev/null || true
git worktree prune 2>/dev/null || true
git worktree add -b "$BR" "$WT" "$BASE" >/dev/null 2>&1 || exit 1

CMD="codex exec --ephemeral --model \"$MODEL\" --dangerously-bypass-approvals-and-sandbox -C \"$WT\" \"$(cat "$PROMPT")\" </dev/null"

legacy_run_agent() {
  cd "$WT" || exit 1
  eval "$CMD" >> "$LOG" 2>&1
  RC=$?
  COMMITS="$(git -C "$WT" rev-list --count "$BASE..HEAD" 2>/dev/null || echo 0)"
  DIRTY="$(git -C "$WT" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
  echo "=== $NAME EXIT rc=$RC commits=$COMMITS dirty=$DIRTY $(date) ===" >> "$LOG"
  if [ "$COMMITS" = "0" ] && [ "$DIRTY" = "0" ]; then
    cd "$REPO" 2>/dev/null || cd /
    git -C "$REPO" worktree remove --force "$WT" 2>/dev/null || true
    git -C "$REPO" branch -D "$BR" 2>/dev/null || true
    git -C "$REPO" worktree prune 2>/dev/null || true
  fi
}

export BASE CMD LOG NAME REPO WT
export -f legacy_run_agent
setsid bash -lc 'legacy_run_agent' >/dev/null 2>&1 &
sleep 2
exit 0
EOF
  chmod +x "$OLD_DISPATCH"
}

build_enospc_rename_preload() {
  local source_path="$1" library_path="$2"
  mkdir -p "$(dirname "$source_path")" "$(dirname "$library_path")"
  python3 - "$source_path" <<'PY'
import sys
from pathlib import Path

Path(sys.argv[1]).write_text(
    r'''#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <linux/fs.h>
#include <limits.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <unistd.h>

static int failure_budget(void) {
  const char *raw = getenv("ORCH_TEST_ENOSPC_MAX_HITS");
  if (raw == NULL || *raw == '\0') {
    return 0;
  }
  return atoi(raw);
}

static int should_fail_path(const char *path) {
  const char *target = getenv("ORCH_TEST_ENOSPC_TARGET");
  const char *hits_path = getenv("ORCH_TEST_ENOSPC_HITS_FILE");
  FILE *hits_file;
  char buffer[64];
  long hits = 0;
  int budget = failure_budget();

  if (budget <= 0 || target == NULL || hits_path == NULL) {
    return 0;
  }
  if (strcmp(path, target) != 0) {
    return 0;
  }

  hits_file = fopen(hits_path, "r");
  if (hits_file != NULL) {
    if (fgets(buffer, sizeof(buffer), hits_file) != NULL) {
      hits = strtol(buffer, NULL, 10);
    }
    fclose(hits_file);
  }
  if (hits >= budget) {
    return 0;
  }

  hits += 1;
  hits_file = fopen(hits_path, "w");
  if (hits_file != NULL) {
    fprintf(hits_file, "%ld\n", hits);
    fclose(hits_file);
  }
  errno = ENOSPC;
  return 1;
}

static int (*real_rename_fn)(const char *, const char *);
static int (*real_renameat_fn)(int, const char *, int, const char *);
static int (*real_renameat2_fn)(int, const char *, int, const char *, unsigned int);

int rename(const char *oldpath, const char *newpath) {
  if (should_fail_path(newpath)) {
    return -1;
  }
  if (real_rename_fn == NULL) {
    real_rename_fn = dlsym(RTLD_NEXT, "rename");
  }
  return real_rename_fn(oldpath, newpath);
}

int renameat(int olddirfd, const char *oldpath, int newdirfd, const char *newpath) {
  if (should_fail_path(newpath)) {
    return -1;
  }
  if (real_renameat_fn == NULL) {
    real_renameat_fn = dlsym(RTLD_NEXT, "renameat");
  }
  return real_renameat_fn(olddirfd, oldpath, newdirfd, newpath);
}

int renameat2(int olddirfd, const char *oldpath, int newdirfd, const char *newpath, unsigned int flags) {
  if (should_fail_path(newpath)) {
    return -1;
  }
  if (real_renameat2_fn == NULL) {
    real_renameat2_fn = dlsym(RTLD_NEXT, "renameat2");
  }
  if (real_renameat2_fn != NULL) {
    return real_renameat2_fn(olddirfd, oldpath, newdirfd, newpath, flags);
  }
  return syscall(SYS_renameat2, olddirfd, oldpath, newdirfd, newpath, flags);
}
''',
    encoding="utf-8",
)
PY
  cc -shared -fPIC -O2 -Wall -Wextra -o "$library_path" "$source_path" -ldl
}

build_low_headroom_stat_stub() {
  local source_path="$1" binary_path="$2"
  mkdir -p "$(dirname "$source_path")" "$(dirname "$binary_path")"
  python3 - "$source_path" <<'PY'
import sys
from pathlib import Path

Path(sys.argv[1]).write_text(
    r'''#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static int should_fake(int argc, char **argv) {
  const char *target = getenv("ORCH_TEST_HEADROOM_TARGET");
  int saw_filesystem_flag = 0;
  int saw_format_flag = 0;

  if (target == NULL || *target == '\0' || argc < 2) {
    return 0;
  }

  for (int index = 1; index < argc - 1; index += 1) {
    if (strcmp(argv[index], "-f") == 0) {
      saw_filesystem_flag = 1;
    }
    if (strcmp(argv[index], "-c") == 0) {
      saw_format_flag = 1;
    }
  }

  return saw_filesystem_flag && saw_format_flag && strcmp(argv[argc - 1], target) == 0;
}

int main(int argc, char **argv) {
  const char *real_stat = getenv("ORCH_TEST_REAL_STAT");
  const char *stats = getenv("ORCH_TEST_HEADROOM_STATS");

  if (should_fake(argc, argv)) {
    puts((stats != NULL && *stats != '\0') ? stats : "1 4096 1");
    return 0;
  }

  if (real_stat == NULL || *real_stat == '\0') {
    fprintf(stderr, "fake-stat: ORCH_TEST_REAL_STAT missing\n");
    return 70;
  }

  execv(real_stat, argv);
  perror("fake-stat: execv real stat");
  return 71;
}
''',
    encoding="utf-8",
)
PY
  cc -O2 -Wall -Wextra -o "$binary_path" "$source_path"
}

write_headroom_helper_wrapper() {
  local wrapper_path="$1" fake_stat_dir="$2" real_stat="$3" helper_path="$4"
  cat > "$wrapper_path" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export PATH="$fake_stat_dir:\$PATH"
export ORCH_TEST_REAL_STAT="$real_stat"
exec "$helper_path" "\$@"
EOF
  chmod +x "$wrapper_path"
}

run_dispatch() {
  local script="$1" repo="$2" bin_dir="$3" codex_home="$4" runtime_dir="$5" prompt="$6" name="$7"
  local lane_tmp_root="${8:-$runtime_dir/lane-tmp-root}"
  (
    cd "$repo"
    env \
      PATH="$bin_dir:$PATH" \
      CODEX_HOME_SHARED="$codex_home" \
      ORCH_SKIP_DOCKER_REAP=1 \
      ORCH_LANE_TMP_ROOT="$lane_tmp_root" \
      DISPATCH_LANE_DETACH_MODE=never \
      DISPATCH_RUNTIME_DIR="$runtime_dir" \
      LANE_REPORT_HELPER="$LANE_REPORT" \
      DISPATCH_SPAWN_CONFIRM_TIMEOUT=6 \
      DISPATCH_SPAWN_CONFIRM_POLL_INTERVAL=1 \
      "$script" --provider codex --name "$name" --base dev --prompt "$prompt" --model good-marker
  )
}

run_dispatch_with_report_dir() {
  local script="$1" repo="$2" bin_dir="$3" codex_home="$4" runtime_dir="$5" prompt="$6" name="$7" report_dir="$8" lane_tmp_root="$9"
  (
    cd "$repo"
    env \
      PATH="$bin_dir:$PATH" \
      CODEX_HOME_SHARED="$codex_home" \
      ORCH_SKIP_DOCKER_REAP=1 \
      ORCH_LANE_TMP_ROOT="$lane_tmp_root" \
      DISPATCH_LANE_DETACH_MODE=never \
      DISPATCH_RUNTIME_DIR="$runtime_dir" \
      DISPATCH_EPHEMERAL_ROOT="$lane_tmp_root/dispatcher" \
      LANE_REPORT_DIR="$report_dir" \
      LANE_REPORT_HELPER="$LANE_REPORT" \
      DISPATCH_SPAWN_CONFIRM_TIMEOUT=6 \
      DISPATCH_SPAWN_CONFIRM_POLL_INTERVAL=1 \
      "$script" --provider codex --name "$name" --base dev --prompt "$prompt" --model good-marker
  )
}

assert_json_value() {
  local report_path="$1" expression="$2" expected="$3" label="$4"
  local actual
  actual="$(python3 - "$report_path" "$expression" <<'PY'
import json
import sys

data = json.load(open(sys.argv[1]))
expr = sys.argv[2]
value = data
for part in expr.split("."):
    if part == "":
        continue
    value = value[part]
if value is None:
    print("null")
elif isinstance(value, list):
    print(json.dumps(value))
else:
    print(value)
PY
)"
  [ "$actual" = "$expected" ] || fail "$label" "expected $expression=$expected"$'\n'"actual: $actual"
}

assert_file_missing() {
  local path="$1" label="$2"
  [ ! -e "$path" ] || fail "$label" "unexpected path exists: $path"
}

assert_file_exists() {
  local path="$1" label="$2"
  [ -e "$path" ] || fail "$label" "missing path: $path"
}

assert_command_fails() {
  local label="$1"
  shift
  set +e
  "$@" >/tmp/assert-command-fails.stdout 2>/tmp/assert-command-fails.stderr
  local rc=$?
  set -e
  [ "$rc" -ne 0 ] || fail "$label" "command unexpectedly succeeded"
}

wait_for_terminal_report() {
  local report_path="$1" label="$2" status attempt
  for attempt in $(seq 1 60); do
    status="$(python3 - "$report_path" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
if path.is_file():
    print(json.loads(path.read_text()).get("status", ""))
PY
)"
    case "$status" in
      done|failed) return 0 ;;
    esac
    sleep 0.1
  done
  fail "$label" "expected terminal report at $report_path"
}

fixture_dir="$tmpdir/fixture"
mkdir -p "$fixture_dir/bin" "$fixture_dir/codex-home" "$fixture_dir/runtime"
printf '{}\n' > "$fixture_dir/codex-home/auth.json"
printf 'Prompt.\n' > "$fixture_dir/prompt.md"
make_repo "$fixture_dir/repo"
write_codex_stub "$fixture_dir/bin"
write_pnpm_stub "$fixture_dir/bin"
write_legacy_dispatch_script
require_cc
build_low_headroom_stat_stub "$fixture_dir/fake-stat.c" "$fixture_dir/headroom-bin/stat"
write_headroom_helper_wrapper "$fixture_dir/headroom-helper.sh" "$fixture_dir/headroom-bin" "$(command -v stat)" "$ROOT/tools/orchestrator/check-lane-report-headroom.sh"
build_enospc_rename_preload "$fixture_dir/enospc-rename.c" "$fixture_dir/enospc-rename.so"

if [ -n "$CASE_FILTER" ] && [ "$CASE_FILTER" != "$NEW_FAIL_FAST_CASE" ]; then
  fail "unsupported case filter" "supported filter: $NEW_FAIL_FAST_CASE"
fi

blocked_runtime="$fixture_dir/runtime-preflight-blocked"
blocked_report="$blocked_runtime/lane-reports/ag-report-preflight-blocked.json"
blocked_codex_log="$fixture_dir/preflight-blocked-codex.log"
set +e
blocked_output="$(
  cd "$fixture_dir/repo" && \
    env \
      PATH="$fixture_dir/bin:$PATH" \
      CODEX_HOME_SHARED="$fixture_dir/codex-home" \
      ORCH_SKIP_DOCKER_REAP=1 \
      ORCH_LANE_TMP_ROOT="$blocked_runtime/lane-tmp-root" \
      DISPATCH_LANE_DETACH_MODE=never \
      DISPATCH_RUNTIME_DIR="$blocked_runtime" \
      HEADROOM_HELPER="$fixture_dir/headroom-helper.sh" \
      ORCH_TEST_HEADROOM_TARGET="$blocked_runtime/lane-reports" \
      FAKE_CODEX_RUN_LOG="$blocked_codex_log" \
      DISPATCH_SPAWN_CONFIRM_TIMEOUT=6 \
      DISPATCH_SPAWN_CONFIRM_POLL_INTERVAL=1 \
      "$NEW_DISPATCH" --provider codex --name report-preflight-blocked --base dev --prompt "$fixture_dir/prompt.md" --model good-marker 2>&1
)"
blocked_rc=$?
set -e
[ "$blocked_rc" -ne 0 ] || fail "blocked preflight exits non-zero before spawn" "$blocked_output"
assert_contains "$blocked_output" "FATAL: lane=report-preflight-blocked headroom preflight failed before spawn" "blocked preflight fatal output"
assert_file_exists "$blocked_report" "blocked preflight writes failed lane report"
assert_json_value "$blocked_report" "status" "failed" "blocked preflight report status"
assert_json_value "$blocked_report" "blockers" "[\"lane headroom preflight failed before spawn\"]" "blocked preflight report blocker"
assert_file_missing "$blocked_codex_log" "blocked preflight does not launch provider"
assert_file_missing "$fixture_dir/repo/.claude/worktrees/ag-report-preflight-blocked" "blocked preflight leaves no lane worktree behind"
if git -C "$fixture_dir/repo" show-ref --verify --quiet refs/heads/ag-report-preflight-blocked; then
  fail "blocked preflight removes branch before exit" "branch ag-report-preflight-blocked still exists"
fi
pass "GREEN-after: blocked headroom preflight fail-fast exits before any agent spawn"

if [ "$CASE_FILTER" = "$NEW_FAIL_FAST_CASE" ]; then
  echo "dispatch-agent lane-report tests passed"
  exit 0
fi

legacy_report="$fixture_dir/runtime/lane-reports/ag-report-old.json"
run_dispatch "$OLD_DISPATCH" "$fixture_dir/repo" "$fixture_dir/bin" "$fixture_dir/codex-home" "$fixture_dir/runtime" "$fixture_dir/prompt.md" "report-old"
assert_file_missing "$legacy_report" "RED-before legacy dispatch leaves no report"
assert_command_fails "RED-before validator rejects missing legacy report" env DISPATCH_RUNTIME_DIR="$fixture_dir/runtime" "$LANE_REPORT" --validate ag-report-old
pass "RED-before: legacy dispatch leaves no machine-readable lane report"

run_dispatch "$NEW_DISPATCH" "$fixture_dir/repo" "$fixture_dir/bin" "$fixture_dir/codex-home" "$fixture_dir/runtime" "$fixture_dir/prompt.md" "report-new"
new_report="$fixture_dir/runtime/lane-reports/ag-report-new.json"
[ -f "$new_report" ] || fail "spawn writes launched report" "missing $new_report"
assert_json_value "$new_report" "lane" "ag-report-new" "launched report lane"
assert_json_value "$new_report" "provider" "codex" "launched report provider"
assert_json_value "$new_report" "model" "good-marker" "launched report model"
assert_json_value "$new_report" "status" "launched" "launched report status"
assert_json_value "$new_report" "branch" "ag-report-new" "launched report branch"
assert_json_value "$new_report" "head_sha" "$(git -C "$fixture_dir/repo" rev-parse dev)" "launched report head sha"
assert_json_value "$new_report" "merged_sha" "null" "launched report merged sha defaults null"
assert_json_value "$new_report" "blockers" "[]" "launched report blockers default empty"

vitest_env_log="$fixture_dir/vitest-env.log"
FAKE_CODEX_VITEST_ENV_LOG="$vitest_env_log" \
  run_dispatch "$NEW_DISPATCH" "$fixture_dir/repo" "$fixture_dir/bin" "$fixture_dir/codex-home" "$fixture_dir/runtime" "$fixture_dir/prompt.md" "report-vitest-cap"
assert_file_exists "$vitest_env_log" "Vitest-cap env reaches lane provider"
assert_contains "$(cat "$vitest_env_log")" "cap=1 maxForks=2 fileParallelism=false" "Vitest-cap env defaults"
pass "GREEN-after: dispatch provides the bounded Vitest lane environment"

mission_runtime="$fixture_dir/runtime-mission"
mkdir -p "$mission_runtime"
(
  cd "$fixture_dir/repo"
  env \
    PATH="$fixture_dir/bin:$PATH" \
    CODEX_HOME_SHARED="$fixture_dir/codex-home" \
    ORCH_SKIP_DOCKER_REAP=1 \
    ORCH_LANE_TMP_ROOT="$mission_runtime/lane-tmp-root" \
    DISPATCH_LANE_DETACH_MODE=never \
    DISPATCH_RUNTIME_DIR="$mission_runtime" \
    DISPATCH_SPAWN_CONFIRM_TIMEOUT=6 \
    DISPATCH_SPAWN_CONFIRM_POLL_INTERVAL=1 \
    "$NEW_DISPATCH" --provider codex --name report-mission --base dev --prompt "$fixture_dir/prompt.md" --model good-marker --mission-id fq29-20260711-b167land
)
mission_report="$mission_runtime/lane-reports/ag-fq29-20260711-b167land-report-mission.json"
[ -f "$mission_report" ] || fail "spawn writes mission-owned launched report" "missing $mission_report"
assert_json_value "$mission_report" "mission_id" "fq29-20260711-b167land" "launched report mission id"
assert_json_value "$mission_report" "lane" "ag-fq29-20260711-b167land-report-mission" "launched report token is mission-scoped"
pass "GREEN-after: dispatch scopes lane report tokens to the mission"

stale_runtime="$fixture_dir/runtime-stale-terminal"
stale_mission_id="fq29-20260711-stale"
stale_report="$stale_runtime/lane-reports/ag-$stale_mission_id-report-stale.json"
mkdir -p "$(dirname "$stale_report")"
printf '%s\n' '{"lane":"ag-fq29-20260711-stale-report-stale","status":"done","mission_id":"old-mission","merged_sha":"stale-merged"}' > "$stale_report"
stale_output="$(
  cd "$fixture_dir/repo"
  env \
    PATH="$fixture_dir/bin:$PATH" \
    CODEX_HOME_SHARED="$fixture_dir/codex-home" \
    ORCH_SKIP_DOCKER_REAP=1 \
    ORCH_LANE_TMP_ROOT="$stale_runtime/lane-tmp-root" \
    DISPATCH_LANE_DETACH_MODE=never \
    DISPATCH_RUNTIME_DIR="$stale_runtime" \
    DISPATCH_SPAWN_CONFIRM_TIMEOUT=6 \
    DISPATCH_SPAWN_CONFIRM_POLL_INTERVAL=1 \
    "$NEW_DISPATCH" --provider codex --name "$stale_mission_id-report-stale" --base dev --prompt "$fixture_dir/prompt.md" --model good-marker --mission-id "$stale_mission_id" 2>&1
)"
assert_contains "$stale_output" "archived pre-existing terminal lane report" "stale terminal report is isolated before launch"
assert_json_value "$stale_report" "mission_id" "$stale_mission_id" "fresh launch report is not adopted from stale mission"
assert_json_value "$stale_report" "merged_sha" "null" "fresh launch report drops stale terminal merge evidence"
stale_archive="$(find "$stale_runtime/lane-reports/archived" -type f -name 'ag-fq29-20260711-stale-report-stale.*.json' -print -quit)"
[ -n "$stale_archive" ] || fail "stale terminal report is archived" "missing archived stale report"
assert_json_value "$stale_archive" "mission_id" "old-mission" "archive preserves stale report provenance"
assert_json_value "$stale_archive" "merged_sha" "stale-merged" "archive preserves stale terminal evidence"
pass "GREEN-after: launch archives a stale terminal report instead of adopting it"

retry_runtime="$fixture_dir/runtime-missing-proof-retry"
retry_mission="m305-orch-tooling"
retry_proof="$retry_runtime/lane-reports/proofs/$retry_mission/terminal-lock.txt"
mkdir -p "$(dirname "$retry_proof")"
printf 'fail-before/pass-after\n' > "$retry_proof"
(
  cd "$fixture_dir/repo"
  env \
    PATH="$fixture_dir/bin:$PATH" \
    CODEX_HOME_SHARED="$fixture_dir/codex-home" \
    ORCH_SKIP_DOCKER_REAP=1 \
    ORCH_LANE_TMP_ROOT="$retry_runtime/lane-tmp-root" \
    DISPATCH_LANE_DETACH_MODE=never \
    DISPATCH_RUNTIME_DIR="$retry_runtime" \
    LANE_REPORT_HELPER="$LANE_REPORT" \
    FAKE_CODEX_COMMIT=1 \
    DISPATCH_SPAWN_CONFIRM_TIMEOUT=6 \
    DISPATCH_SPAWN_CONFIRM_POLL_INTERVAL=1 \
    "$NEW_DISPATCH" --provider codex --name report-missing-proof-retry --base dev --prompt "$fixture_dir/prompt.md" --model good-marker --mission-id "$retry_mission"
)
retry_report="$retry_runtime/lane-reports/ag-$retry_mission-report-missing-proof-retry.json"
wait_for_terminal_report "$retry_report" "missing lock-proof refusal is retried to terminal report"
assert_json_value "$retry_report" "status" "done" "missing proof retry preserves clean terminal intent"
assert_json_value "$retry_report" "lock_proof_paths" "[\"$retry_proof\"]" "missing proof retry attaches guard-discovered proof"
pass "GREEN-after: dispatcher retries missing lock-proof refusal with mission proofs"

env DISPATCH_RUNTIME_DIR="$fixture_dir/runtime" "$LANE_REPORT" --lane ag-report-new --status done --merged-sha merged123 --clear-blockers
env DISPATCH_RUNTIME_DIR="$fixture_dir/runtime" "$LANE_REPORT" --validate ag-report-new
assert_json_value "$new_report" "status" "done" "updater merged done status"
assert_json_value "$new_report" "merged_sha" "merged123" "updater merged merged sha"
pass "GREEN-after: updater merges done status and validator accepts proof-carrying report"

preflight_runtime="$fixture_dir/runtime-preflight"
preflight_report="$preflight_runtime/lane-reports/ag-report-preflight.json"
preflight_codex_log="$fixture_dir/preflight-codex.log"
set +e
preflight_output="$(
  cd "$fixture_dir/repo" && \
    env \
      PATH="$fixture_dir/bin:$PATH" \
      CODEX_HOME_SHARED="$fixture_dir/codex-home" \
      ORCH_SKIP_DOCKER_REAP=1 \
      ORCH_LANE_TMP_ROOT="$preflight_runtime/lane-tmp-root" \
      DISPATCH_LANE_DETACH_MODE=never \
      DISPATCH_RUNTIME_DIR="$preflight_runtime" \
      HEADROOM_HELPER="$fixture_dir/headroom-helper.sh" \
      ORCH_TEST_HEADROOM_TARGET="$preflight_runtime/lane-reports" \
      FAKE_CODEX_RUN_LOG="$preflight_codex_log" \
      DISPATCH_SPAWN_CONFIRM_TIMEOUT=6 \
      DISPATCH_SPAWN_CONFIRM_POLL_INTERVAL=1 \
      "$NEW_DISPATCH" --provider codex --name report-preflight --base dev --prompt "$fixture_dir/prompt.md" --model good-marker 2>&1
)"
preflight_rc=$?
set -e
[ "$preflight_rc" -ne 0 ] || fail "preflight failure exits non-zero" "$preflight_output"
assert_contains "$preflight_output" "FATAL: lane=report-preflight headroom preflight failed before spawn" "preflight failure output"
assert_file_exists "$preflight_report" "preflight failure writes failed lane report"
assert_json_value "$preflight_report" "status" "failed" "preflight report status"
assert_json_value "$preflight_report" "blockers" "[\"lane headroom preflight failed before spawn\"]" "preflight report blocker"
assert_file_missing "$preflight_codex_log" "preflight failure does not launch provider"
assert_file_missing "$fixture_dir/repo/.claude/worktrees/ag-report-preflight" "preflight failure removes worktree before exit"
if git -C "$fixture_dir/repo" show-ref --verify --quiet refs/heads/ag-report-preflight; then
  fail "preflight failure removes branch before exit" "branch ag-report-preflight still exists"
fi
pass "GREEN-after: headroom preflight fails closed before spawn and removes the lane checkout"

real_oserror_runtime="$fixture_dir/runtime-real-oserror"
real_oserror_reports="$real_oserror_runtime/lane-reports"
real_oserror_report="$real_oserror_reports/ag-report-write-fail.json"
real_oserror_fallback="$real_oserror_reports/ag-report-write-fail.fallback.json"
real_oserror_hits="$fixture_dir/report-write-fail-hits.txt"
real_oserror_stderr="$fixture_dir/report-write-fail.stderr"
real_oserror_lane_tmp_root="$fixture_dir/lane-tmp-real-oserror"
printf '0\n' > "$real_oserror_hits"
set +e
env \
  DISPATCH_RUNTIME_DIR="$real_oserror_runtime" \
  LANE_REPORT_DIR="$real_oserror_reports" \
  ORCH_LANE_TMP_ROOT="$real_oserror_lane_tmp_root" \
  LD_PRELOAD="$fixture_dir/enospc-rename.so" \
  ORCH_TEST_ENOSPC_TARGET="$real_oserror_report" \
  ORCH_TEST_ENOSPC_MAX_HITS=2 \
  ORCH_TEST_ENOSPC_HITS_FILE="$real_oserror_hits" \
  "$LANE_REPORT" \
  --lane ag-report-write-fail \
  --provider codex \
  --model good-marker \
  --status failed \
  --branch ag-report-write-fail \
  --head-sha deadbeef \
  --started-at 2026-07-11T00:00:00Z \
  --updated-at 2026-07-11T00:00:00Z \
  --clear-blockers \
  --blocker "forced real os error" \
  > /dev/null 2>"$real_oserror_stderr"
real_oserror_rc=$?
set -e
[ "$real_oserror_rc" -eq 1 ] || fail "report-write-fail exits with fallback rc" "expected rc=1"$'\n'"actual: $real_oserror_rc"
assert_file_missing "$real_oserror_report" "report-write-fail leaves primary report absent after real os error"
assert_file_exists "$real_oserror_fallback" "report-write-fail writes fallback report after real os error"
assert_json_value "$real_oserror_fallback" "lane" "ag-report-write-fail" "fallback report lane"
assert_json_value "$real_oserror_fallback" "status" "failed" "fallback report status"
if [ "$(cat "$real_oserror_hits" | tr -d '[:space:]')" != "2" ]; then
  fail "real os error retry count" "expected two intercepted primary rename failures"
fi
if [ "$(grep -Fc "lane-report write failed path=$real_oserror_report errno=28" "$real_oserror_stderr")" -lt 2 ]; then
  fail "real os error diagnostics" "expected two ENOSPC diagnostics for the primary path"
fi
if ! grep -Fq "lane-report primary write failed; wrote fallback report to $real_oserror_fallback" "$real_oserror_stderr"; then
  fail "real os error fallback message" "expected fallback report diagnostic"
fi
pass "GREEN-after: real ENOSPC retries twice and writes a fallback report"

override_runtime="$fixture_dir/runtime-override"
override_reports="$fixture_dir/runtime-override-custom/lane-reports"
run_dispatch_with_report_dir "$NEW_DISPATCH" "$fixture_dir/repo" "$fixture_dir/bin" "$fixture_dir/codex-home" "$override_runtime" "$fixture_dir/prompt.md" "report-override" "$override_reports" "$fixture_dir/lane-tmp-override"
override_report="$override_reports/ag-report-override.json"
assert_file_exists "$override_report" "lane-report-dir override writes launched report"
assert_json_value "$override_report" "lane" "ag-report-override" "lane-report-dir override report lane"
pass "GREEN-after: dispatch preflight honors LANE_REPORT_DIR override"

env DISPATCH_RUNTIME_DIR="$fixture_dir/runtime" "$LANE_REPORT" --lane ag-report-proofless --provider codex --model good-marker --status done --branch ag-report-proofless --head-sha deadbeef --started-at 2026-07-09T00:00:00Z --updated-at 2026-07-09T00:00:00Z --clear-blockers
assert_command_fails "validator rejects done report without proof" env DISPATCH_RUNTIME_DIR="$fixture_dir/runtime" "$LANE_REPORT" --validate ag-report-proofless
pass "GREEN-after: validator rejects done-without-proof reports"

lock_proof_path="$fixture_dir/runtime/lock-proof.txt"
printf 'fail-before/pass-after\n' > "$lock_proof_path"
env DISPATCH_RUNTIME_DIR="$fixture_dir/runtime" "$LANE_REPORT" --lane ag-report-lock-proof --provider codex --model good-marker --status done --branch ag-report-lock-proof --head-sha deadbeef --started-at 2026-07-09T00:00:00Z --updated-at 2026-07-09T00:00:00Z --clear-blockers --lock-proof "$lock_proof_path"
env DISPATCH_RUNTIME_DIR="$fixture_dir/runtime" "$LANE_REPORT" --validate ag-report-lock-proof
pass "GREEN-after: validator accepts done report proved only by lock_proof_paths"

env DISPATCH_RUNTIME_DIR="$fixture_dir/runtime" "$LANE_REPORT" --lane ag-report-lock-proof-missing --provider codex --model good-marker --status done --branch ag-report-lock-proof-missing --head-sha deadbeef --started-at 2026-07-09T00:00:00Z --updated-at 2026-07-09T00:00:00Z --clear-blockers --lock-proof "$fixture_dir/runtime/missing-lock-proof.txt"
assert_command_fails "validator rejects missing lock_proof_paths file" env DISPATCH_RUNTIME_DIR="$fixture_dir/runtime" "$LANE_REPORT" --validate ag-report-lock-proof-missing
pass "GREEN-after: validator rejects missing lock_proof_paths file"

secret_verdict="$fixture_dir/runtime/review-verdict.txt"
printf 'postgres://user:S3cr3t@db.internal/app\npassword=UltraSecret123\n' > "$secret_verdict"
env DISPATCH_RUNTIME_DIR="$fixture_dir/runtime" "$LANE_REPORT" --lane ag-report-secret-proof --provider codex --model good-marker --status done --branch ag-report-secret-proof --head-sha deadbeef --started-at 2026-07-09T00:00:00Z --updated-at 2026-07-09T00:00:00Z --clear-blockers --lock-proof "$secret_verdict"
assert_command_fails "validator rejects secret-bearing verdict proof" env DISPATCH_RUNTIME_DIR="$fixture_dir/runtime" "$LANE_REPORT" --validate ag-report-secret-proof
if ! grep -Fq "review-verdict.txt" /tmp/assert-command-fails.stderr; then
  fail "secret proof failure names file" "expected file name in validator stderr"
fi
if ! grep -Fq "redaction required before review acceptance" /tmp/assert-command-fails.stderr; then
  fail "secret proof failure requests redaction" "expected redaction demand in validator stderr"
fi
if grep -Fq "S3cr3t" /tmp/assert-command-fails.stderr || grep -Fq "UltraSecret123" /tmp/assert-command-fails.stderr; then
  fail "secret proof failure redacts values" "validator stderr echoed a secret value"
fi
pass "GREEN-after: validator rejects secret-bearing verdict proof without echoing the value"

clean_verdict="$fixture_dir/runtime/review-verdict-clean.txt"
printf 'postgres://user:<redacted>@example.com/app\npassword=<redacted>\n' > "$clean_verdict"
env DISPATCH_RUNTIME_DIR="$fixture_dir/runtime" "$LANE_REPORT" --lane ag-report-clean-proof --provider codex --model good-marker --status done --branch ag-report-clean-proof --head-sha deadbeef --started-at 2026-07-09T00:00:00Z --updated-at 2026-07-09T00:00:00Z --clear-blockers --lock-proof "$clean_verdict"
env DISPATCH_RUNTIME_DIR="$fixture_dir/runtime" "$LANE_REPORT" --validate ag-report-clean-proof
pass "GREEN-after: validator ignores redacted placeholder review verdicts"

echo "dispatch-agent lane report tests passed"
