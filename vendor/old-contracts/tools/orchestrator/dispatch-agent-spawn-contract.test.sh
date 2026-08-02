#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NEW_SCRIPT="${DISPATCH_AGENT_SCRIPT:-$ROOT/tools/orchestrator/dispatch-agent.sh}"
TEST_CASE="${DISPATCH_SPAWN_TEST_CASE:-all}"

# Dispatch fixtures must be disk-backed: the contract intentionally rejects
# dependency hydration into tmpfs worktrees. The hydration case below creates
# its own /tmp fixture to lock that negative path.
tmpdir="$(mktemp -d "$HOME/.cache/dispatch-agent-spawn-contract.XXXXXX")"
OLD_SCRIPT="$tmpdir/dispatch-agent-legacy.sh"
tracked_processes="$tmpdir/tracked-processes"
durable_tmpdir=""
tmpfs_hydration_tmpdir=""

process_start_token() {
  local stat_line stat_tail starttime
  IFS= read -r stat_line < "/proc/$1/stat" 2>/dev/null || return 1
  stat_tail="${stat_line##*) }"
  [ "$stat_tail" != "$stat_line" ] || return 1
  starttime="$(awk '{ print $20 }' <<<"$stat_tail")"
  [[ "$starttime" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "$starttime"
}

cleanup() {
  local owner pid expected actual attempt live
  [ -z "$durable_tmpdir" ] || rm -rf "$durable_tmpdir"
  [ -z "$tmpfs_hydration_tmpdir" ] || rm -rf "$tmpfs_hydration_tmpdir"
  if [ -d "$tmpdir" ]; then
    if [ -f "$tracked_processes" ]; then
      while read -r pid expected; do
        actual="$(process_start_token "$pid" 2>/dev/null || true)"
        if [ -n "$actual" ] && [ "$actual" = "$expected" ]; then
          kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
        fi
      done < "$tracked_processes"
    fi
    while IFS= read -r owner; do
      pid="$(awk -F= '$1 == "pid" { print $2; exit }' "$owner" 2>/dev/null || true)"
      expected="$(awk -F= '$1 == "pid_start" { print $2; exit }' "$owner" 2>/dev/null || true)"
      actual="$(process_start_token "$pid" 2>/dev/null || true)"
      if [ -n "$actual" ] && [ "$actual" = "$expected" ]; then
        kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
      fi
    done < <(find "$tmpdir" -path '*/lane-owners/*.env' -type f 2>/dev/null)
    for attempt in $(seq 1 100); do
      live=0
      while IFS= read -r owner; do
        pid="$(awk -F= '$1 == "pid" { print $2; exit }' "$owner" 2>/dev/null || true)"
        process_start_token "$pid" >/dev/null 2>&1 && live=1
      done < <(find "$tmpdir" -path '*/lane-owners/*.env' -type f 2>/dev/null)
      [ "$live" -eq 0 ] && break
      sleep 0.05
    done
  fi
  rm -rf "$tmpdir"
}
trap cleanup EXIT

pass() { printf 'PASS %s\n' "$1"; }
fail() {
  printf 'FAIL %s\n%s\n' "$1" "${2:-}" >&2
  exit 1
}

assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  if ! grep -Fq "$needle" <<<"$haystack"; then
    fail "$label" "expected to find: $needle"$'\n'"output:"$'\n'"$haystack"
  fi
}

assert_not_contains() {
  local haystack="$1" needle="$2" label="$3"
  if grep -Fq "$needle" <<<"$haystack"; then
    fail "$label" "did not expect to find: $needle"$'\n'"output:"$'\n'"$haystack"
  fi
}

assert_file_contains() {
  local path="$1" needle="$2" label="$3"
  [ -f "$path" ] || fail "$label" "missing file: $path"
  grep -Fq "$needle" "$path" || fail "$label" "expected $path to contain: $needle"
}

wait_for_log_line() {
  local log_path="$1" pattern="$2" label="$3"
  local attempt
  for attempt in $(seq 1 20); do
    if [ -f "$log_path" ] && grep -Fq "$pattern" "$log_path"; then
      return 0
    fi
    sleep 1
  done
  fail "$label" "log $log_path never contained: $pattern"
}

git_cfg() {
  git -C "$1" config user.email "dispatch-spawn-test@example.test"
  git -C "$1" config user.name "Dispatch Spawn Test"
}

make_repo() {
  local repo="$1"
  git init -q "$repo"
  git_cfg "$repo"
  git -C "$repo" checkout -q -b dev
  printf 'init\n' > "$repo/README.md"
  printf 'node_modules\n.claude/\n' > "$repo/.gitignore"
  mkdir -p "$repo/node_modules/vitest"
  # Repo-shape-faithful fixture: the probe must discover a real packages/* dir
  # that declares vitest (agent repos do NOT carry packages/master-orchestrator,
  # so it must not be hardcoded). Give the fixture a vitest-declaring package
  # with a committed package.json plus a hydrated node_modules.
  mkdir -p "$repo/packages/example-pkg/node_modules/vitest"
  cat > "$repo/packages/example-pkg/package.json" <<'PKGJSON'
{
  "name": "@fixture/example-pkg",
  "version": "0.0.0",
  "devDependencies": { "vitest": "^2.1.8" }
}
PKGJSON
  git -C "$repo" add README.md .gitignore packages/example-pkg/package.json
  git -C "$repo" commit -q -m "init"
}

write_common_stubs() {
  local bin_dir="$1" notify_log="$2"

  cat > "$bin_dir/pnpm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[ "${1:-}" = "exec" ] && [ "${2:-}" = "vitest" ] || exit 64
case "${3:-}" in
  --version)
    # Mirror real pnpm: `pnpm exec` in a directory without a package.json
    # throws ERR_PNPM_RECURSIVE_EXEC_NO_PACKAGE. This rejects a hydration probe
    # that lands in a phantom (node_modules-only) dir or at a multi-package
    # workspace root — exactly the false-green the reverted M63 fix produced.
    if [ ! -f "package.json" ]; then
      printf ' ERR_PNPM_RECURSIVE_EXEC_NO_PACKAGE  No package found in this workspace\n' >&2
      exit 1
    fi
    printf 'vitest 2.1.9\n'
    ;;
  run)
    printf 'PASS %s\n' "${4:-}"
    ;;
  *)
    exit 64
    ;;
esac
EOF
  chmod +x "$bin_dir/pnpm"

  cat > "$bin_dir/systemctl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cmd="${1:-}"
[ "$cmd" != "--user" ] || {
  shift
  cmd="${1:-}"
}
case "$cmd" in
  reset-failed|kill|stop) exit 0 ;;
  is-active) exit 3 ;;
  *) exit 1 ;;
esac
EOF
  chmod +x "$bin_dir/systemctl"

  cat > "$bin_dir/curl" <<EOF
#!/usr/bin/env bash
set -euo pipefail
data=""
url=""
while [ "\$#" -gt 0 ]; do
  case "\$1" in
    --data-binary)
      data="\$2"
      shift 2
      ;;
    http://*|https://*)
      url="\$1"
      shift
      ;;
    *)
      shift
      ;;
  esac
done
printf '%s|%s\n' "\$url" "\$data" >> "$notify_log"
exit 0
EOF
  chmod +x "$bin_dir/curl"

  cat > "$bin_dir/claude" <<'EOF'
#!/usr/bin/env bash
sleep 1
printf 'I have all the information needed.\n'
exit 0
EOF
  chmod +x "$bin_dir/claude"
}

write_codex_stub() {
  local bin_dir="$1"
  cat > "$bin_dir/codex" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
model=""
prompt_arg=""
worktree=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --model)
      model="$2"
      shift 2
      ;;
    -C)
      worktree="$2"
      shift 2
      ;;
    --ephemeral|--dangerously-bypass-approvals-and-sandbox)
      shift
      ;;
    -*)
      shift
      ;;
    *)
      prompt_arg="$1"
      shift
      ;;
  esac
done

