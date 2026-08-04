#!/usr/bin/env bash
set -euo pipefail

# Exercise the fixture with the restrictive mask used by the landing gate.
# Inputs consumed after the launcher drops privileges must set their own modes.
umask 0077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"
SCRATCH="$(mktemp -d /tmp/infra-launch-test.XXXXXX)"
fixture_user=nobody
fixture_uid="$(id -u "$fixture_user")"
fixture_gid="$(id -g "$fixture_user")"
cleanup() {
  [[ -z "${KEEP_LAUNCH_TEST:-}" ]] || { printf 'kept fixture: %s\n' "$SCRATCH"; return; }
  rm -rf "$SCRATCH"
}
trap cleanup EXIT
chmod 0777 "$SCRATCH"
mkdir -p "$SCRATCH/bin" "$SCRATCH/home/.codex" "$SCRATCH/home/lanes" "$SCRATCH/tmp"
cp "${BUN_BIN:-$(command -v bun)}" "$SCRATCH/bin/bun"
git clone -q --no-local "$SOURCE_REPO" "$SCRATCH/repo"
cp "$SCRIPT_DIR/launch-lane.sh" "$SCRATCH/repo/orchestrator/fleet/launch-lane.sh"
fixture_launcher="$SCRATCH/repo/orchestrator/fleet/launch-lane.sh"
git -C "$SCRATCH/repo" add orchestrator/fleet/launch-lane.sh
if ! git -C "$SCRATCH/repo" diff --cached --quiet; then
  git -C "$SCRATCH/repo" -c user.name=fixture -c user.email=fixture@example.invalid \
    commit -m 'fixture candidate launcher' -q
fi
printf '{}\n' >"$SCRATCH/home/.codex/auth.json"
chmod 0600 "$SCRATCH/home/.codex/auth.json"
cat >"$SCRATCH/service.conf" <<EOF
LANE_SERVICE_USER=$fixture_user
LANE_SERVICE_HOME=$SCRATCH/home
LANE_REPOSITORY_ROOT=$SCRATCH/repo
LANE_WORKTREES_ROOT=$SCRATCH/home/lanes
LANE_PROVIDER=codex
EOF
cat >"$SCRATCH/task.md" <<'EOF'
# Dispatch proof
EOF
cat >"$SCRATCH/agent.conf" <<EOF
$SCRATCH/bin/agent
multi element
--literal-option
EOF
cat >"$SCRATCH/bin/agent" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
test "$1" = 'multi element'
test "$2" = '--literal-option'
printf '%s\n' "$1" "$2" >"$PROOF_DIR/agent.args"
id -u >"$PROOF_DIR/euid"
id -g >"$PROOF_DIR/egid"
git add proof.txt
git -c user.name=fixture -c user.email=fixture@example.invalid commit -m proof >/dev/null
sha=$(git rev-parse HEAD)
printf 'commit: %s fixture\nverify: true\nresult: clean\nsecret-scan: clean\nremaining: none\n' "$sha" >"$LANE_REPORT_PATH"
printf 'API_KEY=1234567890abcdef\n'
EOF
cat >"$SCRATCH/bin/loginctl" <<EOF
#!/bin/sh
test "\${LINGER_OFF:-}" != 1 || { printf 'no\n'; exit; }
printf 'yes\n'
EOF
cat >"$SCRATCH/bin/systemctl" <<'EOF'
#!/bin/sh
exit 0
EOF
cat >"$SCRATCH/bin/systemd-run" <<EOF
#!/usr/bin/env bash
set -euo pipefail
if [[ -n "\${MOCK_SYSTEMD_FAIL:-}" ]]; then exit 1; fi
printf '%s\n' "\$@" >'$SCRATCH/systemd.args'
while ((\$#)); do
  case "\$1" in
    --user|--collect) shift ;;
    --unit) shift 2 ;;
    --setenv=*) export "\${1#--setenv=}"; shift ;;
    --working-directory=*) cd "\${1#--working-directory=}"; shift ;;
    --property=*) shift ;;
    *) break ;;
  esac
