#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"
SCRATCH="$(mktemp -d)"
cleanup() {
  rm -rf "$SCRATCH"
}
trap cleanup EXIT
mkdir -p "$SCRATCH/bin" "$SCRATCH/lanes"

# This fixture needs the complete repository because launch-lane composes and
# validates a real instruction pack. It does not need the host repository's
# refs, so keep every fixture worktree and branch inside a disposable clone.
git clone --quiet --no-hardlinks "$HOST_REPO" "$SCRATCH/repo"
REPO_DIR="$SCRATCH/repo"
REAL_GIT="$(command -v git)"
export REAL_GIT HOST_REPO
cat >"$SCRATCH/bin/git" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ " $* " == *" -C $HOST_REPO "* ]]; then
  case " $* " in
    *" branch "*|*" worktree add "*|*" worktree remove "*|*" update-ref "*|*" symbolic-ref "*)
      printf 'fixture attempted host-global git mutation: %s\n' "$*" >&2
      exit 97
      ;;
  esac
fi
exec "$REAL_GIT" "$@"
EOF

cat >"$SCRATCH/task.md" <<'EOF'
# Dispatch proof

Report the current branch.
EOF
cat >"$SCRATCH/bin/custom-agent" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" >"$MOCK_AGENT_ARGS"
touch "$MOCK_AGENT_EXECUTED"
printf 'API_KEY=1234567890abcdef\n'
EOF
cat >"$SCRATCH/agent.conf" <<EOF
$SCRATCH/bin/custom-agent
run-lane
--custom-safety-mode
EOF
cat >"$SCRATCH/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat >"$SCRATCH/bin/systemd-run" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ -n "${MOCK_SYSTEMD_FAIL:-}" ]]; then
  exit 1
fi
printf '%s\n' "$@" >"$MOCK_SYSTEMD_ARGS"
while (($#)); do
  case "$1" in
    --collect) shift ;;
    --unit) shift 2 ;;
    --setenv=*) export "${1#--setenv=}"; shift ;;
    --working-directory=*) cd "${1#--working-directory=}"; shift ;;
    --property=*) shift ;;
    *) break ;;
  esac
done
"$@" || true
exit 0
EOF
chmod +x "$SCRATCH/bin/"*

# Red proof for the isolation guard: a fixture command aimed at a host-global
# ref must be rejected before git can create it.
if PATH="$SCRATCH/bin:$PATH" git -C "$HOST_REPO" update-ref \
  refs/heads/ag-fixture-isolation-red-proof HEAD \
  >"$SCRATCH/host-global.output" 2>"$SCRATCH/host-global.error"; then
  printf 'host-global fixture mutation escaped isolation guard\n' >&2
  exit 1
fi
grep -Fq 'fixture attempted host-global git mutation:' "$SCRATCH/host-global.error"
if "$REAL_GIT" -C "$HOST_REPO" show-ref --verify --quiet \
  refs/heads/ag-fixture-isolation-red-proof; then
  printf 'isolation red proof created a host-global ref\n' >&2
  exit 1
fi

PATH="$SCRATCH/bin:$PATH" AGENT_COMMAND_FILE="$SCRATCH/agent.conf" \
  MOCK_SYSTEMD_ARGS="$SCRATCH/systemd.args" MOCK_AGENT_ARGS="$SCRATCH/agent.args" \
  MOCK_AGENT_EXECUTED="$SCRATCH/agent.executed" TMPDIR="$SCRATCH/tmp-parent" \
  "$SCRIPT_DIR/launch-lane.sh" --name proof --role coder --task-file "$SCRATCH/task.md" \
  --repo "$REPO_DIR" --lanes-dir "$SCRATCH/lanes" --base HEAD --branch ag-fleet-launch-proof \
  >"$SCRATCH/output"

grep -Fq 'launched lane-proof' "$SCRATCH/output"
test -f "$SCRATCH/lanes/proof/.git"
grep -Fq '<!-- compose.ts pack v1 role=coder' "$SCRATCH/lanes/lane-proof.prompt.md"
grep -Fq '# Dispatch proof' "$SCRATCH/lanes/lane-proof.prompt.md"
git -C "$SCRATCH/lanes/proof" symbolic-ref --short HEAD | grep -Fxq ag-fleet-launch-proof
grep -Fxq -- '--property=IPAddressDeny=localhost' "$SCRATCH/systemd.args"
grep -Fq 'daemon/mask-stream.ts' "$SCRATCH/systemd.args"
grep -Fq "TMPDIR=$SCRATCH/tmp-parent/infra-lane-tmp-$UID/proof" "$SCRATCH/systemd.args"
grep -Fq "LANE_REPORT_PATH=$SCRATCH/lanes/proof.report.md" "$SCRATCH/systemd.args"
test -f "$SCRATCH/agent.executed"
grep -Fxq 'run-lane' "$SCRATCH/agent.args"
grep -Fxq -- '--custom-safety-mode' "$SCRATCH/agent.args"
if grep -Fq '1234567890abcdef' "$SCRATCH/lanes/lane-proof.log"; then
  printf 'lane log retained an unmasked agent secret\n' >&2
  exit 1