case "$model" in
  bad-fast-400)
    sleep 1
    printf 'Error: model not found (HTTP 400)\n'
    exit 0
    ;;
  bad-marker-hold)
    printf 'Error: model not found (HTTP 400)\n'
    : > "${FAKE_CODEX_TERMINAL_HOLD:?}.ready"
    while [ ! -f "${FAKE_CODEX_TERMINAL_HOLD}.release" ]; do sleep 0.05; done
    exit 0
    ;;
  hang-no-marker)
    trap 'exit 0' TERM INT
    while :; do sleep 1; done
    ;;
  no-marker-hold)
    : > "${FAKE_CODEX_TERMINAL_HOLD:?}.ready"
    while [ ! -f "${FAKE_CODEX_TERMINAL_HOLD}.release" ]; do sleep 0.05; done
    exit 0
    ;;
  exit-no-marker)
    sleep 1
    exit 17
    ;;
  dirty-no-marker)
    printf 'dirty evidence\n' > dirty-evidence.txt
    exit 17
    ;;
  good-marker)
    sleep 2
    printf 'OpenAI Codex v0.142.4\n'
    printf 'provider: openai\n'
    printf 'session id: test-session\n'
    if [ -n "${FAKE_CODEX_SUCCESS_HOLD:-}" ]; then
      : > "${FAKE_CODEX_SUCCESS_HOLD}.ready"
      while [ ! -f "${FAKE_CODEX_SUCCESS_HOLD}.release" ]; do sleep 0.05; done
    fi
    sleep 1
    exit 0
    ;;
  terminal-zero|terminal-nonzero)
    printf 'OpenAI Codex v0.142.4\n'
    printf 'provider: openai\n'
    printf 'session id: terminal-session\n'
    if [ -n "${FAKE_CODEX_TERMINAL_HOLD:-}" ]; then
      : > "${FAKE_CODEX_TERMINAL_HOLD}.ready"
      while [ ! -f "${FAKE_CODEX_TERMINAL_HOLD}.release" ]; do sleep 0.05; done
    fi
    [ "$model" = "terminal-zero" ] && exit 0
    exit 17
    ;;
  hydration-pass)
    pnpm exec vitest run hydration-lock.spec
    printf 'OpenAI Codex v0.142.4\n'
    printf 'provider: openai\n'
    printf 'session id: hydration-session\n'
    exit 0
    ;;
  no-deps-pass)
    printf 'provider work\n' > "$worktree/no-deps-provider.txt"
    git -C "$worktree" add no-deps-provider.txt
    git -C "$worktree" commit -qm 'provider work'
    printf 'OpenAI Codex v0.142.4\n'
    printf 'provider: openai\n'
    printf 'session id: no-deps-session\n'
    exit 0
    ;;
  authoritative-done-nonzero|authoritative-failed-zero)
    printf 'OpenAI Codex v0.142.4\n'
    printf 'provider: openai\n'
    printf 'session id: authoritative-terminal-session\n'
    status="${model#authoritative-}"
    status="${status%-nonzero}"
    status="${status%-zero}"
    blocker_args=()
    [ "$status" != "failed" ] || blocker_args=(--blocker "authoritative provider failure")
    "${FAKE_LANE_REPORT_HELPER:?}" \
      --lane "${BR:?}" \
      --status "$status" \
      --branch "$BR" \
      --head-sha "$(git rev-parse HEAD)" \
      --clear-blockers \
      "${blocker_args[@]}"
    report="${FAKE_LANE_REPORT_DIR:?}/$BR.json"
    cp "$report" "${FAKE_AUTHORITATIVE_SNAPSHOT:?}"
    stat -c '%d:%i:%h' "$report" > "${FAKE_AUTHORITATIVE_IDENTITY:?}"
    [ "$model" = "authoritative-failed-zero" ] && exit 0
    exit 17
    ;;
  poison-prompt)
    # Healthy handshake, THEN echo the prompt the way real codex does. The
    # prompt body contains words ("FORBIDDEN", "authentication failed") that the
    # spawn-failure regexes match; a correct scanner must ignore them because
    # they live in the echoed prompt, not the CLI handshake.
    sleep 2
    printf 'OpenAI Codex v0.142.4\n'
    printf 'provider: openai\n'
    printf 'session id: test-session\n'
    printf -- '--------\n'
    printf 'user\n'
    printf '%s\n' "$prompt_arg"
    sleep 2
    exit 0
    ;;
  *)
    printf 'unexpected model: %s\n' "$model" >&2
    exit 2
    ;;
esac
EOF
  chmod +x "$bin_dir/codex"
}

write_legacy_dispatch_script() {
  cat > "$OLD_SCRIPT" <<'EOF'
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
LOG="${DISPATCH_EPHEMERAL_ROOT:?}/ag-$NAME.log"

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

export BASE BR CMD LOG NAME REPO WT
export -f legacy_run_agent
setsid bash -lc 'legacy_run_agent' >/dev/null 2>&1 &
exit 0
EOF
  chmod +x "$OLD_SCRIPT"
}

run_dispatch() {
  local script="$1" repo="$2" bin_dir="$3" codex_home="$4" runtime_dir="$5" prompt="$6" name="$7" provider="$8" model="$9"
  shift 9
  (
    cd "$repo"
    env \
      PATH="$bin_dir:$PATH" \
      CODEX_HOME_SHARED="$codex_home" \
      ORCH_SKIP_DOCKER_REAP=1 \
      TELEGRAM_DAEMON_PORT=4822 \
      DISPATCH_RUNTIME_DIR="$runtime_dir" \
      DISPATCH_EPHEMERAL_ROOT="$runtime_dir/ephemeral" \
      ORCH_LANE_TMP_ROOT="$runtime_dir/lane-tmp" \
      DISPATCH_SPAWN_FAILURES_LOG="$runtime_dir/dispatch-spawn-failures.log" \
      DISPATCH_LANE_DETACH_MODE=never \
      DISPATCH_SPAWN_CONFIRM_TIMEOUT="${DISPATCH_SPAWN_CONFIRM_TIMEOUT:-6}" \
      DISPATCH_SPAWN_CONFIRM_POLL_INTERVAL=1 \
      DISPATCH_CLAUDE_SPAWN_GRACE=1 \
      DISPATCH_TEST_FORCE_DETACH_FAILURE="${DISPATCH_TEST_FORCE_DETACH_FAILURE:-0}" \
      DISPATCH_TEST_FORCE_OWNERSHIP_PUBLICATION_FAILURE="${DISPATCH_TEST_FORCE_OWNERSHIP_PUBLICATION_FAILURE:-0}" \
      DISPATCH_TEST_HOLD_BEFORE_CONTEXT_LOAD="${DISPATCH_TEST_HOLD_BEFORE_CONTEXT_LOAD:-}" \
      DISPATCH_TEST_RUNNER_STARTTIME_OVERRIDE="${DISPATCH_TEST_RUNNER_STARTTIME_OVERRIDE:-}" \
      DISPATCH_TEST_SIGNAL_LOG="${DISPATCH_TEST_SIGNAL_LOG:-}" \
      FAKE_OWNER_PUBLICATION_HOLD="${FAKE_OWNER_PUBLICATION_HOLD:-}" \
      FAKE_CODEX_SUCCESS_HOLD="${FAKE_CODEX_SUCCESS_HOLD:-}" \
      FAKE_CODEX_TERMINAL_HOLD="${FAKE_CODEX_TERMINAL_HOLD:-}" \
      FAKE_LANE_REPORT_HELPER="${FAKE_LANE_REPORT_HELPER:-}" \
      FAKE_LANE_REPORT_DIR="${FAKE_LANE_REPORT_DIR:-}" \
      FAKE_AUTHORITATIVE_SNAPSHOT="${FAKE_AUTHORITATIVE_SNAPSHOT:-}" \
      FAKE_AUTHORITATIVE_IDENTITY="${FAKE_AUTHORITATIVE_IDENTITY:-}" \
      LANE_REPORT_HELPER="${LANE_REPORT_HELPER:-}" \
      "$script" --provider "$provider" --name "$name" --base dev --prompt "$prompt" --model "$model" "$@"
  )
}

assert_failed_report() {
  local report="$1" label="$2"
  [ -f "$report" ] || fail "$label" "missing report: $report"
  python3 - "$report" <<'PY' || fail "$label" "report is not terminal failed: $report"
import json
import sys
from pathlib import Path

report = json.loads(Path(sys.argv[1]).read_text())
raise SystemExit(0 if report.get("status") == "failed" else 1)
PY
}

wait_for_report_status() {
  local report="$1" expected="$2" label="$3" attempt actual
  for attempt in $(seq 1 600); do
    actual="$(python3 - "$report" <<'PY' 2>/dev/null || true
import json
import sys
from pathlib import Path
print(json.loads(Path(sys.argv[1]).read_text()).get("status", ""))
PY
)"
    [ "$actual" = "$expected" ] && return 0
    sleep 0.05
  done
  fail "$label" "report=$report expected=$expected actual=$actual"
}

wait_for_exact_process_exit() {
  local pid="$1" expected="$2" label="$3" attempt actual
  for attempt in $(seq 1 600); do
    actual="$(process_start_token "$pid" 2>/dev/null || true)"
    [ -z "$actual" ] && return 0
    [ "$actual" != "$expected" ] && return 0
    sleep 0.05
  done
  fail "$label" "pid=$pid start=$expected remained live"
}

assert_reentry_state() {
  local fixture="$1" name="$2" hold="$3" branch="ag-$2" owner pid expected actual attempt
  [ ! -e "$fixture/runtime/lane-tmp/$branch/runner-context.env" ] || fail "re-entry consumes stale context" "$branch"
  owner="$fixture/runtime/lane-owners/$branch.env"
  [ -f "$owner" ] || fail "re-entry publishes current owner" "$owner"
  pid="$(awk -F= '$1 == "pid" { print $2 }' "$owner")"
  expected="$(awk -F= '$1 == "pid_start" { print $2 }' "$owner")"
  actual="$(awk '{ line=$0; sub(/^.*\) /, "", line); split(line, fields, " "); print fields[20] }' "/proc/$pid/stat" 2>/dev/null || true)"
  [ -n "$actual" ] && [ "$actual" = "$expected" ] || fail "re-entry owner is current, not stale" "pid=$pid expected=$expected actual=$actual"
  [ ! -e "$fixture/runtime/units" ] || fail "setsid re-entry leaves no unit state" "$fixture/runtime/units"
  : > "$hold.release"
  for attempt in $(seq 1 400); do
    [ ! -e "$owner" ] && ! kill -0 "$pid" 2>/dev/null && return 0
    sleep 0.05
  done
  fail "completed re-entry leaves no stale owner or process" "owner=$owner pid=$pid"
}

