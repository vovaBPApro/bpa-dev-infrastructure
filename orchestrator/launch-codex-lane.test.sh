#!/usr/bin/env bash
# End-to-end regression locks for the Codex coder-lane dispatch tail.
set -euo pipefail
exec 3>&2

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_REPO="$(cd "$SCRIPT_DIR/.." && pwd -P)"
SCRATCH="$(mktemp -d "$SOURCE_REPO/.launcher-test.XXXXXX")"
cleanup() {
  if [[ "${ORCH_TEST_KEEP_SCRATCH:-0}" == 1 ]]; then
    printf 'test scratch retained: %s\n' "$SCRATCH" >&2
  else
    rm -rf "$SCRATCH"
  fi
}
trap cleanup EXIT
mkdir -p "$SCRATCH/tmp"
export TMPDIR="$SCRATCH/tmp"

fail() {
  printf 'FAIL row=%s %s\n' "${ROW:-setup}" "$*" >&3
  exit 1
}

pass() {
  printf 'PASS row=%s %s\n' "$ROW" "$*"
}

expect_status() {
  local expected="$1"
  shift
  local actual
  set +e
  "$@"
  actual=$?
  set -e
  [[ "$actual" == "$expected" ]] || fail "expected-exit=$expected actual=$actual command=$*"
}

SEED="$SCRATCH/repo"
ORIGIN="$SCRATCH/origin.git"
SHIM="$SCRATCH/bin"
STATE="$SCRATCH/state"
EVIDENCE="$SCRATCH/evidence"
LANES="$SCRATCH/lanes"
HOME_DIR="$SCRATCH/home"
mkdir -p "$SEED" "$SHIM" "$STATE" "$EVIDENCE" "$LANES" "$HOME_DIR/.codex"

# Copy the current checkout, including uncommitted implementation-under-test
# files, into a private Git repository. The scratch root is excluded to prevent
# recursive copying because it deliberately lives below the assigned worktree.
rsync -a \
  --exclude='.git' \
  --exclude='.claude/worktrees' \
  --exclude='.launcher-test.*' \
  --exclude='node_modules' \
  --exclude='orchestrator/runtime' \
  "$SOURCE_REPO/" "$SEED/"

git -C "$SEED" init -q -b main
git -C "$SEED" config user.name 'Codex Launcher Test'
git -C "$SEED" config user.email 'codex-launcher-test@example.invalid'
# dispatch-check's marker contract requires at least eight hexadecimal digits;
# make the synthetic repository deterministic instead of relying on collision-
# driven abbreviation expansion in the long-lived source repository.
git -C "$SEED" config core.abbrev 8
git -C "$SEED" add -A
git -C "$SEED" commit -qm '[CODER] seed launcher test repository'
git init -q --bare "$ORIGIN"
git -C "$SEED" remote add origin "$ORIGIN"
git -C "$SEED" push -q -u origin main
git -C "$ORIGIN" symbolic-ref HEAD refs/heads/main

cat > "$SHIM/systemctl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'systemctl %s\n' "$*" >> "${MOCK_STATE:?}/shim.calls"
case "${2:-}" in
  is-system-running) exit 0 ;;
  is-active)
    unit="${4:-${3:-}}"
    [[ -f "${MOCK_STATE:?}/active.$unit" ]]
    ;;
  *) exit 2 ;;
esac
EOF

cat > "$SHIM/systemd-run" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
state="${MOCK_STATE:?}"
unit=unknown
workdir=
args=("$@")
for ((index = 0; index < ${#args[@]}; index += 1)); do
  case "${args[$index]}" in
    --unit) unit="${args[$((index + 1))]}" ;;
    --working-directory) workdir="${args[$((index + 1))]}" ;;
  esac
done
{
  printf '%s\n' 'CALL'
  printf '%s\n' "${args[@]}"
} >> "$state/systemd.$unit.args"
printf 'systemd-run %s\n' "$unit" >> "$state/shim.calls"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --setenv)
      export "$2"
      shift 2
      ;;
    --unit|--working-directory|--property)
      shift 2
      ;;
    --user|--collect|--quiet)
      shift
      ;;
    /bin/bash)
      break
      ;;
    *)
      printf 'unexpected systemd-run argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done
