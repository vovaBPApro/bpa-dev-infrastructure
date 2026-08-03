#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
SCRATCH="$(TMPDIR=/tmp mktemp -d)"
FIXTURE_REPO="$SCRATCH/source"
cleanup() {
  for lane in proof race retry; do
    git -C "$FIXTURE_REPO" worktree remove --force "$SCRATCH/lanes/$lane" >/dev/null 2>&1 || true
    git -C "$FIXTURE_REPO" branch -D "ag-fleet-launch-$lane" >/dev/null 2>&1 || true
  done
  rm -rf "$SCRATCH"
}
trap cleanup EXIT
mkdir -p "$SCRATCH/bin" "$SCRATCH/lanes"
chmod 0755 "$SCRATCH" "$SCRATCH/bin" "$SCRATCH/lanes"
git clone --quiet --no-hardlinks "$REPO_DIR" "$FIXTURE_REPO"
cp "$(command -v bun)" "$SCRATCH/bin/bun"
export BUN_BIN="$SCRATCH/bin/bun"
test_user=nobody
test_group="$(id -gn "$test_user")"
mkdir -p "$SCRATCH/lane-home"
cat >"$SCRATCH/runtime.conf" <<EOF
lane_user=$test_user
lane_group=$test_group
lane_home=$SCRATCH/lane-home
lanes_dir=$SCRATCH/lanes
EOF
export LANE_RUNTIME_CONFIG="$SCRATCH/runtime.conf"

cat >"$SCRATCH/task.md" <<'EOF'
# Dispatch proof

Report the current branch.
EOF
cat >"$SCRATCH/bin/custom-agent" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" >"$MOCK_AGENT_ARGS"
printf 'executed\n' >"$MOCK_AGENT_EXECUTED"
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
requested_uid=""
requested_gid=""
while (($#)); do
  case "$1" in
    --collect) shift ;;
    --unit) shift 2 ;;
    --setenv=*) export "${1#--setenv=}"; shift ;;
    --working-directory=*) cd "${1#--working-directory=}"; shift ;;
    --uid=*) requested_uid="${1#--uid=}"; shift ;;
    --gid=*) requested_gid="${1#--gid=}"; shift ;;
    --property=*) shift ;;
    *) break ;;
  esac
done
exec setpriv --reuid="$requested_uid" --regid="$requested_gid" --clear-groups -- "$@"
EOF
chmod +x "$SCRATCH/bin/"*
touch "$SCRATCH/agent.args" "$SCRATCH/agent.executed" \
  "$SCRATCH/race-1.agent.args" "$SCRATCH/race-1.agent.executed" \
  "$SCRATCH/race-2.agent.args" "$SCRATCH/race-2.agent.executed" \
  "$SCRATCH/retry.agent.args" "$SCRATCH/retry.agent.executed"
chown "$test_user:$test_group" "$SCRATCH/agent.args" "$SCRATCH/agent.executed" \
  "$SCRATCH/"race-*.agent.args "$SCRATCH/"race-*.agent.executed \
  "$SCRATCH/retry.agent.args" "$SCRATCH/retry.agent.executed"

assert_preflight_refusal() {
  local case_name="$1" config="$2" expected="$3"
  if PATH="$SCRATCH/bin:$PATH" AGENT_COMMAND_FILE="$SCRATCH/agent.conf" \
    "$SCRIPT_DIR/launch-lane.sh" --name "preflight-$case_name" --role coder \
    --task-file "$SCRATCH/task.md" --runtime-config "$config" \
    --repo "$FIXTURE_REPO" --lanes-dir "$SCRATCH/lanes-$case_name" --base HEAD \
    >"$SCRATCH/$case_name.output" 2>"$SCRATCH/$case_name.error"; then
    printf 'launcher accepted invalid preflight: %s\n' "$case_name" >&2
    exit 1
  fi
  grep -Fq "$expected" "$SCRATCH/$case_name.error"
  test ! -e "$SCRATCH/lanes-$case_name/preflight-$case_name"
  test ! -e "$SCRATCH/lanes-$case_name/pack-preflight-$case_name"
}