run_failure_reentry_case() {
  local label="$1" model="$2" force_detach="$3" timeout="$4"
  local fixture="$tmpdir/reentry-$label" name="reentry-$label" branch="ag-reentry-$label"
  local report hold="$fixture/success-hold" output rc
  mkdir -p "$fixture/bin" "$fixture/runtime/ephemeral" "$fixture/codex-home"
  printf '{}\n' > "$fixture/codex-home/auth.json"
  printf 'Prompt.\n' > "$fixture/prompt.md"
  make_repo "$fixture/repo"
  write_common_stubs "$fixture/bin" "$fixture/notifies.log"
  write_codex_stub "$fixture/bin"
  report="$fixture/runtime/lane-reports/$branch.json"

  set +e
  output="$(DISPATCH_TEST_FORCE_DETACH_FAILURE="$force_detach" DISPATCH_SPAWN_CONFIRM_TIMEOUT="$timeout" run_dispatch "$NEW_SCRIPT" "$fixture/repo" "$fixture/bin" "$fixture/codex-home" "$fixture/runtime" "$fixture/prompt.md" "$name" codex "$model" 2>&1)"
  rc=$?
  set -e
  [ "$rc" -ne 0 ] || fail "$label failure exits non-zero" "$output"
  assert_failed_report "$report" "$label failure terminalizes its report"
  [ ! -d "$fixture/repo/.claude/worktrees/$branch" ] || fail "$label failure removes its worktree" "$branch"
  git -C "$fixture/repo" show-ref --verify --quiet "refs/heads/$branch" && fail "$label failure removes its branch" "$branch"
  [ ! -e "$fixture/runtime/lane-owners/$branch.env" ] || fail "$label failure clears owner" "$branch"
  [ ! -e "$fixture/runtime/lane-tmp/$branch/runner-context.env" ] || fail "$label failure clears context" "$branch"

  FAKE_CODEX_SUCCESS_HOLD="$hold" run_dispatch "$NEW_SCRIPT" "$fixture/repo" "$fixture/bin" "$fixture/codex-home" "$fixture/runtime" "$fixture/prompt.md" "$name" codex good-marker >"$fixture/reentry.stdout" 2>&1 || fail "$label same-name dispatch re-enters" "$(cat "$fixture/reentry.stdout")"
  wait_for_log_line "$fixture/runtime/ephemeral/ag-$name.log" "session id: test-session" "$label second launch marker"
  assert_reentry_state "$fixture" "$name" "$hold"
  pass "$label failure is terminal, reconciled, and same-name re-entry succeeds"
}

run_spawn_failure_alert_routing_case() {
  local fixture_root="$tmpdir/spawn-failure-alert-routing" fixture_repo fixture_output fixture_rc
  local real_root="$tmpdir/real-spawn-failure-alert-routing" real_output real_rc

  fixture_repo="$fixture_root/runtime/lane-tmp/ag-parent/tmp.1/ephemeral/repo"
  mkdir -p "$fixture_repo/../bin" "$fixture_repo/../codex-home" "$fixture_root/runtime/ephemeral"
  printf '{}\n' > "$fixture_repo/../codex-home/auth.json"
  printf 'Prompt.\n' > "$fixture_repo/../prompt.md"
  make_repo "$fixture_repo"
  write_common_stubs "$fixture_repo/../bin" "$fixture_root/notifies.log"
  write_codex_stub "$fixture_repo/../bin"

  set +e
  fixture_output="$(run_dispatch "$NEW_SCRIPT" "$fixture_repo" "$fixture_repo/../bin" "$fixture_repo/../codex-home" "$fixture_root/runtime" "$fixture_repo/../prompt.md" "preflight-losers" codex bad-fast-400 2>&1)"
  fixture_rc=$?
  set -e
  [ "$fixture_rc" -ne 0 ] || fail "fixture spawn failure exits non-zero" "$fixture_output"
  [ ! -s "$fixture_root/notifies.log" ] || fail "fixture spawn failure sends no Telegram alert" "$(cat "$fixture_root/notifies.log")"
  assert_file_contains "$fixture_root/runtime/dispatch-spawn-failures.log" "lane=preflight-losers" "fixture spawn failure remains in local ledger"

  mkdir -p "$real_root/bin" "$real_root/runtime/ephemeral" "$real_root/codex-home"
  printf '{}\n' > "$real_root/codex-home/auth.json"
  printf 'Prompt.\n' > "$real_root/prompt.md"
  make_repo "$real_root/repo"
  write_common_stubs "$real_root/bin" "$real_root/notifies.log"
  write_codex_stub "$real_root/bin"

  set +e
  real_output="$(run_dispatch "$NEW_SCRIPT" "$real_root/repo" "$real_root/bin" "$real_root/codex-home" "$real_root/runtime" "$real_root/prompt.md" "real-spawn-failure" codex bad-fast-400 2>&1)"
  real_rc=$?
  set -e
  [ "$real_rc" -ne 0 ] || fail "real spawn failure exits non-zero" "$real_output"
  assert_contains "$(cat "$real_root/notifies.log")" "Spawn FAIL: lane=real-spawn-failure" "real spawn failure still sends Telegram alert"
  assert_file_contains "$real_root/runtime/dispatch-spawn-failures.log" "lane=real-spawn-failure" "real spawn failure remains in local ledger"
  pass "REGRESSION LOCK: fixture spawn failures stay local while real failures alert"
}

run_confirmed_terminal_case() {
  local label="$1" model="$2" expected="$3" mode="$4"
  local fixture="$tmpdir/terminal-$label" name="terminal-$label" branch="ag-terminal-$label"
  local report owner hold="$fixture/reentry-hold" signal_log="$fixture/signals.log"
  mkdir -p "$fixture/bin" "$fixture/runtime/ephemeral" "$fixture/codex-home"
  printf '{}\n' > "$fixture/codex-home/auth.json"
  printf 'Prompt.\n' > "$fixture/prompt.md"
  make_repo "$fixture/repo"
  if [ "$mode" = "review" ]; then
    printf '.claude/\n' >> "$fixture/repo/.git/info/exclude"
  fi
  write_common_stubs "$fixture/bin" "$fixture/notifies.log"
  write_codex_stub "$fixture/bin"
  report="$fixture/runtime/lane-reports/$branch.json"
  owner="$fixture/runtime/lane-owners/$branch.env"
  DISPATCH_TEST_SIGNAL_LOG="$signal_log" run_dispatch "$NEW_SCRIPT" "$fixture/repo" "$fixture/bin" "$fixture/codex-home" "$fixture/runtime" "$fixture/prompt.md" "$name" codex "$model" --mode "$mode" > "$fixture/first.out" 2>&1 || fail "$label confirmed launch returns success" "$(cat "$fixture/first.out")"
  wait_for_report_status "$report" "$expected" "$label confirmed exit terminalizes report"
  for _ in $(seq 1 200); do [ ! -e "$owner" ] && break; sleep 0.05; done
  [ ! -e "$owner" ] || fail "$label confirmed exit clears current owner" "$owner"
  [ ! -s "$signal_log" ] || fail "$label normal terminal cleanup sends no process signal" "$(cat "$signal_log")"
  FAKE_CODEX_SUCCESS_HOLD="$hold" run_dispatch "$NEW_SCRIPT" "$fixture/repo" "$fixture/bin" "$fixture/codex-home" "$fixture/runtime" "$fixture/prompt.md" "$name" codex good-marker --mode "$mode" > "$fixture/reentry.out" 2>&1 || fail "$label same-name re-entry succeeds" "$(cat "$fixture/reentry.out")"
  wait_for_log_line "$fixture/runtime/ephemeral/ag-$name.log" "session id: test-session" "$label re-entry marker"
  assert_reentry_state "$fixture" "$name" "$hold"
  pass "$label confirmed runner exit is terminal $expected and re-enterable"
}

run_authoritative_terminal_case() {
  local label="$1" status="$2" outer_result="$3" mode="$4"
  local fixture="$tmpdir/authoritative-$label" name="authoritative-$label" branch="ag-authoritative-$label"
  local model="authoritative-$status-$outer_result" report owner snapshot identity signal_log="$fixture/signals.log"
  mkdir -p "$fixture/bin" "$fixture/runtime/ephemeral" "$fixture/codex-home"
  printf '{}\n' > "$fixture/codex-home/auth.json"
  printf 'Prompt.\n' > "$fixture/prompt.md"
  make_repo "$fixture/repo"
  if [ "$mode" = "review" ]; then printf '.claude/\n' >> "$fixture/repo/.git/info/exclude"; fi
  write_common_stubs "$fixture/bin" "$fixture/notifies.log"
  write_codex_stub "$fixture/bin"
  report="$fixture/runtime/lane-reports/$branch.json"
  owner="$fixture/runtime/lane-owners/$branch.env"
  snapshot="$fixture/authoritative.snapshot"
  identity="$fixture/authoritative.identity"

  FAKE_LANE_REPORT_HELPER="$ROOT/tools/orchestrator/lane-report.sh" \
    FAKE_LANE_REPORT_DIR="$fixture/runtime/lane-reports" \
    FAKE_AUTHORITATIVE_SNAPSHOT="$snapshot" \
    FAKE_AUTHORITATIVE_IDENTITY="$identity" \
    DISPATCH_TEST_SIGNAL_LOG="$signal_log" \
    run_dispatch "$NEW_SCRIPT" "$fixture/repo" "$fixture/bin" "$fixture/codex-home" "$fixture/runtime" "$fixture/prompt.md" "$name" codex "$model" --mode "$mode" \
      > "$fixture/dispatch.out" 2>&1 || fail "$label authoritative launch confirms" "$(cat "$fixture/dispatch.out")"
  wait_for_report_status "$report" "$status" "$label authoritative report survives outer exit"
  for _ in $(seq 1 600); do [ ! -e "$owner" ] && break; sleep 0.05; done
  [ ! -e "$owner" ] || fail "$label authoritative terminal clears owner" "$owner"
  [ -f "$snapshot" ] || fail "$label provider published authoritative snapshot" "$snapshot"
  cmp -s "$snapshot" "$report" || fail "$label outer exit cannot replace authoritative report bytes" "$(diff -u "$snapshot" "$report" || true)"
  [ "$(stat -c '%d:%i:%h' "$report")" = "$(cat "$identity")" ] || fail "$label outer exit cannot replace authoritative report inode" "$report"
  [ ! -s "$signal_log" ] || fail "$label authoritative terminal cleanup sends no signal" "$(cat "$signal_log")"
  pass "$label canonical $status report is authoritative over outer $outer_result exit"
}

