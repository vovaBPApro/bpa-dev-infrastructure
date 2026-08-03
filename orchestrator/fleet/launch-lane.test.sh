#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"
SCRATCH="$(mktemp -d)"
chmod 700 "$SCRATCH"
REPO_DIR="$SCRATCH/repo"
RUN_TOKEN="${SCRATCH##*/}"
REF_PREFIX="meteorite-candidates/fleet-launch-$RUN_TOKEN"
case "$REF_PREFIX" in
  *"$RUN_TOKEN"*) ;;
  *)
    printf 'fixture ref prefix is not unique to this run: %s\n' "$REF_PREFIX" >&2
    exit 1
    ;;
esac
cleanup() {
  for lane in proof race retry valid invalid crashed; do
    git -C "$REPO_DIR" worktree remove --force "$SCRATCH/lanes/$lane" >/dev/null 2>&1 || true
    git -C "$REPO_DIR" branch -D "$REF_PREFIX-$lane" >/dev/null 2>&1 || true
  done
  rm -rf "$SCRATCH"
}
trap cleanup EXIT
mkdir -p "$SCRATCH/bin" "$SCRATCH/lanes"

# launch-lane creates and removes Git refs as part of its contract. Keep those
# refs in a disposable repository: even unique-looking branch names are not a
# safe namespace when two copies of this test run at once.
git clone --quiet --local --no-hardlinks "$SOURCE_REPO" "$REPO_DIR"

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

PATH="$SCRATCH/bin:$PATH" AGENT_COMMAND_FILE="$SCRATCH/agent.conf" \
  MOCK_SYSTEMD_ARGS="$SCRATCH/systemd.args" MOCK_AGENT_ARGS="$SCRATCH/agent.args" \
  MOCK_AGENT_EXECUTED="$SCRATCH/agent.executed" TMPDIR="$SCRATCH/tmp-parent" \
  "$SCRIPT_DIR/launch-lane.sh" --name proof --role coder --task-file "$SCRATCH/task.md" \
  --repo "$REPO_DIR" --lanes-dir "$SCRATCH/lanes" --base HEAD --branch "$REF_PREFIX-proof" \
  >"$SCRATCH/output"

grep -Fq 'launched lane-proof' "$SCRATCH/output"
test -f "$SCRATCH/lanes/proof/.git"
grep -Fq '<!-- compose.ts pack v1 role=coder' "$SCRATCH/lanes/lane-proof.prompt.md"
grep -Fq '# Dispatch proof' "$SCRATCH/lanes/lane-proof.prompt.md"
git -C "$SCRATCH/lanes/proof" symbolic-ref --short HEAD | grep -Fxq "$REF_PREFIX-proof"
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
    --repo "$REPO_DIR" --lanes-dir "$SCRATCH/lanes" --base HEAD --branch "$REF_PREFIX-$lane" \
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
  --repo "$REPO_DIR" --lanes-dir "$SCRATCH/lanes" --base HEAD --branch "$REF_PREFIX-proof" \
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
    --repo "$REPO_DIR" --lanes-dir "$SCRATCH/lanes" --base HEAD --branch "$REF_PREFIX-race" \
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
  --repo "$REPO_DIR" --lanes-dir "$SCRATCH/lanes" --base HEAD --branch "$REF_PREFIX-retry" \
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
  --repo "$REPO_DIR" --lanes-dir "$SCRATCH/lanes" --base HEAD --branch "$REF_PREFIX-retry" \
  >"$SCRATCH/retry.output"
grep -Fq 'launched lane-retry' "$SCRATCH/retry.output"

printf 'launch-lane dispatch proof: PASS\n'