done
printf proof >proof.txt
"\$@" || true
exit 0
EOF
chmod 0755 "$SCRATCH/bin/"*
chown -R "$fixture_uid:$fixture_gid" "$SCRATCH/home" "$SCRATCH/repo" "$SCRATCH/bin" "$SCRATCH/tmp" "$SCRATCH/service.conf" "$SCRATCH/task.md"
chmod 0644 "$SCRATCH/service.conf" "$SCRATCH/task.md" "$SCRATCH/agent.conf"
chown "$fixture_uid:$fixture_gid" "$SCRATCH/agent.conf"
cd "$SCRATCH/repo"
run_launcher() {
  env -u DISPATCH_OVERRIDE PATH="$SCRATCH/bin:/usr/local/bin:/usr/bin:/bin" BUN_BIN="$SCRATCH/bin/bun" \
    PROOF_DIR="$SCRATCH" AGENT_COMMAND_FILE="$SCRATCH/agent.conf" TMPDIR="$SCRATCH/tmp" \
    "$fixture_launcher" --name proof --role coder --task-file "$SCRATCH/task.md" \
    --repo "$SCRATCH/repo" --lanes-dir "$SCRATCH/home/lanes" --base HEAD \
    --branch ag-fleet-launch-proof --service-config "$SCRATCH/service.conf"
}
if run_launcher >"$SCRATCH/output" 2>"$SCRATCH/output.err"; then
  :
else
  launcher_status=$?
  printf 'nominal launcher failed (exit=%s)\n' "$launcher_status" >&2
  if [[ -s "$SCRATCH/output" ]]; then
    printf '%s\n' '--- launcher stdout ---' >&2
    cat "$SCRATCH/output" >&2
  fi
  if [[ -s "$SCRATCH/output.err" ]]; then
    printf '%s\n' '--- launcher stderr ---' >&2
    cat "$SCRATCH/output.err" >&2
  fi
  exit "$launcher_status"
fi
if grep -Fq 'OVERRIDE accepted' "$SCRATCH/output" "$SCRATCH/output.err"; then
  printf 'nominal launcher bypassed dispatch validation\n' >&2; exit 1
fi
grep -Fxq "$fixture_uid" "$SCRATCH/euid"
grep -Fxq "$fixture_gid" "$SCRATCH/egid"
setpriv --reuid="$fixture_uid" --regid="$fixture_gid" --init-groups \
  env HOME="$SCRATCH/home" git -C "$SCRATCH/home/lanes/proof" log -1 --format=%s | grep -Fxq proof
grep -Fxq -- '--user' "$SCRATCH/systemd.args"
grep -Fxq -- '--property=IPAddressDeny=localhost' "$SCRATCH/systemd.args"
grep -Fq 'daemon/mask-stream.ts' "$SCRATCH/systemd.args"
grep -Fq "TMPDIR=$SCRATCH/tmp/infra-lane-tmp-$fixture_uid/proof" "$SCRATCH/systemd.args"
grep -Fxq 'multi element' "$SCRATCH/agent.args"
grep -Fxq -- '--literal-option' "$SCRATCH/agent.args"
if grep -q -- '--setenv=HOME=' "$SCRATCH/systemd.args"; then
  printf 'launcher overrode HOME in user unit\n' >&2; exit 1
fi
grep -Fq 'API_KEY=' "$SCRATCH/home/lanes/lane-proof.log"
if grep -Fq '1234567890abcdef' "$SCRATCH/home/lanes/lane-proof.log"; then
  printf 'lane log retained secret\n' >&2; exit 1
fi

# Fail-closed privilege preflights occur before reservations or worktrees.
assert_no_lane_artifacts() {
  local lane=$1 artifact
  for artifact in "$SCRATCH/home/lanes/$lane" "$SCRATCH/home/lanes/pack-$lane" \
    "$SCRATCH/home/lanes/lane-$lane.prompt.md" "$SCRATCH/home/lanes/lane-$lane.log" \
    "$SCRATCH/home/lanes/$lane.report.md" "$SCRATCH/home/lanes/lane-$lane.status" \
    "$SCRATCH/tmp/infra-lane-tmp-$fixture_uid/$lane"; do
    test ! -e "$artifact" && test ! -L "$artifact"
  done
}