fi
grep -Fq 'API_KEY=' "$SCRATCH/lanes/lane-proof.log"
grep -Fxq 'state: failed' "$SCRATCH/lanes/lane-proof.status"
grep -Fxq 'reason: report-invalid' "$SCRATCH/lanes/lane-proof.status"
grep -Fxq "report: $SCRATCH/lanes/proof.report.md" "$SCRATCH/lanes/lane-proof.status"

# The unit wrapper, not the payload, decides terminal state from the declared report.
cat >"$SCRATCH/bin/report-agent" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
mode=$1
if [[ "$mode" == crash ]]; then exit 17; fi
sha=$(git rev-parse HEAD)
{
  printf 'commit: %s fixture\n' "$sha"
  printf 'verify: true\nresult: clean\nsecret-scan: clean\nremaining: none\n'
  if [[ "$mode" == invalid ]]; then printf 'review: claimed\n'; fi
} >"$LANE_REPORT_PATH"
EOF
chmod +x "$SCRATCH/bin/report-agent"
for mode in valid invalid crash; do
  lane="${mode/crash/crashed}"
  printf '%s\n%s\n' "$SCRATCH/bin/report-agent" "$mode" >"$SCRATCH/$mode.conf"
  # A real landing exports BUN_BIN before this fixture runs. Keep it set here
  # to lock the nested-gate boundary: lane-exit must still execute the guard.
  PATH="$SCRATCH/bin:$PATH" BUN_BIN="$(command -v bun)" AGENT_COMMAND_FILE="$SCRATCH/$mode.conf" \
    MOCK_SYSTEMD_ARGS="$SCRATCH/$mode.systemd.args" TMPDIR="$SCRATCH/tmp-parent" \
    "$SCRIPT_DIR/launch-lane.sh" --name "$lane" --role coder --task-file "$SCRATCH/task.md" \
    --repo "$REPO_DIR" --lanes-dir "$SCRATCH/lanes" --base HEAD --branch "ag-fleet-launch-$lane" \
    >"$SCRATCH/$mode.output"
done
grep -Fxq 'state: terminal' "$SCRATCH/lanes/lane-valid.status" || { cat "$SCRATCH/lanes/lane-valid.status" "$SCRATCH/lanes/lane-valid.log" >&2; exit 1; }
grep -Fxq 'reason: report-valid' "$SCRATCH/lanes/lane-valid.status"
grep -Fxq 'state: failed' "$SCRATCH/lanes/lane-invalid.status"
grep -Fxq 'reason: report-invalid' "$SCRATCH/lanes/lane-invalid.status"
grep -Fq 'missing file=' "$SCRATCH/lanes/lane-invalid.log"
grep -Fxq 'state: failed' "$SCRATCH/lanes/lane-crashed.status"
grep -Fxq 'reason: payload-exit' "$SCRATCH/lanes/lane-crashed.status"
grep -Fxq 'exit: 17' "$SCRATCH/lanes/lane-crashed.status"

# Existing-name lock: the launcher must refuse before composition or unit use.
rm -f "$SCRATCH/systemd.args" "$SCRATCH/agent.executed"
if PATH="$SCRATCH/bin:$PATH" AGENT_COMMAND_FILE="$SCRATCH/agent.conf" \
  MOCK_SYSTEMD_ARGS="$SCRATCH/systemd.args" MOCK_AGENT_ARGS="$SCRATCH/agent.args" \
  MOCK_AGENT_EXECUTED="$SCRATCH/agent.executed" TMPDIR="$SCRATCH/tmp-parent" \
  "$SCRIPT_DIR/launch-lane.sh" --name proof --role coder --task-file "$SCRATCH/task.md" \
  --repo "$REPO_DIR" --lanes-dir "$SCRATCH/lanes" --base HEAD --branch ag-fleet-launch-proof \
  >"$SCRATCH/reused.output" 2>"$SCRATCH/reused.error"; then
  printf 'launcher reused an existing lane name\n' >&2
  exit 1
fi
grep -Eq "lane artifacts already exist for proof|lane artifact already exists for proof: $SCRATCH/lanes/proof" \
  "$SCRATCH/reused.error"
test ! -e "$SCRATCH/systemd.args"
test ! -e "$SCRATCH/agent.executed"

# Atomic-name lock: concurrent launchers get exactly one winner.
race_success=0
race_failure=0
for contender in 1 2; do
  PATH="$SCRATCH/bin:$PATH" AGENT_COMMAND_FILE="$SCRATCH/agent.conf" \
    MOCK_SYSTEMD_ARGS="$SCRATCH/race-$contender.systemd.args" \
    MOCK_AGENT_ARGS="$SCRATCH/race-$contender.agent.args" \
    MOCK_AGENT_EXECUTED="$SCRATCH/race-$contender.agent.executed" \
    TMPDIR="$SCRATCH/tmp-parent" \
    "$SCRIPT_DIR/launch-lane.sh" --name race --role coder --task-file "$SCRATCH/task.md" \
    --repo "$REPO_DIR" --lanes-dir "$SCRATCH/lanes" --base HEAD --branch ag-fleet-launch-race \
    >"$SCRATCH/race-$contender.output" 2>"$SCRATCH/race-$contender.error" &
  eval "race_pid_$contender=$!"