# M66 REGRESSION LOCK: the vitest hydration probe must be repo-aware. Agent
# repos (e.g. agent-bill) do NOT carry packages/master-orchestrator; instead a
# phantom node_modules-only dir at that path can appear via hydration. The
# probe must NOT hardcode that path (would land in a package.json-less dir and
# throw ERR_PNPM_RECURSIVE_EXEC_NO_PACKAGE) — it must discover a real vitest
# package. This case builds an agent-repo-shaped fixture (no master-orchestrator
# package.json, phantom master-orchestrator/node_modules present, real vitest
# package elsewhere) and proves hydration succeeds.
run_agent_repo_probe_case() {
  local disk_fixture name="agentprobe" branch="ag-agentprobe" report log
  local durable_tmpdir
  durable_tmpdir="$(mktemp -d /home/bpa-shell/.cache/dispatch-agentprobe-contract.XXXXXX)"
  disk_fixture="$durable_tmpdir"
  mkdir -p "$disk_fixture/bin" "$disk_fixture/runtime/ephemeral" "$disk_fixture/codex-home"
  printf '{}\n' > "$disk_fixture/codex-home/auth.json"
  printf 'Prompt.\n' > "$disk_fixture/prompt.md"
  make_repo "$disk_fixture/repo"
  mkdir -p "$disk_fixture/repo/node_modules/vitest"
  # Agent-repo shape: a phantom master-orchestrator dir with ONLY node_modules
  # and NO package.json (this is what tricks a hardcoded probe).
  mkdir -p "$disk_fixture/repo/packages/master-orchestrator/node_modules/vitest"
  write_common_stubs "$disk_fixture/bin" "$disk_fixture/notifies.log"
  write_codex_stub "$disk_fixture/bin"
  run_dispatch "$NEW_SCRIPT" "$disk_fixture/repo" "$disk_fixture/bin" "$disk_fixture/codex-home" "$disk_fixture/runtime" "$disk_fixture/prompt.md" "$name" codex hydration-pass > "$disk_fixture/dispatch.out" 2>&1 || fail "agent-repo-shape hydration probe discovers a real vitest package despite a phantom master-orchestrator dir" "$(cat "$disk_fixture/dispatch.out")"
  report="$disk_fixture/runtime/lane-reports/$branch.json"
  wait_for_report_status "$report" done "agent-repo-shape lane terminalizes done"
  pass "M66 REGRESSION LOCK: repo-aware vitest probe hydrates without packages/master-orchestrator package.json"
  rm -rf "$disk_fixture"
}

run_no_deps_provider_case() {
  local disk_fixture name="no-deps-provider" branch="ag-no-deps-provider" report log worktree

  durable_tmpdir="$(mktemp -d /home/bpa-shell/.cache/dispatch-no-deps-provider.XXXXXX)"
  disk_fixture="$durable_tmpdir"
  mkdir -p "$disk_fixture/bin" "$disk_fixture/runtime/ephemeral" "$disk_fixture/codex-home"
  printf '{}\n' > "$disk_fixture/codex-home/auth.json"
  printf 'Prompt.\n' > "$disk_fixture/prompt.md"
  make_repo "$disk_fixture/repo"
  write_common_stubs "$disk_fixture/bin" "$disk_fixture/notifies.log"
  write_codex_stub "$disk_fixture/bin"

  run_dispatch "$NEW_SCRIPT" "$disk_fixture/repo" "$disk_fixture/bin" "$disk_fixture/codex-home" "$disk_fixture/runtime" "$disk_fixture/prompt.md" "$name" codex no-deps-pass --no-deps > "$disk_fixture/dispatch.out" 2>&1 || fail "--no-deps coder provider launch confirms" "$(cat "$disk_fixture/dispatch.out")"
  report="$disk_fixture/runtime/lane-reports/$branch.json"
  log="$disk_fixture/runtime/ephemeral/ag-$name.log"
  worktree="$disk_fixture/repo/.claude/worktrees/$branch"
  wait_for_report_status "$report" done "--no-deps coder lane terminalizes done"
  assert_file_contains "$log" 'session id: no-deps-session' "--no-deps launches the provider"
  [ ! -e "$worktree/node_modules" ] || fail "--no-deps skips only hydration" "$worktree/node_modules exists"
  pass "--no-deps launches coder provider while skipping hydration and the Vitest probe"
  rm -rf "$disk_fixture"
  durable_tmpdir=""
}

run_hydration_case() {
  local fixture disk_fixture name="hydration" branch="ag-hydration"
  local report log output dangling_link hoist_target coder_worktree
  tmpfs_hydration_tmpdir="$(mktemp -d /tmp/dispatch-hydration-contract.XXXXXX)"
  fixture="$tmpfs_hydration_tmpdir"
  mkdir -p "$fixture/bin" "$fixture/runtime/ephemeral" "$fixture/codex-home"
  printf '{}\n' > "$fixture/codex-home/auth.json"
  printf 'Prompt.\n' > "$fixture/prompt.md"
  make_repo "$fixture/repo"
  mkdir -p "$fixture/repo/node_modules/vitest"
  write_common_stubs "$fixture/bin" "$fixture/notifies.log"
  write_codex_stub "$fixture/bin"
  set +e
  output="$(run_dispatch "$NEW_SCRIPT" "$fixture/repo" "$fixture/bin" "$fixture/codex-home" "$fixture/runtime" "$fixture/prompt.md" "$name" codex hydration-pass 2>&1)"
  set -e
  assert_contains "$output" 'dependency hydration requires disk-backed worktree storage' "hydration rejects tmpfs before materializing node_modules"
  [ ! -e "$fixture/repo/.claude/worktrees/$branch/node_modules" ] || fail "hydration leaves tmpfs worktree dependency-free" "$fixture/repo/.claude/worktrees/$branch/node_modules"

  durable_tmpdir="$(mktemp -d /home/bpa-shell/.cache/dispatch-hydration-contract.XXXXXX)"
  disk_fixture="$durable_tmpdir"
  mkdir -p "$disk_fixture/bin" "$disk_fixture/runtime/ephemeral" "$disk_fixture/codex-home"
  printf '{}\n' > "$disk_fixture/codex-home/auth.json"
  printf 'Prompt.\n' > "$disk_fixture/prompt.md"
  make_repo "$disk_fixture/repo"
  mkdir -p "$disk_fixture/repo/node_modules/vitest"
  write_common_stubs "$disk_fixture/bin" "$disk_fixture/notifies.log"
  write_codex_stub "$disk_fixture/bin"
  run_dispatch "$NEW_SCRIPT" "$disk_fixture/repo" "$disk_fixture/bin" "$disk_fixture/codex-home" "$disk_fixture/runtime" "$disk_fixture/prompt.md" "$name" codex hydration-pass > "$disk_fixture/dispatch.out" 2>&1 || fail "hydration dispatch confirms" "$(cat "$disk_fixture/dispatch.out")"
  report="$disk_fixture/runtime/lane-reports/$branch.json"
  log="$disk_fixture/runtime/ephemeral/ag-$name.log"
  wait_for_report_status "$report" done "hydration lane terminalizes done"
  assert_file_contains "$log" 'PASS hydration-lock.spec' "hydrated lane executes the regression suite"

  # B317 REGRESSION LOCK: coder worktrees hydrate their dependencies by
  # symlinking them to the shared checkout. A Spark review launched from that
  # coder branch must follow those source links and terminalize normally.
  coder_worktree="$disk_fixture/repo/.claude/worktrees/ag-coder-base"
  git -C "$disk_fixture/repo" worktree add -q -b ag-coder-base "$coder_worktree" dev
  ln -s "$disk_fixture/repo/node_modules" "$coder_worktree/node_modules"
  ln -s "$disk_fixture/repo/packages/example-pkg/node_modules" "$coder_worktree/packages/example-pkg/node_modules"
  run_dispatch "$NEW_SCRIPT" "$coder_worktree" "$disk_fixture/bin" "$disk_fixture/codex-home" "$disk_fixture/runtime" "$disk_fixture/prompt.md" spark-from-coder-base codex hydration-pass --mode review > "$disk_fixture/coder-base-dispatch.out" 2>&1 || fail "Spark review lane hydrates from a coder-branch base" "$(cat "$disk_fixture/coder-base-dispatch.out")"
  report="$disk_fixture/runtime/lane-reports/ag-spark-from-coder-base.json"
  log="$disk_fixture/runtime/ephemeral/ag-spark-from-coder-base.log"
  wait_for_report_status "$report" done "Spark review lane terminalizes done"
  assert_file_contains "$log" 'PASS hydration-lock.spec' "Spark review lane executes the regression suite"
  git -C "$disk_fixture/repo" worktree remove --force "$coder_worktree"
  git -C "$disk_fixture/repo" branch -D ag-coder-base >/dev/null
  pass "B317 REGRESSION LOCK: Spark review lane hydrates from coder-branch symlink dependencies"

  dangling_link="$disk_fixture/repo/node_modules/node_modules"
  ln -s "$dangling_link" "$dangling_link"
  run_dispatch "$NEW_SCRIPT" "$disk_fixture/repo" "$disk_fixture/bin" "$disk_fixture/codex-home" "$disk_fixture/runtime" "$disk_fixture/prompt.md" hydration-self-link codex hydration-pass > "$disk_fixture/dangling-dispatch.out" 2>&1 || fail "hydration cleans dangling source link" "$(cat "$disk_fixture/dangling-dispatch.out")"
  report="$disk_fixture/runtime/lane-reports/ag-hydration-self-link.json"
  log="$disk_fixture/runtime/ephemeral/ag-hydration-self-link.log"
  wait_for_report_status "$report" done "dangling source link lane terminalizes done"
  [ ! -L "$dangling_link" ] || fail "hydration removes dangling source link" "$dangling_link"
  assert_file_contains "$log" 'removed dangling source node_modules/node_modules link' "hydration records dangling source link cleanup"
  assert_file_contains "$log" 'PASS hydration-lock.spec' "dangling source link lane executes the regression suite"

  hoist_target="$disk_fixture/repo/apps/node_modules/.pnpm/node_modules"
  mkdir -p "$hoist_target" "$disk_fixture/repo/apps/web/node_modules"
  ln -s ../../node_modules/.pnpm/node_modules "$disk_fixture/repo/apps/web/node_modules/node_modules"
  run_dispatch "$NEW_SCRIPT" "$disk_fixture/repo" "$disk_fixture/bin" "$disk_fixture/codex-home" "$disk_fixture/runtime" "$disk_fixture/prompt.md" hydration-valid-hoist codex hydration-pass > "$disk_fixture/hoist-dispatch.out" 2>&1 || fail "hydration accepts valid pnpm hoist link" "$(cat "$disk_fixture/hoist-dispatch.out")"
  report="$disk_fixture/runtime/lane-reports/ag-hydration-valid-hoist.json"
  log="$disk_fixture/runtime/ephemeral/ag-hydration-valid-hoist.log"
  wait_for_report_status "$report" done "valid pnpm hoist lane terminalizes done"
  [ -L "$disk_fixture/repo/apps/web/node_modules/node_modules" ] || fail "hydration preserves valid pnpm hoist link" "$disk_fixture/repo/apps/web/node_modules/node_modules"
  assert_file_contains "$log" 'PASS hydration-lock.spec' "valid pnpm hoist lane executes the regression suite"
  pass "REGRESSION LOCK: dangling source link is cleaned and a valid pnpm hoist link hydrates Vitest"
}