[[ -n "$workdir" ]]
set +e
(cd "$workdir" && "$@")
payload_status=$?
set -e
printf 'payload-exit=%s\n' "$payload_status" >> "$state/systemd.$unit.args"
# A real detached systemd-run reports unit acceptance, not the later payload
# status. The wrapper's durable exit file carries that status instead.
exit 0
EOF

cat > "$SHIM/codex" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
state="${MOCK_STATE:?}"
printf 'codex\n' >> "$state/shim.calls"
printf '%s\n' "$@" > "$state/codex.last.args"
mode="$(cat "$state/mode")"
branch="$(git branch --show-current)"
evidence="$(cat "$state/evidence-dir")"
report="$evidence/$branch.report.md"

case "$mode" in
  happy)
    printf 'lane=%s\n' "$branch" > lane-change.txt
    git add lane-change.txt
    git commit -qm '[CODER] produce lane evidence'
    sha="$(git rev-parse HEAD)"
    {
      printf 'MANIFEST test-lane=%s\n' "$branch"
      printf 'commit: %s [CODER] produce lane evidence\n' "$sha"
      printf 'verify: test -f lane-change.txt\n'
      printf 'result: clean\n'
      printf 'secret-scan: clean\n'
      printf 'remaining: none\n'
    } > "$report"
    ;;
  missing)
    ;;
  stdout)
    sha="$(git rev-parse HEAD)"
    printf 'commit: %s stdout-only\n' "$sha"
    printf 'verify: true\n'
    printf 'result: clean\n'
    printf 'secret-scan: clean\n'
    printf 'remaining: none\n'
    ;;
  crash)
    exit 7
    ;;
  push)
    set +e
    git push origin "$branch"
    push_status=$?
    set -e
    printf '%s\n' "$push_status" > "$state/push.status"
    ;;
  *)
    printf 'unknown mock mode: %s\n' "$mode" >&2
    exit 99
    ;;
esac
EOF

cat > "$SCRATCH/preflight.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ "${1:-}" == codex ]]
EOF

printf '{}\n' > "$HOME_DIR/.codex/auth.json"
chmod +x "$SHIM/systemctl" "$SHIM/systemd-run" "$SHIM/codex" "$SCRATCH/preflight.sh"
printf '%s\n' "$EVIDENCE" > "$STATE/evidence-dir"

export PATH="$SHIM:$PATH"
export HOME="$HOME_DIR"
export MOCK_STATE="$STATE"
export ORCH_AUTH_PREFLIGHT="$SCRATCH/preflight.sh"
export ORCH_EVIDENCE_DIR="$EVIDENCE"
export ORCH_LANES_DIR="$LANES"
export ORCH_LANE_POLL_SECONDS=0.01
unset OPENAI_API_KEY ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
unset ORCH_MODEL ORCH_CODEX_MODEL ORCH_CODEX_REASONING_EFFORT

LAUNCHER="$SEED/orchestrator/launch-codex-lane.sh"
WAITER="$SEED/orchestrator/wait-lane-report.sh"
DISPATCH="$SEED/orchestrator/dispatch-lane.sh"
COMPLETION_GUARD="$SEED/gate/completion-guard.ts"
LAND="$SEED/gate/land.sh"
BREAK_ROW="${ORCH_TEST_BREAK_ROW:-}"

compose_prompt() {
  local lane="$1"
  local prompt="$EVIDENCE/$lane.prompt.md"
  bun "$SEED/tools/instructions/compose.ts" \
    --role coder \
    --tags orchestrator \
    --repo "$SEED" > "$prompt"
  printf '\nMission epilogue for hermetic lane %s.\n' "$lane" >> "$prompt"
  printf '%s\n' "$prompt"
}

dispatch_lane() {
  local lane="$1" prompt="$2"
  shift 2
  "$DISPATCH" "$prompt" -- "$LAUNCHER" --lane "$lane" "$@"
}

set_mode() {
  printf '%s\n' "$1" > "$STATE/mode"
}

shim_call_count() {
  wc -l < "$STATE/shim.calls" 2>/dev/null || printf '0\n'
}

systemd_call_count() {
  local unit="$1"
  grep -c '^CALL$' "$STATE/systemd.$unit.args" 2>/dev/null || true
}