done
for contender in 1 2; do
  pid_var="race_pid_$contender"
  if wait "${!pid_var}"; then
    race_success=$((race_success + 1))
  else
    race_failure=$((race_failure + 1))
    grep -Fq "lane artifact already exists for race: $SCRATCH/lanes/pack-race" \
      "$SCRATCH/race-$contender.error"
  fi
done
[[ "$race_success" -eq 1 && "$race_failure" -eq 1 ]]
test -f "$SCRATCH/lanes/race/.git"
test -f "$SCRATCH/lanes/pack-race/preamble.md"
test -f "$SCRATCH/lanes/lane-race.prompt.md"
[[ "$(find "$SCRATCH" -name 'race-*.agent.executed' -type f | wc -l)" -eq 1 ]]

# Every artifact location rejects dangling symlinks as an existing claim.
for artifact_kind in worktree pack prompt log report status tmp; do
  lane="dangling-$artifact_kind"
  case "$artifact_kind" in
    worktree) artifact="$SCRATCH/lanes/$lane" ;;
    pack) artifact="$SCRATCH/lanes/pack-$lane" ;;
    prompt) artifact="$SCRATCH/lanes/lane-$lane.prompt.md" ;;
    log) artifact="$SCRATCH/lanes/lane-$lane.log" ;;
    report) artifact="$SCRATCH/lanes/$lane.report.md" ;;
    status) artifact="$SCRATCH/lanes/lane-$lane.status" ;;
    tmp) artifact="$SCRATCH/tmp-parent/infra-lane-tmp-$UID/$lane" ;;
  esac
  mkdir -p "$(dirname "$artifact")"
  ln -s "$SCRATCH/does-not-exist" "$artifact"
  if PATH="$SCRATCH/bin:$PATH" AGENT_COMMAND_FILE="$SCRATCH/agent.conf" \
    TMPDIR="$SCRATCH/tmp-parent" \
    "$SCRIPT_DIR/launch-lane.sh" --name "$lane" --role coder --task-file "$SCRATCH/task.md" \
    --repo "$REPO_DIR" --lanes-dir "$SCRATCH/lanes" --base HEAD \
    >"$SCRATCH/$lane.output" 2>"$SCRATCH/$lane.error"; then
    printf 'launcher accepted dangling %s artifact\n' "$artifact_kind" >&2
    exit 1
  fi
  grep -Fq "lane artifact already exists for $lane: $artifact" "$SCRATCH/$lane.error"
  rm "$artifact"
done

# A failed unit start releases the reservation and all artifacts for retry.
if PATH="$SCRATCH/bin:$PATH" AGENT_COMMAND_FILE="$SCRATCH/agent.conf" \
  MOCK_SYSTEMD_FAIL=1 TMPDIR="$SCRATCH/tmp-parent" \
  "$SCRIPT_DIR/launch-lane.sh" --name retry --role coder --task-file "$SCRATCH/task.md" \
  --repo "$REPO_DIR" --lanes-dir "$SCRATCH/lanes" --base HEAD --branch ag-fleet-launch-retry \
  >"$SCRATCH/retry-failed.output" 2>"$SCRATCH/retry-failed.error"; then
  printf 'launcher accepted a failed unit start\n' >&2
  exit 1
fi
grep -Fq 'unit launch failed; cleaned lane artifacts: retry' "$SCRATCH/retry-failed.error"
test ! -e "$SCRATCH/lanes/retry"
test ! -e "$SCRATCH/lanes/pack-retry"
test ! -e "$SCRATCH/lanes/lane-retry.prompt.md"
test ! -e "$SCRATCH/lanes/retry.report.md"
test ! -e "$SCRATCH/lanes/lane-retry.status"
test ! -e "$SCRATCH/tmp-parent/infra-lane-tmp-$UID/retry"
PATH="$SCRATCH/bin:$PATH" AGENT_COMMAND_FILE="$SCRATCH/agent.conf" \
  MOCK_SYSTEMD_ARGS="$SCRATCH/retry.systemd.args" MOCK_AGENT_ARGS="$SCRATCH/retry.agent.args" \
  MOCK_AGENT_EXECUTED="$SCRATCH/retry.agent.executed" TMPDIR="$SCRATCH/tmp-parent" \
  "$SCRIPT_DIR/launch-lane.sh" --name retry --role coder --task-file "$SCRATCH/task.md" \
  --repo "$REPO_DIR" --lanes-dir "$SCRATCH/lanes" --base HEAD --branch ag-fleet-launch-retry \
  >"$SCRATCH/retry.output"
grep -Fq 'launched lane-retry' "$SCRATCH/retry.output"

printf 'launch-lane dispatch proof: PASS\n'