sed 's/LANE_SERVICE_USER=.*/LANE_SERVICE_USER=definitely-absent/' "$SCRATCH/service.conf" >"$SCRATCH/absent.conf"
if LANE_SERVICE_CONFIG="$SCRATCH/absent.conf" "$fixture_launcher" --name absent --role coder --task-file "$SCRATCH/task.md" 2>"$SCRATCH/absent.err"; then exit 1; fi
grep -Fq 'service user is absent: definitely-absent' "$SCRATCH/absent.err"
assert_no_lane_artifacts absent

rm -f "$SCRATCH/home/.codex/auth.json"
if PATH="$SCRATCH/bin:$PATH" LANE_SERVICE_CONFIG="$SCRATCH/service.conf" "$fixture_launcher" --name nocreds --role coder --task-file "$SCRATCH/task.md" 2>"$SCRATCH/creds.err"; then exit 1; fi
grep -Fq 'provider credentials are missing:' "$SCRATCH/creds.err"
assert_no_lane_artifacts nocreds
printf '{}\n' >"$SCRATCH/home/.codex/auth.json"; chmod 0600 "$SCRATCH/home/.codex/auth.json"; chown "$fixture_uid:$fixture_gid" "$SCRATCH/home/.codex/auth.json"

chown 0:0 "$SCRATCH/home/.codex/auth.json"
if PATH="$SCRATCH/bin:$PATH" LANE_SERVICE_CONFIG="$SCRATCH/service.conf" "$fixture_launcher" --name bad-owner --role coder --task-file "$SCRATCH/task.md" 2>"$SCRATCH/bad-owner.err"; then exit 1; fi
grep -Fq 'provider credentials have wrong owner:' "$SCRATCH/bad-owner.err"
assert_no_lane_artifacts bad-owner
chown "$fixture_uid:$fixture_gid" "$SCRATCH/home/.codex/auth.json"

chmod 0640 "$SCRATCH/home/.codex/auth.json"
if PATH="$SCRATCH/bin:$PATH" LANE_SERVICE_CONFIG="$SCRATCH/service.conf" "$fixture_launcher" --name bad-mode --role coder --task-file "$SCRATCH/task.md" 2>"$SCRATCH/bad-mode.err"; then exit 1; fi
grep -Fq 'provider credentials must have mode 0600:' "$SCRATCH/bad-mode.err"
assert_no_lane_artifacts bad-mode
chmod 0600 "$SCRATCH/home/.codex/auth.json"

mkdir "$SCRATCH/uid-mismatch-bin"
cat >"$SCRATCH/uid-mismatch-bin/id" <<EOF
#!/bin/sh
if [ "\$1" = -u ] && [ "\${2:-}" = "$fixture_user" ]; then printf '1000\n'; else exec /usr/bin/id "\$@"; fi
EOF
cat >"$SCRATCH/uid-mismatch-bin/stat" <<'EOF'
#!/bin/sh
if [ "$1" = -c ] && [ "$2" = %u ]; then printf '1000\n'; else exec /usr/bin/stat "$@"; fi
EOF
chmod 0755 "$SCRATCH/uid-mismatch-bin" "$SCRATCH/uid-mismatch-bin/"*
if setpriv --reuid="$fixture_uid" --regid="$fixture_gid" --init-groups \
  env PATH="$SCRATCH/uid-mismatch-bin:$SCRATCH/bin:$PATH" LANE_SERVICE_CONFIG="$SCRATCH/service.conf" \
  "$fixture_launcher" --name uid-mismatch --role coder --task-file "$SCRATCH/task.md" \
  2>"$SCRATCH/uid-mismatch.err"; then exit 1; fi
grep -Fq "launcher uid does not match service user: $fixture_user" "$SCRATCH/uid-mismatch.err"
assert_no_lane_artifacts uid-mismatch

mkdir "$SCRATCH/failed-setpriv-bin"
cat >"$SCRATCH/failed-setpriv-bin/setpriv" <<'EOF'
#!/bin/sh
exit 91
EOF
chmod 0755 "$SCRATCH/failed-setpriv-bin" "$SCRATCH/failed-setpriv-bin/setpriv"
if PATH="$SCRATCH/failed-setpriv-bin:$SCRATCH/bin:$PATH" LANE_SERVICE_CONFIG="$SCRATCH/service.conf" \
  "$fixture_launcher" --name failed-setpriv --role coder --task-file "$SCRATCH/task.md" \
  2>"$SCRATCH/failed-setpriv.err"; then exit 1; fi
