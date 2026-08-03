#!/usr/bin/env bash
set -euo pipefail

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
if [[ -n "${MOCK_SYSTEMD_FAIL:-}" ]]; then exit 1; fi
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
exec "\$@"
EOF
chmod +x "$SCRATCH/bin/"*
chown -R "$fixture_uid:$fixture_gid" "$SCRATCH/home" "$SCRATCH/repo" "$SCRATCH/bin" "$SCRATCH/tmp" "$SCRATCH/service.conf" "$SCRATCH/task.md"
export DISPATCH_OVERRIDE=fixture-tests-candidate-launcher

run_launcher() {
  PATH="$SCRATCH/bin:/usr/local/bin:/usr/bin:/bin" BUN_BIN="$SCRATCH/bin/bun" \
    PROOF_DIR="$SCRATCH" AGENT_COMMAND_FILE="$SCRATCH/agent.conf" TMPDIR="$SCRATCH/tmp" \
    "$fixture_launcher" --name proof --role coder --task-file "$SCRATCH/task.md" \
    --repo "$SCRATCH/repo" --lanes-dir "$SCRATCH/home/lanes" --base HEAD \
    --branch ag-fleet-launch-proof --service-config "$SCRATCH/service.conf"
}
run_launcher >"$SCRATCH/output"
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

# Fail-closed preflights occur before reservations or worktrees.
sed 's/LANE_SERVICE_USER=.*/LANE_SERVICE_USER=definitely-absent/' "$SCRATCH/service.conf" >"$SCRATCH/absent.conf"
if LANE_SERVICE_CONFIG="$SCRATCH/absent.conf" "$fixture_launcher" --name absent --role coder --task-file "$SCRATCH/task.md" 2>"$SCRATCH/absent.err"; then exit 1; fi
grep -Fq 'service user is absent: definitely-absent' "$SCRATCH/absent.err"

rm -f "$SCRATCH/home/.codex/auth.json"
if PATH="$SCRATCH/bin:$PATH" LANE_SERVICE_CONFIG="$SCRATCH/service.conf" "$fixture_launcher" --name nocreds --role coder --task-file "$SCRATCH/task.md" 2>"$SCRATCH/creds.err"; then exit 1; fi
grep -Fq 'provider credentials are missing:' "$SCRATCH/creds.err"
printf '{}\n' >"$SCRATCH/home/.codex/auth.json"; chmod 0600 "$SCRATCH/home/.codex/auth.json"; chown "$fixture_uid:$fixture_gid" "$SCRATCH/home/.codex/auth.json"
if PATH="$SCRATCH/bin:$PATH" LINGER_OFF=1 LANE_SERVICE_CONFIG="$SCRATCH/service.conf" "$fixture_launcher" --name nolinger --role coder --task-file "$SCRATCH/task.md" 2>"$SCRATCH/linger.err"; then exit 1; fi
grep -Fq 'linger is off for service user:' "$SCRATCH/linger.err"

mkdir "$SCRATCH/command-dir"
: >"$SCRATCH/empty.conf"
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
if env -u DISPATCH_OVERRIDE PATH="$SCRATCH/bin:$PATH" BUN_BIN="$SCRATCH/bin/bun" AGENT_COMMAND_FILE="$SCRATCH/agent.conf" \
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