mkdir -p "$SCRATCH/lanes-missing-user" "$SCRATCH/lanes-missing-home" "$SCRATCH/lanes-untraversable"
chmod 0755 "$SCRATCH/lanes-missing-user" "$SCRATCH/lanes-missing-home"
chmod 0700 "$SCRATCH/lanes-untraversable"
cat >"$SCRATCH/missing-user.conf" <<EOF
lane_user=definitely-missing-lane-user
lane_group=$test_group
lane_home=$SCRATCH/lane-home
lanes_dir=$SCRATCH/lanes-missing-user
EOF
cat >"$SCRATCH/missing-home.conf" <<EOF
lane_user=$test_user
lane_group=$test_group
lane_home=$SCRATCH/no-such-home
lanes_dir=$SCRATCH/lanes-missing-home
EOF
cat >"$SCRATCH/untraversable.conf" <<EOF
lane_user=$test_user
lane_group=$test_group
lane_home=$SCRATCH/lane-home
lanes_dir=$SCRATCH/lanes-untraversable
EOF
assert_preflight_refusal missing-user "$SCRATCH/missing-user.conf" 'lane user is missing or privileged'
assert_preflight_refusal missing-home "$SCRATCH/missing-home.conf" 'lane home is missing'
assert_preflight_refusal untraversable "$SCRATCH/untraversable.conf" 'lanes root is not traversable by lane user'

PATH="$SCRATCH/bin:$PATH" AGENT_COMMAND_FILE="$SCRATCH/agent.conf" \
  MOCK_SYSTEMD_ARGS="$SCRATCH/systemd.args" MOCK_AGENT_ARGS="$SCRATCH/agent.args" \
  MOCK_AGENT_EXECUTED="$SCRATCH/agent.executed" TMPDIR="$SCRATCH/tmp-parent" \
  "$SCRIPT_DIR/launch-lane.sh" --name proof --role coder --task-file "$SCRATCH/task.md" \
  --runtime-config "$SCRATCH/runtime.conf" \
  --repo "$FIXTURE_REPO" --lanes-dir "$SCRATCH/lanes" --base HEAD --branch ag-fleet-launch-proof \
  >"$SCRATCH/output"

grep -Fq 'launched lane-proof' "$SCRATCH/output"
test -f "$SCRATCH/lanes/proof/.git"
grep -Fq '<!-- compose.ts pack v1 role=coder' "$SCRATCH/lanes/lane-proof.prompt.md"
grep -Fq '# Dispatch proof' "$SCRATCH/lanes/lane-proof.prompt.md"
git -c safe.directory="$SCRATCH/lanes/proof" -C "$SCRATCH/lanes/proof" symbolic-ref --short HEAD | grep -Fxq ag-fleet-launch-proof
grep -Fxq -- '--property=IPAddressDeny=localhost' "$SCRATCH/systemd.args"
grep -Fxq -- '--property=IPAddressAllow=127.0.0.53' "$SCRATCH/systemd.args"
grep -Fxq -- "--uid=$test_user" "$SCRATCH/systemd.args"
grep -Fxq -- "--gid=$test_group" "$SCRATCH/systemd.args"
[[ "$(id -u "$test_user")" -ne 0 ]]
grep -Fq 'daemon/mask-stream.ts' "$SCRATCH/systemd.args"
grep -Fq "TMPDIR=$SCRATCH/lanes/tmp/proof" "$SCRATCH/systemd.args"
grep -Fq "HOME=$SCRATCH/lane-home" "$SCRATCH/systemd.args"
grep -Fxq -- '--setenv=GIT_CONFIG_COUNT=1' "$SCRATCH/systemd.args"
grep -Fxq -- '--setenv=GIT_CONFIG_KEY_0=safe.directory' "$SCRATCH/systemd.args"
grep -Fxq -- "--setenv=GIT_CONFIG_VALUE_0=$SCRATCH/lanes/proof" "$SCRATCH/systemd.args"
test -f "$SCRATCH/agent.executed"
grep -Fxq 'run-lane' "$SCRATCH/agent.args"
grep -Fxq -- '--custom-safety-mode' "$SCRATCH/agent.args"
if grep -Fq '1234567890abcdef' "$SCRATCH/lanes/lane-proof.log"; then
  printf 'lane log retained an unmasked agent secret\n' >&2
  exit 1
fi
grep -Fq 'API_KEY=' "$SCRATCH/lanes/lane-proof.log"

# The mock must cross the privilege boundary and exercise the Git writes that
# linked-worktree metadata requires. This lock failed before the ownership fix.
stat -c '%u:%g' "$SCRATCH/agent.executed" | grep -Fxq "$(id -u "$test_user"):$(id -g "$test_user")"
setpriv --reuid="$test_user" --regid="$test_group" --clear-groups -- sh -c 'printf "%s\n" proof >"$1/lane-proof.txt"' _ "$SCRATCH/lanes/proof"
setpriv --reuid="$test_user" --regid="$test_group" --clear-groups -- env \
  HOME="$SCRATCH/lane-home" GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory \
  GIT_CONFIG_VALUE_0="$SCRATCH/lanes/proof" \
  git -C "$SCRATCH/lanes/proof" add lane-proof.txt
setpriv --reuid="$test_user" --regid="$test_group" --clear-groups -- env \
  HOME="$SCRATCH/lane-home" GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory \
  GIT_CONFIG_VALUE_0="$SCRATCH/lanes/proof" \
  git -c user.email=lane@example.invalid -c user.name=Lane \
  -C "$SCRATCH/lanes/proof" commit -m 'test: lane can commit' >/dev/null