assert_no_lane_artifacts failed-setpriv

if PATH="$SCRATCH/bin:$PATH" LINGER_OFF=1 LANE_SERVICE_CONFIG="$SCRATCH/service.conf" "$fixture_launcher" --name nolinger --role coder --task-file "$SCRATCH/task.md" 2>"$SCRATCH/linger.err"; then exit 1; fi
grep -Fq 'linger is off for service user:' "$SCRATCH/linger.err"
assert_no_lane_artifacts nolinger

# The unit wrapper, not the payload, decides terminal state from the declared report.
cat >"$SCRATCH/bin/report-agent" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
mode=$1
if [[ "$mode" == crash ]]; then exit 17; fi
if [[ "$mode" == silent ]]; then exit 0; fi
sha=$(git rev-parse HEAD)
{
  printf 'commit: %s fixture\n' "$sha"
  printf 'verify: true\nresult: clean\nsecret-scan: clean\nremaining: none\n'
  if [[ "$mode" == invalid ]]; then printf 'review: claimed\n'; fi
} >"$LANE_REPORT_PATH"
EOF
chmod 0755 "$SCRATCH/bin/report-agent"
chown "$fixture_uid:$fixture_gid" "$SCRATCH/bin/report-agent"
for mode in silent valid invalid crash; do
  lane="outcome-$mode"
  printf '%s\n%s\n' "$SCRATCH/bin/report-agent" "$mode" >"$SCRATCH/$mode.conf"
  chmod 0644 "$SCRATCH/$mode.conf"
  chown "$fixture_uid:$fixture_gid" "$SCRATCH/$mode.conf"
  PATH="$SCRATCH/bin:$PATH" BUN_BIN="$SCRATCH/bin/bun" AGENT_COMMAND_FILE="$SCRATCH/$mode.conf" \
    TMPDIR="$SCRATCH/tmp" "$fixture_launcher" --name "$lane" --role coder \
    --task-file "$SCRATCH/task.md" --repo "$SCRATCH/repo" --lanes-dir "$SCRATCH/home/lanes" \
    --base HEAD --branch "ag-fleet-launch-$lane" --service-config "$SCRATCH/service.conf" \
    >"$SCRATCH/$mode.out"
done
grep -Fxq 'state: failed' "$SCRATCH/home/lanes/lane-outcome-silent.status"
grep -Fxq 'reason: report-invalid' "$SCRATCH/home/lanes/lane-outcome-silent.status"
grep -Fxq 'state: terminal' "$SCRATCH/home/lanes/lane-outcome-valid.status"
grep -Fxq 'reason: report-valid' "$SCRATCH/home/lanes/lane-outcome-valid.status"
grep -Fxq 'state: failed' "$SCRATCH/home/lanes/lane-outcome-invalid.status"
grep -Fxq 'reason: report-invalid' "$SCRATCH/home/lanes/lane-outcome-invalid.status"
grep -Fq 'missing file=' "$SCRATCH/home/lanes/lane-outcome-invalid.log"
grep -Fxq 'state: failed' "$SCRATCH/home/lanes/lane-outcome-crash.status"
grep -Fxq 'reason: payload-exit' "$SCRATCH/home/lanes/lane-outcome-crash.status"
grep -Fxq 'exit: 17' "$SCRATCH/home/lanes/lane-outcome-crash.status"