# 1. Happy path: dispatch, bounded unit, file verdict, guard, and real landing.
ROW=1
prompt="$(compose_prompt t1)"
set_mode happy
dispatch_lane t1 "$prompt" --timeout-sec 23 > "$STATE/row1.dispatch"
args="$STATE/systemd.bpa-lane-t1.args"
grep -Fxq -- '--user' "$args" || fail 'missing --user'
grep -Fxq -- '--collect' "$args" || fail 'missing --collect'
grep -Fxq -- '--quiet' "$args" || fail 'missing --quiet'
grep -Fxq -- '--unit' "$args" || fail 'missing --unit'
grep -Fxq -- 'bpa-lane-t1' "$args" || fail 'wrong unit'
grep -Fxq -- '--working-directory' "$args" || fail 'missing --working-directory'
grep -Fxq -- "$LANES/t1" "$args" || fail 'wrong working directory'
grep -Fxq -- '--property' "$args" || fail 'missing --property'
grep -Fxq -- 'RuntimeMaxSec=23' "$args" || fail 'missing RuntimeMaxSec'
grep -Fxq -- '--model' "$STATE/codex.last.args" || fail 'codex model flag absent'
grep -Fxq -- 'gpt-5.6-sol' "$STATE/codex.last.args" || fail 'codex model pin absent'
grep -Fxq -- '--dangerously-bypass-approvals-and-sandbox' "$STATE/codex.last.args" ||
  fail 'codex bypass flag absent'
if grep -Eq 'notify=|hooks[.]SessionStart=' "$STATE/codex.last.args"; then
  fail 'lane codex argv contains an orchestrator hook'
fi
[[ "$(git -C "$LANES/t1" merge-base ag-t1 origin/main)" == "$(git -C "$SEED" rev-parse origin/main)" ]] ||
  fail 'lane was not based on local origin/main'
[[ ! -L "$EVIDENCE/ag-t1.codex-home/auth.json" ]] || fail 'lane auth must be copied, not linked'
grep -Fq "[projects.\"$LANES/t1\"]" "$EVIDENCE/ag-t1.codex-home/config.toml" ||
  fail 'lane worktree trust entry absent'
"$WAITER" --report "$EVIDENCE/ag-t1.report.md" \
  --exit-file "$EVIDENCE/ag-t1.exit" --deadline-sec 2 --poll-sec 0.01
bun "$COMPLETION_GUARD" --report "$EVIDENCE/ag-t1.report.md" \
  --repo "$SEED" --branch ag-t1
# In a no-push test landing, prevent Git's upstream-specific branch deletion
# warning from overriding the fact that land.sh has merged the branch into HEAD.
git -C "$SEED" branch --unset-upstream ag-t1
"$LAND" --branch ag-t1 --report "$EVIDENCE/ag-t1.report.md" \
  --repo "$SEED" --worktree "$LANES/t1" --no-push > "$STATE/row1.land"
grep -q 'LAND verdict=landed' "$STATE/row1.land" || fail 'real land did not land'
pass 'happy-path'

# 2. Missing marker: exact dispatch refusal and no launcher-side shim activity.
ROW=2
hand_prompt="$EVIDENCE/t2.prompt.md"
printf 'hand assembled prompt without a compose pack\n' > "$hand_prompt"
calls_before="$(shim_call_count)"
set_mode missing
if [[ "$BREAK_ROW" == 2 ]]; then
  row2_command=("$LAUNCHER" --lane t2 "$hand_prompt")
else
  row2_command=("$DISPATCH" "$hand_prompt" -- "$LAUNCHER" --lane t2)
fi
expect_status 3 "${row2_command[@]}" > "$STATE/row2.out" 2>&1
[[ "$(shim_call_count)" == "$calls_before" ]] || fail 'launcher shim was invoked'
[[ ! -e "$LANES/t2" ]] || fail 'missing-marker dispatch created a worktree'
git -C "$SEED" show-ref --verify --quiet refs/heads/ag-t2 &&
  fail 'missing-marker dispatch created a branch'
pass 'missing-marker-refusal'

