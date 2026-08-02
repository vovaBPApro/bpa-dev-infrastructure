#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NEW_SCRIPT="$ROOT/tools/orchestrator/dispatch-agent.sh"

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"; rm -f /tmp/ag-survive-old.log /tmp/ag-survive-new.log' EXIT
OLD_SCRIPT="$tmpdir/dispatch-agent-legacy.sh"

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

git_cfg() {
  git -C "$1" config user.email "dispatch-survive-test@example.test"
  git -C "$1" config user.name "Dispatch Survive Test"
}

make_repo() {
  local repo="$1"
  git init -q "$repo"
  git_cfg "$repo"
  git -C "$repo" checkout -q -b dev
  printf 'init\n' > "$repo/README.md"
  git -C "$repo" add README.md
  git -C "$repo" commit -q -m "init"
}

write_codex_stub() {
  local bin_dir="$1"
  cat > "$bin_dir/codex" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [ -n "${FAKE_CGROUP_PIDS_FILE:-}" ]; then
  printf '%s\n' "$$" >> "$FAKE_CGROUP_PIDS_FILE"
fi
printf 'OpenAI Codex v0.142.4\n'
printf 'provider: openai\n'
printf 'session id: survives-test\n'
sleep 3
printf 'done\n' > "${FAKE_LANE_DONE_PATH:?}"
exit 0
EOF
  chmod +x "$bin_dir/codex"
}

write_systemd_stubs() {
  local bin_dir="$1" state_dir="$2"

  cat > "$bin_dir/systemd-run" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
state_dir="${FAKE_SYSTEMD_STATE:?}"
unit=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --unit=*)
      unit="${1#--unit=}"
      shift
      ;;
    --user|--collect|--same-dir|--property=*)
      shift
      ;;
    *)
      break
      ;;
  esac
done
mkdir -p "$state_dir/units/$unit"
printf '%s\n' "$*" > "$state_dir/units/$unit/argv"
command="$(printf '%q ' "$@")"
(
  env -i \
    PATH="$PATH" \
    HOME="${HOME:-}" \
    USER="${USER:-}" \
    CODEX_HOME="${CODEX_HOME:-}" \
    CODEX_HOME_SHARED="${CODEX_HOME_SHARED:-}" \
    FAKE_LANE_DONE_PATH="${FAKE_LANE_DONE_PATH:-}" \
    FAKE_SYSTEMD_STATE="$state_dir" \
    bash -lc "$command"
) &
pid=$!
printf '%s\n' "$pid" > "$state_dir/units/$unit/pid"
exit 0
EOF
  chmod +x "$bin_dir/systemd-run"

  cat > "$bin_dir/systemctl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
state_dir="${FAKE_SYSTEMD_STATE:?}"
cmd="${1:-}"
shift || true
case "$cmd" in
  --user)
    cmd="${1:-}"
    shift || true
    ;;
esac
case "$cmd" in
  is-active)
    unit="$1"
    pid="$(cat "$state_dir/units/$unit/pid" 2>/dev/null || true)"
    [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
    ;;
  kill|stop)
    unit="$1"
    pid="$(cat "$state_dir/units/$unit/pid" 2>/dev/null || true)"
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
    ;;
  *)
    exit 1
    ;;
esac
EOF
  chmod +x "$bin_dir/systemctl"
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
LOG="/tmp/ag-$NAME.log"

git worktree remove --force "$WT" 2>/dev/null || true
git branch -D "$BR" 2>/dev/null || true
git worktree prune 2>/dev/null || true
git worktree add -b "$BR" "$WT" "$BASE" >/dev/null 2>&1 || exit 1

CMD="codex exec --ephemeral --model \"$MODEL\" --dangerously-bypass-approvals-and-sandbox -C \"$WT\" \"$(cat "$PROMPT")\" </dev/null"

legacy_run_agent() {
  cd "$WT" || exit 1
  eval "$CMD" >> "$LOG" 2>&1
}