# Mutual trust is deliberate and executable: the single configured lane uid can
# read and write sibling artifacts; root-owned parent checkout files stay owned
# by root and are not made group-writable by the launcher.
setpriv --reuid="$test_user" --regid="$test_group" --clear-groups -- test -r "$SCRATCH/lanes/lane-proof.prompt.md"
setpriv --reuid="$test_user" --regid="$test_group" --clear-groups -- test -w "$SCRATCH/lanes/lane-proof.log"
test "$(stat -c %U "$FIXTURE_REPO")" = root
[[ "$(stat -c %A "$FIXTURE_REPO")" != ?????w???? ]]

# Existing-name lock: the launcher must refuse before composition or unit use.
rm -f "$SCRATCH/systemd.args" "$SCRATCH/agent.executed"
if PATH="$SCRATCH/bin:$PATH" AGENT_COMMAND_FILE="$SCRATCH/agent.conf" \
  MOCK_SYSTEMD_ARGS="$SCRATCH/systemd.args" MOCK_AGENT_ARGS="$SCRATCH/agent.args" \
  MOCK_AGENT_EXECUTED="$SCRATCH/agent.executed" TMPDIR="$SCRATCH/tmp-parent" \
  "$SCRIPT_DIR/launch-lane.sh" --name proof --role coder --task-file "$SCRATCH/task.md" \
  --repo "$FIXTURE_REPO" --lanes-dir "$SCRATCH/lanes" --base HEAD --branch ag-fleet-launch-proof \
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
    --repo "$FIXTURE_REPO" --lanes-dir "$SCRATCH/lanes" --base HEAD --branch ag-fleet-launch-race \
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
[[ "$(find "$SCRATCH" -name 'race-*.agent.executed' -type f -size +0c | wc -l)" -eq 1 ]]

# Every artifact location rejects dangling symlinks as an existing claim.
for artifact_kind in worktree pack prompt log tmp; do
  lane="dangling-$artifact_kind"
  case "$artifact_kind" in
    worktree) artifact="$SCRATCH/lanes/$lane" ;;
    pack) artifact="$SCRATCH/lanes/pack-$lane" ;;
    prompt) artifact="$SCRATCH/lanes/lane-$lane.prompt.md" ;;
    log) artifact="$SCRATCH/lanes/lane-$lane.log" ;;
    tmp) artifact="$SCRATCH/lanes/tmp/$lane" ;;
  esac
  mkdir -p "$(dirname "$artifact")"
  ln -s "$SCRATCH/does-not-exist" "$artifact"
  if PATH="$SCRATCH/bin:$PATH" AGENT_COMMAND_FILE="$SCRATCH/agent.conf" \
    TMPDIR="$SCRATCH/tmp-parent" \
    "$SCRIPT_DIR/launch-lane.sh" --name "$lane" --role coder --task-file "$SCRATCH/task.md" \
    --repo "$FIXTURE_REPO" --lanes-dir "$SCRATCH/lanes" --base HEAD \
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
  --repo "$FIXTURE_REPO" --lanes-dir "$SCRATCH/lanes" --base HEAD --branch ag-fleet-launch-retry \
  >"$SCRATCH/retry-failed.output" 2>"$SCRATCH/retry-failed.error"; then
  printf 'launcher accepted a failed unit start\n' >&2
  exit 1
fi
grep -Fq 'unit launch failed; cleaned lane artifacts: retry' "$SCRATCH/retry-failed.error"
test ! -e "$SCRATCH/lanes/retry"
test ! -e "$SCRATCH/lanes/pack-retry"
test ! -e "$SCRATCH/lanes/lane-retry.prompt.md"
test ! -e "$SCRATCH/lanes/tmp/retry"
PATH="$SCRATCH/bin:$PATH" AGENT_COMMAND_FILE="$SCRATCH/agent.conf" \
  MOCK_SYSTEMD_ARGS="$SCRATCH/retry.systemd.args" MOCK_AGENT_ARGS="$SCRATCH/retry.agent.args" \
  MOCK_AGENT_EXECUTED="$SCRATCH/retry.agent.executed" TMPDIR="$SCRATCH/tmp-parent" \
  "$SCRIPT_DIR/launch-lane.sh" --name retry --role coder --task-file "$SCRATCH/task.md" \
  --repo "$FIXTURE_REPO" --lanes-dir "$SCRATCH/lanes" --base HEAD --branch ag-fleet-launch-retry \
  >"$SCRATCH/retry.output"
grep -Fq 'launched lane-retry' "$SCRATCH/retry.output"

printf 'launch-lane dispatch proof: PASS\n'