# 3. Missing report: successful process exit is never a clean verdict.
ROW=3
prompt="$(compose_prompt t3)"
set_mode missing
dispatch_lane t3 "$prompt" > "$STATE/row3.dispatch"
[[ -f "$EVIDENCE/ag-t3.exit" ]] || fail 'exit file absent'
[[ ! -e "$EVIDENCE/ag-t3.report.md" ]] || fail 'unexpected report exists'
if [[ "$BREAK_ROW" == 3 ]]; then
  printf 'commit: broken\nverify: true\nresult: clean\nsecret-scan: clean\nremaining: none\n' \
    > "$EVIDENCE/ag-t3.report.md"
fi
expect_status 3 "$WAITER" --report "$EVIDENCE/ag-t3.report.md" \
  --exit-file "$EVIDENCE/ag-t3.exit" --deadline-sec 2 --poll-sec 0.01 \
  > "$STATE/row3.wait" 2>&1
expect_status 2 bun "$COMPLETION_GUARD" --report "$EVIDENCE/ag-t3.report.md" \
  --repo "$SEED" --branch ag-t3 > "$STATE/row3.guard" 2>&1
pass 'missing-report-no-go'

# 4. Stdout is diagnostic log data, never the report channel.
ROW=4
prompt="$(compose_prompt t4)"
set_mode stdout
dispatch_lane t4 "$prompt" > "$STATE/row4.dispatch"
grep -q '^result: clean$' "$EVIDENCE/ag-t4.codex.log" || fail 'stdout fixture did not reach log'
[[ ! -e "$EVIDENCE/ag-t4.report.md" ]] || fail 'stdout was reshaped into a report'
if [[ "$BREAK_ROW" == 4 ]]; then
  cp "$EVIDENCE/ag-t4.codex.log" "$EVIDENCE/ag-t4.report.md"
fi
expect_status 3 "$WAITER" --report "$EVIDENCE/ag-t4.report.md" \
  --exit-file "$EVIDENCE/ag-t4.exit" --deadline-sec 2 --poll-sec 0.01 \
  > "$STATE/row4.wait" 2>&1
pass 'stdout-not-verdict-channel'

# 5. Model precedence: provider override, legacy override, then source pin.
ROW=5
prompt="$EVIDENCE/t5.prompt.md"
printf 'dry-run prompt\n' > "$prompt"
ORCH_CODEX_MODEL='model-provider' ORCH_MODEL='model-legacy' \
  "$LAUNCHER" --lane m-provider --dry-run "$prompt" > "$STATE/model.provider"
grep -Eq -- '--model model-provider( |$)' "$STATE/model.provider" || fail 'provider model did not win'
ORCH_MODEL='model-legacy' "$LAUNCHER" --lane m-legacy --dry-run "$prompt" > "$STATE/model.legacy"
grep -Eq -- '--model model-legacy( |$)' "$STATE/model.legacy" || fail 'legacy model did not win'
env -u ORCH_CODEX_MODEL -u ORCH_MODEL \
  "$LAUNCHER" --lane m-pin --dry-run "$prompt" > "$STATE/model.pin"
grep -Eq -- '--model gpt-5.6-sol( |$)' "$STATE/model.pin" || fail 'source model pin absent'
pass 'model-precedence'

# 6. Fenced retry: exact refusal, no new unit, original evidence unchanged.
ROW=6
prompt="$(compose_prompt t6)"
set_mode happy
dispatch_lane t6 "$prompt" > "$STATE/row6.first"
cp "$EVIDENCE/ag-t6.report.md" "$STATE/row6.report.before"
calls_before="$(systemd_call_count bpa-lane-t6)"
if [[ "$BREAK_ROW" == 6 ]]; then
  git -C "$SEED" worktree remove --force "$LANES/t6"
  git -C "$SEED" branch -D ag-t6 >/dev/null
  rm -f "$EVIDENCE/ag-t6.report.md"
fi
expect_status 2 dispatch_lane t6 "$prompt" > "$STATE/row6.second" 2>&1
cmp -s "$STATE/row6.report.before" "$EVIDENCE/ag-t6.report.md" ||
  fail 'retry changed original report bytes'
[[ "$(systemd_call_count bpa-lane-t6)" == "$calls_before" ]] ||
  fail 'retry invoked another unit'
pass 'fenced-retry'