run_b192_bounded_hydration_enumerator_case() {
  local fixture name="b192-bounded-owners" branch="ag-b192-bounded-owners"
  local rejected_name="b192-owner-loop" rejected_branch="ag-b192-owner-loop"
  local output red_output red_rc report log worktree status

  fixture="$(mktemp -d /home/bpa-shell/.cache/dispatch-b192-enumerator.XXXXXX)"
  mkdir -p "$fixture/bin" "$fixture/runtime/ephemeral" "$fixture/codex-home"
  printf '{}\n' > "$fixture/codex-home/auth.json"
  printf 'Prompt.\n' > "$fixture/prompt.md"
  make_repo "$fixture/repo"
  mkdir -p "$fixture/repo/apps/web/node_modules" "$fixture/repo/packages/worker/node_modules"
  write_common_stubs "$fixture/bin" "$fixture/notifies.log"
  write_codex_stub "$fixture/bin"

  ln -s . "$fixture/repo/apps/loop"
  set +e
  red_output="$(find -L "$fixture/repo/apps" "$fixture/repo/packages" -mindepth 2 -maxdepth 2 -type d -name node_modules -print 2>&1)"
  red_rc=$?
  set -e
  [ "$red_rc" -ne 0 ] || fail "RED-before cyclic find traversal exits non-zero" "$red_output"
  assert_contains "$red_output" 'File system loop detected' "RED-before cyclic find traversal detects the loop"

  set +e
  output="$(run_dispatch "$NEW_SCRIPT" "$fixture/repo" "$fixture/bin" "$fixture/codex-home" "$fixture/runtime" "$fixture/prompt.md" "$rejected_name" codex hydration-pass 2>&1)"
  set -e
  assert_contains "$output" 'dependency hydration failed' "bounded enumeration rejects cyclic owner before link creation"
  log="$fixture/runtime/ephemeral/ag-$rejected_name.log"
  assert_file_contains "$log" 'dependency hydration owner must not be a symlink' "bounded enumeration records rejected cyclic owner"
  worktree="$fixture/repo/.claude/worktrees/$rejected_branch"
  [ ! -e "$worktree/node_modules" ] && [ ! -L "$worktree/node_modules" ] || fail "rejected cyclic owner creates no dependency links" "$worktree/node_modules"
  pass "RED-before: cyclic find traversal is rejected before bounded hydration links anything"

  rm "$fixture/repo/apps/loop"
  run_dispatch "$NEW_SCRIPT" "$fixture/repo" "$fixture/bin" "$fixture/codex-home" "$fixture/runtime" "$fixture/prompt.md" "$name" codex hydration-pass > "$fixture/dispatch.out" 2>&1 || fail "bounded owner hydration dispatch confirms" "$(cat "$fixture/dispatch.out")"
  report="$fixture/runtime/lane-reports/$branch.json"
  log="$fixture/runtime/ephemeral/ag-$name.log"
  wait_for_log_line "$log" 'PASS hydration-lock.spec' "bounded owner hydration reaches the hydrated test command"
  assert_file_contains "$log" 'PASS hydration-lock.spec' "bounded owner hydration reaches the hydrated test command"
  assert_not_contains "$(cat "$log")" 'dependency hydration owner' "bounded owner hydration accepts exact owner paths"
  for _ in $(seq 1 600); do
    status="$(python3 - "$report" <<'PY'
import json
import sys

try:
    print(json.load(open(sys.argv[1])).get('status', ''))
except FileNotFoundError:
    print('')
PY
)"
    [ "$status" != 'launched' ] && [ -n "$status" ] && break
    sleep 0.05
  done
  pass "GREEN-after: bounded hydration links only root, direct app, and direct package owners"

  rm -rf "$fixture"
}