mkdir "$SCRATCH/command-dir"
: >"$SCRATCH/empty.conf"
chmod 0644 "$SCRATCH/empty.conf"
chown "$fixture_uid:$fixture_gid" "$SCRATCH/empty.conf"
printf '%s\n' "$SCRATCH/bin/agent" >"$SCRATCH/unreadable.conf"
chmod 000 "$SCRATCH/unreadable.conf"
for case_name in missing empty directory unreadable; do
  case "$case_name" in
    missing) command_file="$SCRATCH/missing.conf"; expected='agent command file missing or unreadable:' ;;
    empty) command_file="$SCRATCH/empty.conf"; expected='agent command file is empty:' ;;
    directory) command_file="$SCRATCH/command-dir"; expected='agent command file missing or unreadable:' ;;
    unreadable) command_file="$SCRATCH/unreadable.conf"; expected='agent command file missing or unreadable:' ;;
  esac
  if PATH="$SCRATCH/bin:$PATH" BUN_BIN="$SCRATCH/bin/bun" AGENT_COMMAND_FILE="$command_file" \
    LANE_SERVICE_CONFIG="$SCRATCH/service.conf" "$fixture_launcher" --name "command-$case_name" \
    --role coder --task-file "$SCRATCH/task.md" 2>"$SCRATCH/$case_name.err"; then
    printf 'launcher accepted %s command file\n' "$case_name" >&2; exit 1
  fi
  grep -Fq "$expected" "$SCRATCH/$case_name.err"
done

# The pack and prompt necessarily precede dispatch validation; worktree, private
# TMPDIR and unit creation necessarily follow it. A malformed composed marker
# must stop before any of those post-dispatch artifacts exist.
cp "$fixture_launcher" "$SCRATCH/repo/orchestrator/fleet/launch-lane.bad-dispatch.sh"
sed -i 's/cat "$pack_dir\/preamble.md"/printf "malformed pack\\n"/' "$SCRATCH/repo/orchestrator/fleet/launch-lane.bad-dispatch.sh"
chmod 0755 "$SCRATCH/repo/orchestrator/fleet/launch-lane.bad-dispatch.sh"
chown "$fixture_uid:$fixture_gid" "$SCRATCH/repo/orchestrator/fleet/launch-lane.bad-dispatch.sh"
if setpriv --reuid="$fixture_uid" --regid="$fixture_gid" --init-groups \
  env -u DISPATCH_OVERRIDE HOME="$SCRATCH/home" USER="$fixture_user" LOGNAME="$fixture_user" \
  PATH="$SCRATCH/bin:$PATH" BUN_BIN="$SCRATCH/bin/bun" AGENT_COMMAND_FILE="$SCRATCH/agent.conf" \
  TMPDIR="$SCRATCH/tmp" "$SCRATCH/repo/orchestrator/fleet/launch-lane.bad-dispatch.sh" \
  --name dispatchfail --role coder --task-file "$SCRATCH/task.md" --repo "$SCRATCH/repo" \
  --lanes-dir "$SCRATCH/home/lanes" --base HEAD --service-config "$SCRATCH/service.conf" \
  >"$SCRATCH/dispatchfail.out" 2>"$SCRATCH/dispatchfail.err"; then
  printf 'launcher accepted malformed dispatch pack\n' >&2; exit 1
fi
test ! -e "$SCRATCH/home/lanes/dispatchfail"
test ! -e "$SCRATCH/tmp/infra-lane-tmp-$fixture_uid/dispatchfail"
! grep -q 'dispatchfail' "$SCRATCH/systemd.args"

# Atomic reservation: of two concurrent launchers, exactly one owns the name.
race_success=0; race_failure=0
mkdir "$SCRATCH/race-1" "$SCRATCH/race-2"
chown "$fixture_uid:$fixture_gid" "$SCRATCH/race-1" "$SCRATCH/race-2"
for contender in 1 2; do
  PATH="$SCRATCH/bin:$PATH" BUN_BIN="$SCRATCH/bin/bun" AGENT_COMMAND_FILE="$SCRATCH/agent.conf" \
    PROOF_DIR="$SCRATCH/race-$contender" TMPDIR="$SCRATCH/tmp" \
    "$fixture_launcher" --name race --role coder --task-file "$SCRATCH/task.md" \
    --repo "$SCRATCH/repo" --lanes-dir "$SCRATCH/home/lanes" --base HEAD \
    --branch ag-fleet-launch-race --service-config "$SCRATCH/service.conf" \
    >"$SCRATCH/race-$contender.out" 2>"$SCRATCH/race-$contender.err" &
  eval "race_pid_$contender=$!"