# 7. Crash path: nonzero codex status is durable and still lacks a verdict.
ROW=7
prompt="$(compose_prompt t7)"
set_mode crash
dispatch_lane t7 "$prompt" > "$STATE/row7.dispatch"
grep -Eq '^exit=7 ts=' "$EVIDENCE/ag-t7.exit" || fail 'crash status not recorded'
expect_status 3 "$WAITER" --report "$EVIDENCE/ag-t7.report.md" \
  --exit-file "$EVIDENCE/ag-t7.exit" --deadline-sec 2 --poll-sec 0.01 \
  > "$STATE/row7.wait" 2>&1
pass 'crash-path'

# 8. Timeout property and bounded polling, with a source-level no-timer lock.
ROW=8
prompt="$(compose_prompt t8)"
set_mode missing
dispatch_lane t8 "$prompt" --timeout-sec 19 > "$STATE/row8.dispatch"
grep -Fxq -- 'RuntimeMaxSec=19' "$STATE/systemd.bpa-lane-t8.args" ||
  fail 'timeout did not become RuntimeMaxSec'
expect_status 4 "$WAITER" --report "$EVIDENCE/never.report.md" \
  --exit-file "$EVIDENCE/never.exit" --deadline-sec 0 --poll-sec 0.01 \
  > "$STATE/row8.wait" 2>&1
if sed '/^[[:space:]]*#/d' "$LAUNCHER" "$WAITER" |
  grep -E '\.timer|--on-active|--on-calendar|watchdog' > "$STATE/row8.forbidden"; then
  fail 'timer or watchdog invocation found'
fi
pass 'timeout-and-no-timer'

# 9. Concurrent provisioning uses the common-repository lock.
ROW=9
prompt_c1="$(compose_prompt c1)"
prompt_c2="$(compose_prompt c2)"
set_mode missing
set +e
dispatch_lane c1 "$prompt_c1" > "$STATE/c1.out" 2>&1 &
pid_c1=$!
dispatch_lane c2 "$prompt_c2" > "$STATE/c2.out" 2>&1 &
pid_c2=$!
wait "$pid_c1"
status_c1=$?
wait "$pid_c2"
status_c2=$?
set -e
for status in "$status_c1" "$status_c2"; do
  [[ "$status" == 0 || "$status" == 2 ]] || fail "concurrent provisioning status=$status"
done
[[ "$status_c1" == 0 || "$status_c2" == 0 ]] || fail 'both concurrent launches refused'
for lane in c1 c2; do
  if [[ -e "$LANES/$lane" ]]; then
    [[ "$(git -C "$LANES/$lane" branch --show-current)" == "ag-$lane" ]] ||
      fail "wrong concurrent branch lane=$lane"
    [[ -z "$(git -C "$LANES/$lane" status --porcelain)" ]] ||
      fail "dirty concurrent worktree lane=$lane"
  fi
done
git -C "$SEED" worktree list --porcelain > "$STATE/row9.worktrees"
pass 'concurrent-provisioning'

# 10. The exact injected Git config mechanically blocks an origin push.
ROW=10
prompt="$(compose_prompt t10)"
set_mode push
dispatch_lane t10 "$prompt" > "$STATE/row10.dispatch"
[[ -s "$STATE/push.status" ]] || fail 'push attempt status absent'
[[ "$(cat "$STATE/push.status")" != 0 ]] || fail 'origin push unexpectedly succeeded'
git -C "$ORIGIN" show-ref --verify --quiet refs/heads/ag-t10 &&
  fail 'origin received fenced lane branch'
grep -Fxq -- 'GIT_CONFIG_COUNT=1' "$STATE/systemd.bpa-lane-t10.args" ||
  fail 'GIT_CONFIG_COUNT fence absent'
grep -Fxq -- 'GIT_CONFIG_KEY_0=remote.origin.pushurl' "$STATE/systemd.bpa-lane-t10.args" ||
  fail 'pushurl key fence absent'
grep -Fxq -- 'GIT_CONFIG_VALUE_0=file:///dev/null/push-disabled' "$STATE/systemd.bpa-lane-t10.args" ||
  fail 'pushurl sentinel fence absent'
pass 'origin-push-fence'

printf 'launch-codex-lane tests: PASS (10 rows)\n'