run_pre_owner_parent_crash_variant() {
  local variant="$1" fixture="$tmpdir/pre-owner-crash-$1" name="pre-owner-crash-$1" branch="ag-pre-owner-crash-$1"
  local helper="$fixture/fail-launched-helper.sh" owner context hold_owner="$fixture/owner-publication"
  local hold_context="$fixture/context-load" hold_provider="$fixture/provider" signal_log="$fixture/signals.log"
  local dispatcher_pid dispatcher_rc production_parent_pid runner_pid runner_start retry retry_rc wt branch_sha prompt_inode log_inode context_hold_value=""
  mkdir -p "$fixture/bin" "$fixture/runtime/ephemeral" "$fixture/codex-home"
  printf '{}\n' > "$fixture/codex-home/auth.json"
  printf 'Prompt crash handshake %s.\n' "$variant" > "$fixture/prompt.md"
  make_repo "$fixture/repo"
  write_common_stubs "$fixture/bin" "$fixture/notifies.log"
  write_codex_stub "$fixture/bin"
  cat > "$fixture/bin/mv" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
source_path="${*: -2:1}"
destination="${*: -1}"
if [ -n "${FAKE_OWNER_PUBLICATION_HOLD:-}" ] && [[ "$destination" == */lane-owners/*.env ]] && grep -Fqx 'mode=setsid' "$source_path"; then
  parent="$PPID"
  for fd in $(seq 3 200); do eval "exec $fd>&-" 2>/dev/null || true; done
  : > "${FAKE_OWNER_PUBLICATION_HOLD}.ready"
  while [ ! -f "${FAKE_OWNER_PUBLICATION_HOLD}.release" ]; do
    kill -0 "$parent" 2>/dev/null || exit 99
    sleep 0.05
  done
fi
exec /usr/bin/mv "$@"
EOF
  chmod +x "$fixture/bin/mv"
  cat > "$helper" <<EOF
#!/usr/bin/env bash
for ((i=1; i<=\$#; i++)); do
  if [ "\${!i}" = "--status" ]; then
    j=\$((i + 1))
    [ "\${!j}" != "launched" ] || exit 75
  fi
done
exec "$ROOT/tools/orchestrator/lane-report.sh" "\$@"
EOF
  chmod +x "$helper"
  owner="$fixture/runtime/lane-owners/$branch.env"
  context="$fixture/runtime/lane-tmp/$branch/runner-context.env"
  wt="$fixture/repo/.claude/worktrees/$branch"

  [ "$variant" != "before-consume" ] || context_hold_value="$hold_context"
  (
    FAKE_OWNER_PUBLICATION_HOLD="$hold_owner" \
    FAKE_CODEX_TERMINAL_HOLD="$hold_provider" \
    DISPATCH_TEST_HOLD_BEFORE_CONTEXT_LOAD="$context_hold_value" \
    LANE_REPORT_HELPER="$helper" DISPATCH_TEST_SIGNAL_LOG="$signal_log" \
      run_dispatch "$NEW_SCRIPT" "$fixture/repo" "$fixture/bin" "$fixture/codex-home" "$fixture/runtime" "$fixture/prompt.md" "$name" codex terminal-zero
  ) > "$fixture/dispatcher.out" 2>&1 &
  dispatcher_pid=$!
  wait_for_log_line "$fixture/runtime/ephemeral/ag-$name.log" "lane-detach=setsid pid=" "$variant detached runner starts"
  for _ in $(seq 1 200); do [ -f "$hold_owner.ready" ] && break; sleep 0.05; done
  [ -f "$hold_owner.ready" ] || fail "$variant parent pauses inside exact owner publication" "$(cat "$fixture/dispatcher.out")"
  runner_pid="$(awk -F'pid=' '/lane-detach=setsid pid=/{print $2; exit}' "$fixture/runtime/ephemeral/ag-$name.log")"
  runner_start="$(process_start_token "$runner_pid")"
  production_parent_pid="$(ps -o ppid= -p "$runner_pid" | tr -d ' ')"
  [[ "$production_parent_pid" =~ ^[0-9]+$ ]] || fail "$variant captures production dispatcher pid" "$production_parent_pid"
  printf '%s %s\n' "$runner_pid" "$runner_start" >> "$tracked_processes"
  if [ "$variant" = "before-consume" ]; then
    for _ in $(seq 1 200); do [ -f "$hold_context.ready" ] && break; sleep 0.05; done
    [ -f "$hold_context.ready" ] || fail "$variant child pauses before context load" "$hold_context"
    [ -f "$context" ] || fail "$variant context remains durable before consumption" "$context"
  else
    for _ in $(seq 1 200); do [ -f "$hold_provider.ready" ] && break; sleep 0.05; done
    [ -f "$hold_provider.ready" ] || fail "$variant provider is live after context consumption" "$hold_provider"
    [ ! -e "$context" ] || fail "$variant child consumed only its own context" "$context"
  fi

  kill -KILL "$production_parent_pid"
  set +e; wait "$dispatcher_pid"; dispatcher_rc=$?; set -e
  [ "$dispatcher_rc" -ne 0 ] || fail "$variant injected parent crash is nonzero" "$dispatcher_rc"
  assert_file_contains "$owner" 'mode=preserved' "$variant pre-detach owner survives parent crash"
  branch_sha="$(git -C "$fixture/repo" rev-parse "refs/heads/$branch")"
  prompt_inode="$(stat -c '%d:%i:%h' "$fixture/runtime/ephemeral/ag-$name.prompt.txt")"
  log_inode="$(stat -c '%d:%i:%h' "$fixture/runtime/ephemeral/ag-$name.log")"
  kill -0 "$runner_pid" 2>/dev/null || fail "$variant detached runner survives parent crash" "$runner_pid"

  set +e
  retry="$(DISPATCH_TEST_SIGNAL_LOG="$signal_log" run_dispatch "$NEW_SCRIPT" "$fixture/repo" "$fixture/bin" "$fixture/codex-home" "$fixture/runtime" "$fixture/prompt.md" "$name" codex good-marker 2>&1)"
  retry_rc=$?
  set -e
  [ "$retry_rc" -ne 0 ] || fail "$variant same-name retry fails closed" "$retry"
  assert_contains "$retry" "ownership indeterminate" "$variant retry stops on durable handshake"
  [ "$(git -C "$fixture/repo" rev-parse "refs/heads/$branch")" = "$branch_sha" ] || fail "$variant retry preserves branch" "$branch"
  [ -d "$wt" ] || fail "$variant retry preserves live worktree" "$wt"
  [ "$(stat -c '%d:%i:%h' "$fixture/runtime/ephemeral/ag-$name.prompt.txt")" = "$prompt_inode" ] || fail "$variant retry preserves prompt inode" "$prompt_inode"
  [ "$(stat -c '%d:%i:%h' "$fixture/runtime/ephemeral/ag-$name.log")" = "$log_inode" ] || fail "$variant retry preserves log inode" "$log_inode"
  [ ! -s "$signal_log" ] || fail "$variant retry never signals live lane" "$(cat "$signal_log")"
  kill -0 "$runner_pid" 2>/dev/null || fail "$variant retry preserves live runner" "$runner_pid"

  [ "$variant" != "before-consume" ] || : > "$hold_context.release"
  : > "$hold_provider.release"
  wait_for_exact_process_exit "$runner_pid" "$runner_start" "$variant runner exits after controlled release"
  pass "$variant parent-crash retry preserves owner/context/checkout/branch/process without signalling"
}

run_pre_owner_parent_crash_case() {
  run_pre_owner_parent_crash_variant before-consume
  run_pre_owner_parent_crash_variant after-consume
}

run_terminal_report_failure_case() {
  local fixture="$tmpdir/terminal-helper-failure" name="terminal-helper-failure" branch="ag-terminal-helper-failure"
  local helper="$fixture/fail-terminal-helper.sh" owner output rc
  mkdir -p "$fixture/bin" "$fixture/runtime/ephemeral" "$fixture/codex-home"
  printf '{}\n' > "$fixture/codex-home/auth.json"
  printf 'Prompt.\n' > "$fixture/prompt.md"
  make_repo "$fixture/repo"
  write_common_stubs "$fixture/bin" "$fixture/notifies.log"
  write_codex_stub "$fixture/bin"
  cat > "$helper" <<EOF
#!/usr/bin/env bash
for ((i=1; i<=\$#; i++)); do
  if [ "\${!i}" = "--status" ]; then
    j=\$((i + 1))
    [ "\${!j}" = "launched" ] || exit 75
  fi
done
exec "$ROOT/tools/orchestrator/lane-report.sh" "\$@"
EOF
  chmod +x "$helper"
  LANE_REPORT_HELPER="$helper" run_dispatch "$NEW_SCRIPT" "$fixture/repo" "$fixture/bin" "$fixture/codex-home" "$fixture/runtime" "$fixture/prompt.md" "$name" codex terminal-zero > "$fixture/first.out" 2>&1 || fail "terminal-helper-failure launch confirms" "$(cat "$fixture/first.out")"
  owner="$fixture/runtime/lane-owners/$branch.env"
  for _ in $(seq 1 200); do [ -f "$owner" ] && grep -Fq 'mode=preserved' "$owner" && break; sleep 0.05; done
  assert_file_contains "$owner" 'mode=preserved' "terminal helper failure preserves ownership evidence"
  set +e
  output="$(run_dispatch "$NEW_SCRIPT" "$fixture/repo" "$fixture/bin" "$fixture/codex-home" "$fixture/runtime" "$fixture/prompt.md" "$name" codex good-marker 2>&1)"
  rc=$?
  set -e
  [ "$rc" -ne 0 ] || fail "terminal helper failure refuses same-name re-entry" "$output"
  assert_contains "$output" "ownership indeterminate" "terminal helper failure is fail-closed"
  pass "terminal report-helper failure preserves mechanically reclaimable ownership evidence"
}

run_setsid_publication_failure_case() {
  local variant="$1" fixture="$tmpdir/setsid-publication-$1" name="setsid-publication-$1" branch="ag-setsid-publication-$1"
  local owner report signal_log="$fixture/signals.log" hold="$fixture/runner-hold" output rc second second_rc helper="$fixture/failing-report.sh" runner_pid runner_start
  mkdir -p "$fixture/bin" "$fixture/runtime/ephemeral" "$fixture/codex-home"
  printf '{}\n' > "$fixture/codex-home/auth.json"
  printf 'Prompt.\n' > "$fixture/prompt.md"
  make_repo "$fixture/repo"
  write_common_stubs "$fixture/bin" "$fixture/notifies.log"
  write_codex_stub "$fixture/bin"
  printf '#!/usr/bin/env bash\nexit 76\n' > "$helper"
  chmod +x "$helper"
  owner="$fixture/runtime/lane-owners/$branch.env"
  report="$fixture/runtime/lane-reports/$branch.json"
  set +e
  case "$variant" in
    stopped)
      output="$(DISPATCH_TEST_FORCE_OWNERSHIP_PUBLICATION_FAILURE=1 DISPATCH_TEST_SIGNAL_LOG="$signal_log" run_dispatch "$NEW_SCRIPT" "$fixture/repo" "$fixture/bin" "$fixture/codex-home" "$fixture/runtime" "$fixture/prompt.md" "$name" codex terminal-zero 2>&1)"
      ;;
    mismatch)
      output="$(DISPATCH_TEST_FORCE_OWNERSHIP_PUBLICATION_FAILURE=1 DISPATCH_TEST_RUNNER_STARTTIME_OVERRIDE=1 DISPATCH_TEST_SIGNAL_LOG="$signal_log" FAKE_CODEX_TERMINAL_HOLD="$hold" run_dispatch "$NEW_SCRIPT" "$fixture/repo" "$fixture/bin" "$fixture/codex-home" "$fixture/runtime" "$fixture/prompt.md" "$name" codex terminal-zero 2>&1)"
      ;;
    report-failure)
      output="$(DISPATCH_TEST_FORCE_OWNERSHIP_PUBLICATION_FAILURE=1 DISPATCH_TEST_SIGNAL_LOG="$signal_log" LANE_REPORT_HELPER="$helper" run_dispatch "$NEW_SCRIPT" "$fixture/repo" "$fixture/bin" "$fixture/codex-home" "$fixture/runtime" "$fixture/prompt.md" "$name" codex terminal-zero 2>&1)"
      ;;
  esac
  rc=$?
  set -e
  [ "$rc" -ne 0 ] || fail "$variant setsid publication failure exits nonzero" "$output"
  if [ "$variant" = "stopped" ]; then
    [ -s "$signal_log" ] || fail "setsid publication failure signals exact captured identity" "$signal_log"
    assert_failed_report "$report" "setsid publication failure terminalizes after proven stop"
    [ ! -e "$owner" ] || fail "setsid publication failure clears owner after proven stop" "$owner"
    FAKE_CODEX_SUCCESS_HOLD="$hold" run_dispatch "$NEW_SCRIPT" "$fixture/repo" "$fixture/bin" "$fixture/codex-home" "$fixture/runtime" "$fixture/prompt.md" "$name" codex good-marker > "$fixture/reentry.out" 2>&1 || fail "setsid publication failure re-enters" "$(cat "$fixture/reentry.out")"
    assert_reentry_state "$fixture" "$name" "$hold"
  else
    if [ "$variant" = "mismatch" ]; then
      [ ! -s "$signal_log" ] || fail "PID/starttime mismatch is never signalled on publication failure" "$(cat "$signal_log")"
    else
      [ -s "$signal_log" ] || fail "report-failure path stops the exact captured runner" "$signal_log"
    fi
    assert_file_contains "$owner" 'mode=preserved' "mismatched publication failure preserves owner"
    set +e; second="$(run_dispatch "$NEW_SCRIPT" "$fixture/repo" "$fixture/bin" "$fixture/codex-home" "$fixture/runtime" "$fixture/prompt.md" "$name" codex good-marker 2>&1)"; second_rc=$?; set -e
    [ "$second_rc" -ne 0 ] || fail "mismatched publication failure refuses re-entry" "$second"
    if [ "$variant" = "mismatch" ]; then
      runner_pid="$(awk -F= '$1 == "pid" { print $2; exit }' "$owner")"
      runner_start="$(process_start_token "$runner_pid")"
      : > "$hold.release"
      wait_for_exact_process_exit "$runner_pid" "$runner_start" "mismatched publication runner exits after release"
    fi
  fi
  pass "setsid ownership-publication failure $variant path is identity-safe"
}

run_timeout_identity_mismatch_case() {
  local fixture="$tmpdir/timeout-identity" name="timeout-identity" branch="ag-timeout-identity"
  local hold="$fixture/provider-hold" signal_log="$fixture/signals.log" owner output rc runner_pid runner_start
  mkdir -p "$fixture/bin" "$fixture/runtime/ephemeral" "$fixture/codex-home"
  printf '{}\n' > "$fixture/codex-home/auth.json"
  printf 'Prompt.\n' > "$fixture/prompt.md"
  make_repo "$fixture/repo"
  write_common_stubs "$fixture/bin" "$fixture/notifies.log"
  write_codex_stub "$fixture/bin"
  set +e
  output="$(DISPATCH_TEST_RUNNER_STARTTIME_OVERRIDE=1 DISPATCH_TEST_SIGNAL_LOG="$signal_log" FAKE_CODEX_TERMINAL_HOLD="$hold" DISPATCH_SPAWN_CONFIRM_TIMEOUT=1 run_dispatch "$NEW_SCRIPT" "$fixture/repo" "$fixture/bin" "$fixture/codex-home" "$fixture/runtime" "$fixture/prompt.md" "$name" codex no-marker-hold 2>&1)"
  rc=$?
  set -e
  [ "$rc" -ne 0 ] || fail "timeout identity mismatch exits nonzero" "$output"
  [ ! -s "$signal_log" ] || fail "timeout mismatch never signals PID or group" "$(cat "$signal_log")"
  owner="$fixture/runtime/lane-owners/$branch.env"
  assert_file_contains "$owner" 'mode=preserved' "timeout mismatch preserves ownership evidence"
  runner_pid="$(awk -F= '$1 == "pid" { print $2; exit }' "$owner")"
  runner_start="$(process_start_token "$runner_pid")"
  : > "$hold.release"
  wait_for_exact_process_exit "$runner_pid" "$runner_start" "timeout mismatch runner exits after release"
  pass "timeout cleanup refuses to signal a PID/starttime mismatch"
}

run_spawn_failure_identity_mismatch_case() {
  local fixture="$tmpdir/spawn-failure-identity" name="spawn-failure-identity" branch="ag-spawn-failure-identity"
  local hold="$fixture/provider-hold" signal_log="$fixture/signals.log" owner output rc runner_pid runner_start
  mkdir -p "$fixture/bin" "$fixture/runtime/ephemeral" "$fixture/codex-home"
  printf '{}\n' > "$fixture/codex-home/auth.json"
  printf 'Prompt.\n' > "$fixture/prompt.md"
  make_repo "$fixture/repo"
  write_common_stubs "$fixture/bin" "$fixture/notifies.log"
  write_codex_stub "$fixture/bin"
  set +e
  output="$(DISPATCH_TEST_RUNNER_STARTTIME_OVERRIDE=1 DISPATCH_TEST_SIGNAL_LOG="$signal_log" FAKE_CODEX_TERMINAL_HOLD="$hold" run_dispatch "$NEW_SCRIPT" "$fixture/repo" "$fixture/bin" "$fixture/codex-home" "$fixture/runtime" "$fixture/prompt.md" "$name" codex bad-marker-hold 2>&1)"
  rc=$?
  set -e
  [ "$rc" -ne 0 ] || fail "spawn-failure identity mismatch exits nonzero" "$output"
  [ ! -s "$signal_log" ] || fail "spawn-failure mismatch never signals PID or group" "$(cat "$signal_log")"
  owner="$fixture/runtime/lane-owners/$branch.env"
  assert_file_contains "$owner" 'mode=preserved' "spawn-failure mismatch preserves ownership evidence"
  runner_pid="$(awk -F= '$1 == "pid" { print $2; exit }' "$owner")"
  runner_start="$(process_start_token "$runner_pid")"
  : > "$hold.release"
  wait_for_exact_process_exit "$runner_pid" "$runner_start" "spawn-failure mismatch runner exits after release"
  pass "detected spawn failure refuses to signal a PID/starttime mismatch"
}

run_dirty_evidence_preservation_case() {
  local fixture="$tmpdir/dirty-evidence" name="dirty-evidence" branch="ag-dirty-evidence"
  local wt owner output rc second second_rc
  mkdir -p "$fixture/bin" "$fixture/runtime/ephemeral" "$fixture/codex-home"
  printf '{}\n' > "$fixture/codex-home/auth.json"
  printf 'Prompt.\n' > "$fixture/prompt.md"
  make_repo "$fixture/repo"
  write_common_stubs "$fixture/bin" "$fixture/notifies.log"
  write_codex_stub "$fixture/bin"
  set +e
  output="$(run_dispatch "$NEW_SCRIPT" "$fixture/repo" "$fixture/bin" "$fixture/codex-home" "$fixture/runtime" "$fixture/prompt.md" "$name" codex dirty-no-marker 2>&1)"
  rc=$?
  set -e
  [ "$rc" -ne 0 ] || fail "dirty failed spawn exits nonzero" "$output"
  wt="$fixture/repo/.claude/worktrees/$branch"
  owner="$fixture/runtime/lane-owners/$branch.env"
  assert_file_contains "$wt/dirty-evidence.txt" 'dirty evidence' "dirty failed spawn preserves checkout bytes"
  assert_file_contains "$owner" 'mode=preserved' "dirty failed spawn publishes recovery ownership"
  set +e
  second="$(run_dispatch "$NEW_SCRIPT" "$fixture/repo" "$fixture/bin" "$fixture/codex-home" "$fixture/runtime" "$fixture/prompt.md" "$name" codex good-marker 2>&1)"
  second_rc=$?
  set -e
  [ "$second_rc" -ne 0 ] || fail "routine retry refuses dirty evidence" "$second"
  assert_file_contains "$wt/dirty-evidence.txt" 'dirty evidence' "routine retry cannot force-remove dirty evidence"
  pass "dirty cleanup evidence stays in durable operator-recovery state"
}

case "$TEST_CASE" in
  hydration)
    run_hydration_case
    echo "dispatch-agent spawn contract tests passed"
    exit 0
    ;;
  b192-bounded-enumerator)
    run_b192_bounded_hydration_enumerator_case
    echo "dispatch-agent spawn contract tests passed"
    exit 0
    ;;
  agent-repo-probe)
    run_agent_repo_probe_case
    echo "dispatch-agent spawn contract tests passed"
    exit 0
    ;;
  no-deps-provider)
    run_no_deps_provider_case
    echo "dispatch-agent spawn contract tests passed"
    exit 0
    ;;
  immediate-detach-reentry)
    run_failure_reentry_case immediate-detach good-marker 1 6
    echo "dispatch-agent spawn contract tests passed"
    exit 0
    ;;
  provider-exit-reentry)
    run_failure_reentry_case provider-exit exit-no-marker 0 6
    echo "dispatch-agent spawn contract tests passed"
    exit 0
    ;;
  detected-model-reentry)
    run_failure_reentry_case detected-model bad-fast-400 0 6
    echo "dispatch-agent spawn contract tests passed"
    exit 0
    ;;
  spawn-failure-alert-routing)
    run_spawn_failure_alert_routing_case
    echo "dispatch-agent spawn contract tests passed"
    exit 0
    ;;
  confirmation-timeout-reentry)
    run_failure_reentry_case confirmation-timeout hang-no-marker 0 2
    echo "dispatch-agent spawn contract tests passed"
    exit 0
    ;;
  confirmed-zero-reentry)
    run_confirmed_terminal_case confirmed-zero terminal-zero done coder
    echo "dispatch-agent spawn contract tests passed"
    exit 0
    ;;
  confirmed-nonzero-reentry)
    run_confirmed_terminal_case confirmed-nonzero terminal-nonzero failed coder
    echo "dispatch-agent spawn contract tests passed"
    exit 0
    ;;
  confirmed-review-nonzero-reentry)
    run_confirmed_terminal_case confirmed-review-nonzero terminal-nonzero failed review
    echo "dispatch-agent spawn contract tests passed"
    exit 0
    ;;
  authoritative-done-nonzero-coder)
    run_authoritative_terminal_case done-nonzero-coder done nonzero coder
    echo "dispatch-agent spawn contract tests passed"
    exit 0
    ;;
  authoritative-done-nonzero-review)
    run_authoritative_terminal_case done-nonzero-review done nonzero review
    echo "dispatch-agent spawn contract tests passed"
    exit 0
    ;;
  authoritative-failed-zero-coder)
    run_authoritative_terminal_case failed-zero-coder failed zero coder
    echo "dispatch-agent spawn contract tests passed"
    exit 0
    ;;
  pre-owner-parent-crash)
    run_pre_owner_parent_crash_case
    echo "dispatch-agent spawn contract tests passed"
    exit 0
    ;;
  terminal-report-failure)
    run_terminal_report_failure_case
    echo "dispatch-agent spawn contract tests passed"
    exit 0
    ;;
  setsid-publication-stopped)
    run_setsid_publication_failure_case stopped
    echo "dispatch-agent spawn contract tests passed"
    exit 0
    ;;
  setsid-publication-mismatch)
    run_setsid_publication_failure_case mismatch
    echo "dispatch-agent spawn contract tests passed"
    exit 0
    ;;
  setsid-publication-report-failure)
    run_setsid_publication_failure_case report-failure
    echo "dispatch-agent spawn contract tests passed"
    exit 0
    ;;
  timeout-identity-mismatch)
    run_timeout_identity_mismatch_case
    echo "dispatch-agent spawn contract tests passed"
    exit 0
    ;;
  spawn-failure-identity-mismatch)
    run_spawn_failure_identity_mismatch_case
    echo "dispatch-agent spawn contract tests passed"
    exit 0
    ;;
  dirty-evidence-preservation)
    run_dirty_evidence_preservation_case
    echo "dispatch-agent spawn contract tests passed"
    exit 0
    ;;
  all) ;;
  *) fail "unknown DISPATCH_SPAWN_TEST_CASE" "$TEST_CASE" ;;
esac

run_hydration_case
run_agent_repo_probe_case
run_no_deps_provider_case

negative_dir="$tmpdir/negative"
mkdir -p "$negative_dir/bin" "$negative_dir/runtime/ephemeral" "$negative_dir/codex-home"
printf '{}\n' > "$negative_dir/codex-home/auth.json"
printf 'Prompt.\n' > "$negative_dir/prompt.md"
make_repo "$negative_dir/repo"
write_common_stubs "$negative_dir/bin" "$negative_dir/notifies.log"
write_codex_stub "$negative_dir/bin"
write_legacy_dispatch_script

set +e
old_output="$(run_dispatch "$OLD_SCRIPT" "$negative_dir/repo" "$negative_dir/bin" "$negative_dir/codex-home" "$negative_dir/runtime" "$negative_dir/prompt.md" "spawn-old" codex bad-fast-400 2>&1)"
old_rc=$?
set -e
[ "$old_rc" -eq 0 ] || fail "old script stays green on bad model" "$old_output"
assert_not_contains "$old_output" "FATAL: lane=spawn-old" "old script no loud fatal"
[ ! -s "$negative_dir/notifies.log" ] || fail "old script must not notify on the broken path" "$(cat "$negative_dir/notifies.log")"
pass "RED-before: old script returns success on a bad model spawn"

set +e
new_output="$(run_dispatch "$NEW_SCRIPT" "$negative_dir/repo" "$negative_dir/bin" "$negative_dir/codex-home" "$negative_dir/runtime" "$negative_dir/prompt.md" "spawn-new" codex bad-fast-400 2>&1)"
new_rc=$?
set -e
[ "$new_rc" -ne 0 ] || fail "new script exits non-zero on bad model" "$new_output"
assert_contains "$new_output" "FATAL: lane=spawn-new provider=codex model=bad-fast-400 spawn failed:" "new script fatal names lane/provider/model"
assert_contains "$(cat "$negative_dir/notifies.log")" "/notify|🔴 Spawn FAIL: lane=spawn-new provider=codex model=bad-fast-400." "new script notify path"
[ ! -d "$negative_dir/repo/.claude/worktrees/ag-spawn-new" ] || fail "failed spawn worktree cleaned" "$new_output"
git -C "$negative_dir/repo" show-ref --verify --quiet refs/heads/ag-spawn-new && fail "failed spawn branch cleaned" ""
[ -s "$negative_dir/runtime/dispatch-spawn-failures.log" ] || fail "spawn failures ledger written" ""
pass "GREEN-after: new script fails loud, notifies, and cleans the dead lane"

run_failure_reentry_case immediate-detach good-marker 1 6
run_failure_reentry_case provider-exit exit-no-marker 0 6
run_failure_reentry_case detected-model bad-fast-400 0 6
run_spawn_failure_alert_routing_case
run_failure_reentry_case confirmation-timeout hang-no-marker 0 2
run_confirmed_terminal_case confirmed-zero terminal-zero done coder
run_confirmed_terminal_case confirmed-nonzero terminal-nonzero failed coder
run_confirmed_terminal_case confirmed-review-nonzero terminal-nonzero failed review
run_authoritative_terminal_case done-nonzero-coder done nonzero coder
run_authoritative_terminal_case done-nonzero-review done nonzero review
run_authoritative_terminal_case failed-zero-coder failed zero coder
run_hydration_case
run_b192_bounded_hydration_enumerator_case
run_pre_owner_parent_crash_case
run_terminal_report_failure_case
run_setsid_publication_failure_case stopped
run_setsid_publication_failure_case mismatch
run_setsid_publication_failure_case report-failure
run_timeout_identity_mismatch_case
run_spawn_failure_identity_mismatch_case
run_dirty_evidence_preservation_case

positive_dir="$tmpdir/positive"
mkdir -p "$positive_dir/bin" "$positive_dir/runtime/ephemeral" "$positive_dir/codex-home"
printf '{}\n' > "$positive_dir/codex-home/auth.json"
printf 'Prompt.\n' > "$positive_dir/prompt.md"
make_repo "$positive_dir/repo"
write_common_stubs "$positive_dir/bin" "$positive_dir/notifies.log"
write_codex_stub "$positive_dir/bin"

start_epoch="$(date +%s)"
run_dispatch "$NEW_SCRIPT" "$positive_dir/repo" "$positive_dir/bin" "$positive_dir/codex-home" "$positive_dir/runtime" "$positive_dir/prompt.md" "spawn-good" codex good-marker >"$positive_dir/dispatch.stdout" 2>&1
elapsed=$(( $(date +%s) - start_epoch ))
[ "$elapsed" -ge 2 ] || fail "success waits for marker" "elapsed=$elapsed"
[ -d "$positive_dir/repo/.claude/worktrees/ag-spawn-good" ] || fail "successful spawn keeps worktree" ""
assert_contains "$(cat "$positive_dir/runtime/ephemeral/ag-spawn-good.log")" "session id: test-session" "success marker recorded"
pass "successful codex spawn returns only after the marker appears"

# ── Regression lock (B096.1 defect): a healthy codex spawn whose PROMPT body
#    contains spawn-failure keywords ("FORBIDDEN", "authentication failed") must
#    NOT be misclassified as a spawn failure. Pre-fix, spawn_failure_reason_from_log
#    grepped the whole $LOG — including the echoed prompt — and killed the lane
#    with a false "authentication failed during spawn". Fixed by confining the
#    scan to the pre-prompt handshake region.
poison_dir="$tmpdir/poison"
mkdir -p "$poison_dir/bin" "$poison_dir/runtime/ephemeral" "$poison_dir/codex-home"
printf '{}\n' > "$poison_dir/codex-home/auth.json"
cat > "$poison_dir/prompt.md" <<'POISONPROMPT'
Fix the failing test. jsdom locks are FORBIDDEN for this bug class.
The login page currently shows "authentication failed" and returns forbidden;
this is unauthorized behaviour that must be corrected.
POISONPROMPT
make_repo "$poison_dir/repo"
write_common_stubs "$poison_dir/bin" "$poison_dir/notifies.log"
write_codex_stub "$poison_dir/bin"

run_dispatch "$NEW_SCRIPT" "$poison_dir/repo" "$poison_dir/bin" "$poison_dir/codex-home" "$poison_dir/runtime" "$poison_dir/prompt.md" "spawn-poison" codex poison-prompt >"$poison_dir/dispatch.stdout" 2>&1
poison_rc=$?
[ "$poison_rc" -eq 0 ] || fail "healthy spawn with poison-word prompt returns success" "rc=$poison_rc"$'\n'"$(cat "$poison_dir/dispatch.stdout" 2>/dev/null)"
assert_not_contains "$(cat "$poison_dir/dispatch.stdout" 2>/dev/null)" "spawn failed: authentication failed during spawn" "no false auth-fail on poison-word prompt"
[ -d "$poison_dir/repo/.claude/worktrees/ag-spawn-poison" ] || fail "healthy poison-word spawn keeps its worktree" ""
git -C "$poison_dir/repo" show-ref --verify --quiet refs/heads/ag-spawn-poison || fail "healthy poison-word spawn keeps its branch" ""
[ ! -s "$poison_dir/notifies.log" ] || fail "healthy poison-word spawn must not fire a spawn alarm" "$(cat "$poison_dir/notifies.log")"
[ ! -s "$poison_dir/runtime/dispatch-spawn-failures.log" ] || fail "healthy poison-word spawn must not write the failures ledger" "$(cat "$poison_dir/runtime/dispatch-spawn-failures.log")"
pass "REGRESSION LOCK: healthy codex spawn is not killed by failure keywords in the prompt body"

claude_dir="$tmpdir/claude"
mkdir -p "$claude_dir/bin" "$claude_dir/runtime/ephemeral" "$claude_dir/codex-home"
printf '{}\n' > "$claude_dir/codex-home/auth.json"
printf 'Prompt.\n' > "$claude_dir/prompt.md"
make_repo "$claude_dir/repo"
write_common_stubs "$claude_dir/bin" "$claude_dir/notifies.log"
write_codex_stub "$claude_dir/bin"

run_dispatch "$NEW_SCRIPT" "$claude_dir/repo" "$claude_dir/bin" "$claude_dir/codex-home" "$claude_dir/runtime" "$claude_dir/prompt.md" "spawn-claude" claude sonnet >"$claude_dir/dispatch.stdout" 2>&1
wait_for_log_line "$claude_dir/runtime/ephemeral/ag-spawn-claude.log" "I have all the information needed." "claude marker"
assert_contains "$(cat "$claude_dir/runtime/ephemeral/ag-spawn-claude.log")" "I have all the information needed." "claude output marker recorded"
pass "successful claude spawn confirms on first output"

echo "dispatch-agent spawn contract tests passed"