systemd-run \
  --user \
  --unit="bpa-lane-$NAME" \
  --collect \
  --same-dir \
  --property=KillMode=mixed \
  bash -lc 'legacy_run_agent' \
  >> "$LOG" 2>&1
exit 0
EOF
  chmod +x "$OLD_SCRIPT"
}

run_dispatch() {
  local script="$1" repo="$2" bin_dir="$3" codex_home="$4" prompt="$5" name="$6" done_path="$7" cgroup_pids="$8" mode="$9"
  shift 9
  (
    cd "$repo"
    env \
      PATH="$bin_dir:$PATH" \
      CODEX_HOME_SHARED="$codex_home" \
      ORCH_SKIP_DOCKER_REAP=1 \
      DISPATCH_LANE_DETACH_MODE="$mode" \
      DISPATCH_SPAWN_CONFIRM_TIMEOUT=6 \
      DISPATCH_SPAWN_CONFIRM_POLL_INTERVAL=1 \
      FAKE_LANE_DONE_PATH="$done_path" \
      FAKE_CGROUP_PIDS_FILE="$cgroup_pids" \
      "$script" --provider codex --name "$name" --base dev --prompt "$prompt" --model good-marker "$@"
  )
}

kill_fake_cgroup() {
  local pids_path="$1"
  [ -f "$pids_path" ] || return 0
  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    kill "$pid" 2>/dev/null || true
  done < "$pids_path"
}

wait_for_path() {
  local path="$1" label="$2"
  local attempt
  for attempt in $(seq 1 10); do
    [ -f "$path" ] && return 0
    sleep 1
  done
  fail "$label" "timed out waiting for $path"
}

fixture_dir="$tmpdir/fixture"
mkdir -p "$fixture_dir/bin" "$fixture_dir/codex-home" "$fixture_dir/systemd-state"
printf '{}\n' > "$fixture_dir/codex-home/auth.json"
printf 'Prompt.\n' > "$fixture_dir/prompt.md"
make_repo "$fixture_dir/repo"
write_codex_stub "$fixture_dir/bin"
write_systemd_stubs "$fixture_dir/bin" "$fixture_dir/systemd-state"
write_legacy_dispatch_script

old_done="$fixture_dir/old.done"
old_cgroup="$fixture_dir/old.cgroup"
(
  export FAKE_SYSTEMD_STATE="$fixture_dir/systemd-state"
  run_dispatch "$OLD_SCRIPT" "$fixture_dir/repo" "$fixture_dir/bin" "$fixture_dir/codex-home" "$fixture_dir/prompt.md" "survive-old" "$old_done" "$old_cgroup" always
) >/tmp/dispatch-survive-old.stdout 2>&1
sleep 2
[ ! -f "$old_done" ] || fail "RED-before fresh shell rejects bare function payload" "legacy lane unexpectedly completed"
assert_contains "$(cat /tmp/ag-survive-old.log)" "legacy_run_agent: command not found" "RED-before legacy systemd payload fails in fresh shell"
pass "RED-before: fresh-shell systemd detach rejects bare function payload"

new_done="$fixture_dir/new.done"
new_cgroup="$fixture_dir/new.cgroup"
(
  export FAKE_SYSTEMD_STATE="$fixture_dir/systemd-state"
  run_dispatch "$NEW_SCRIPT" "$fixture_dir/repo" "$fixture_dir/bin" "$fixture_dir/codex-home" "$fixture_dir/prompt.md" "survive-new" "$new_done" "$new_cgroup" always
) >/tmp/dispatch-survive-new.stdout 2>&1
kill_fake_cgroup "$new_cgroup"
wait_for_path "$new_done" "GREEN-after detached lane survives dispatcher death"
assert_contains "$(cat /tmp/ag-survive-new.log)" "lane-detach=systemd-run unit=bpa-lane-survive-new" "systemd path used"
pass "GREEN-after: detached lane reaches terminal state after dispatcher death"

echo "lane-survives-dispatcher-death test passed"