done
for contender in 1 2; do
  pid_var="race_pid_$contender"
  if wait "${!pid_var}"; then race_success=$((race_success + 1)); else
    race_failure=$((race_failure + 1))
    grep -Fq 'lane artifact already exists for race:' "$SCRATCH/race-$contender.err"
  fi
done
[[ "$race_success" -eq 1 && "$race_failure" -eq 1 ]]

# Dangling links claim every artifact location, including the private TMPDIR.
for kind in worktree pack prompt log report status tmp; do
  lane="dangling-$kind"
  case "$kind" in
    worktree) artifact="$SCRATCH/home/lanes/$lane" ;;
    pack) artifact="$SCRATCH/home/lanes/pack-$lane" ;;
    prompt) artifact="$SCRATCH/home/lanes/lane-$lane.prompt.md" ;;
    log) artifact="$SCRATCH/home/lanes/lane-$lane.log" ;;
    report) artifact="$SCRATCH/home/lanes/$lane.report.md" ;;
    status) artifact="$SCRATCH/home/lanes/lane-$lane.status" ;;
    tmp) artifact="$SCRATCH/tmp/infra-lane-tmp-$fixture_uid/$lane" ;;
  esac
  mkdir -p "$(dirname "$artifact")"; ln -s "$SCRATCH/missing-target" "$artifact"
  if PATH="$SCRATCH/bin:$PATH" BUN_BIN="$SCRATCH/bin/bun" AGENT_COMMAND_FILE="$SCRATCH/agent.conf" \
    TMPDIR="$SCRATCH/tmp" "$fixture_launcher" --name "$lane" --role coder \
    --task-file "$SCRATCH/task.md" --repo "$SCRATCH/repo" --lanes-dir "$SCRATCH/home/lanes" \
    --base HEAD --service-config "$SCRATCH/service.conf" >"$SCRATCH/$lane.out" 2>"$SCRATCH/$lane.err"; then
    printf 'launcher accepted dangling %s artifact\n' "$kind" >&2; exit 1
  fi
  grep -Fq "lane artifact already exists for $lane: $artifact" "$SCRATCH/$lane.err"
  rm "$artifact"
done

# A failed unit launch removes every artifact and permits exact-name reuse.
if PATH="$SCRATCH/bin:$PATH" BUN_BIN="$SCRATCH/bin/bun" AGENT_COMMAND_FILE="$SCRATCH/agent.conf" \
  TMPDIR="$SCRATCH/tmp" MOCK_SYSTEMD_FAIL=1 "$fixture_launcher" --name retry --role coder \
  --task-file "$SCRATCH/task.md" --repo "$SCRATCH/repo" --lanes-dir "$SCRATCH/home/lanes" \
  --base HEAD --branch ag-fleet-launch-retry --service-config "$SCRATCH/service.conf" \
  >"$SCRATCH/retry-fail.out" 2>"$SCRATCH/retry-fail.err"; then exit 1; fi
for artifact in "$SCRATCH/home/lanes/retry" "$SCRATCH/home/lanes/pack-retry" \
  "$SCRATCH/home/lanes/lane-retry.prompt.md" "$SCRATCH/home/lanes/retry.report.md" \
  "$SCRATCH/home/lanes/lane-retry.status" "$SCRATCH/tmp/infra-lane-tmp-$fixture_uid/retry"; do
  test ! -e "$artifact" && test ! -L "$artifact"
done
mkdir "$SCRATCH/retry-proof"
chown "$fixture_uid:$fixture_gid" "$SCRATCH/retry-proof"
PATH="$SCRATCH/bin:$PATH" BUN_BIN="$SCRATCH/bin/bun" AGENT_COMMAND_FILE="$SCRATCH/agent.conf" \
  PROOF_DIR="$SCRATCH/retry-proof" TMPDIR="$SCRATCH/tmp" "$fixture_launcher" --name retry \
  --role coder --task-file "$SCRATCH/task.md" --repo "$SCRATCH/repo" \
  --lanes-dir "$SCRATCH/home/lanes" --base HEAD --branch ag-fleet-launch-retry \
  --service-config "$SCRATCH/service.conf" >"$SCRATCH/retry.out"

printf 'launch-lane non-root regression locks: PASS\n'
