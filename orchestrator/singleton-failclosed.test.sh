#!/usr/bin/env bash
# Regression lock: absent state DB must not permit parallel orchestrators.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRATCH="$(mktemp -d)"
TMUX_SOCKET="singleton-failclosed-$$"
SHIM="$SCRATCH/bin"
SINGLETON_LOCK="$SCRATCH/orchestrator.singleton.lock"

cleanup() {
  tmux -L "$TMUX_SOCKET" kill-server 2>/dev/null || true
  [[ -z "${unknown_holder_pid:-}" ]] || kill "$unknown_holder_pid" 2>/dev/null || true
  [[ -z "${stale_survivor_pid:-}" ]] || kill "$stale_survivor_pid" 2>/dev/null || true
  rm -rf "$SCRATCH"
}
trap cleanup EXIT
mkdir -p "$SHIM" "$SCRATCH/home"

# The recovery half of this regression lock derives the kernel lock owner from
# /proc/locks. Some container runtimes expose an empty /proc/locks even for a
# flock acquired inside that same PID namespace. In that environment the
# subject is genuinely unmeasurable: launch.sh itself must fail closed, and the
# test must report a named exclusion rather than turn the missing observation
# boundary into a pass or an incidental failure later in the fixture.
proc_lock_probe="$SCRATCH/proc-lock-probe"
exec {proc_lock_probe_fd}>"$proc_lock_probe"
flock "$proc_lock_probe_fd"
proc_lock_probe_inode="$(stat -Lc '%i' "$proc_lock_probe")"
if ! awk -v inode="$proc_lock_probe_inode" '
  $2 == "FLOCK" { split($6, key, ":"); if (key[3] == inode) found = 1 }
  END { exit(found ? 0 : 1) }
' /proc/locks; then
  printf '%s\n' \
    'singleton-failclosed: EXCLUDED capability=proc-lock-observability (/proc/locks does not expose this process namespace flock)'
  exit 0
fi
exec {proc_lock_probe_fd}>&-

cat > "$SHIM/tmux" <<'EOF'
#!/usr/bin/env bash
exec /usr/bin/tmux -L "${ORCH_TEST_TMUX_SOCKET:?}" "$@"
EOF
cat > "$SHIM/systemd-run" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' 'Failed to connect to user scope bus via local transport' >&2
exit 1
EOF
cat > "$SHIM/codex" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$$" >> "${ORCH_TEST_PROVIDER_PIDS:?}"
exec sleep 1000
EOF
cat > "$SCRATCH/preflight.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$SHIM/tmux" "$SHIM/systemd-run" "$SHIM/codex" "$SCRATCH/preflight.sh"

export PATH="$SHIM:$PATH"
export HOME="$SCRATCH/home"
export ORCH_TEST_TMUX_SOCKET="$TMUX_SOCKET"
export ORCH_CONFIG_FILE="$SCRATCH/no-runtime.env"
export ORCH_STATE_DB="$SCRATCH/absent/state.db"
# launch.sh derives the live-instance lock from the ambient chat id and
# deletes it on `stop`. Unisolated, this suite removes the operator's real
# orchestrator lock whenever it runs inside an orchestrator-spawned shell.
export ORCH_INSTANCE_LOCK_FILE="$SCRATCH/instance.lock"
export ORCH_SINGLETON_LOCK_FILE="$SINGLETON_LOCK"
export ORCH_LIVENESS_FILE="$SCRATCH/orchestrator.liveness"
export ORCH_TEST_PROVIDER_PIDS="$SCRATCH/provider-pids"
export ORCH_PROVIDER=codex
export ORCH_AUTH_PREFLIGHT="$SCRATCH/preflight.sh"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
provider_count() {
  [[ -f "$ORCH_TEST_PROVIDER_PIDS" ]] || { printf '0\n'; return; }
  wc -l < "$ORCH_TEST_PROVIDER_PIDS"
}

export ORCH_SESSION=singleton-first ORCH_RUNTIME_DIR="$SCRATCH/runtime-first"
env -u DBUS_SESSION_BUS_ADDRESS -u XDG_RUNTIME_DIR "$SCRIPT_DIR/launch.sh" start
tmux -L "$TMUX_SOCKET" has-session -t singleton-first ||
  fail 'headless launch did not spawn a detached tmux session'
[[ "$(provider_count)" == 1 ]] ||
  fail 'first launch reported success before the provider exec boundary'
first_provider_pid="$(tail -n 1 "$ORCH_TEST_PROVIDER_PIDS")"
kill -0 "$first_provider_pid" 2>/dev/null ||
  fail 'first launch left only a pane shell, not a live provider'
live_lock_inode="$(stat -Lc '%d:%i' "$SINGLETON_LOCK")"

export ORCH_SESSION=singleton-second ORCH_RUNTIME_DIR="$SCRATCH/runtime-second"
set +e
second_output="$("$SCRIPT_DIR/launch.sh" start 2>&1)"
second_status=$?
set -e
(( second_status != 0 )) || fail 'second launch succeeded without a state DB'
grep -q '^ERROR orchestrator-singleton-held ' <<<"$second_output" ||
  fail "second launch did not report singleton refusal: $second_output"
if tmux -L "$TMUX_SOCKET" has-session -t singleton-second 2>/dev/null; then
  fail 'refused second session remained running'
fi
[[ "$(stat -Lc '%d:%i' "$SINGLETON_LOCK")" == "$live_lock_inode" ]] ||
  fail 'live singleton holder was bypassed by rotating the lock inode'
[[ "$(provider_count)" == 1 ]] ||
  fail 'cross-session singleton refusal executed a second provider'
kill -0 "$first_provider_pid" 2>/dev/null ||
  fail 'cross-session singleton refusal killed the live provider'

tmux -L "$TMUX_SOCKET" kill-session -t singleton-first
for _ in 1 2 3 4 5 6 7 8 9 10; do
  ! kill -0 "$first_provider_pid" 2>/dev/null && break
  sleep 0.1
done
! kill -0 "$first_provider_pid" 2>/dev/null ||
  fail 'fixture provider did not exit with its tmux session'

# An arbitrary live holder is NOT recoverable just because the previous
# provider identity is dead. Refuse it without rotating the inode.
unknown_inode="$(stat -Lc '%d:%i' "$SINGLETON_LOCK")"
unknown_ready="$SCRATCH/unknown.ready"
unknown_release="$SCRATCH/unknown.release"
(
  exec 7>"$SINGLETON_LOCK"
  flock 7
  : > "$unknown_ready"
  while [[ ! -f "$unknown_release" ]]; do sleep 0.01; done
) &
unknown_holder_pid=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [[ -f "$unknown_ready" ]] && break
  sleep 0.05
done
[[ -f "$unknown_ready" ]] || fail 'unknown-holder fixture never acquired the singleton lock'
export ORCH_SESSION=singleton-unknown ORCH_RUNTIME_DIR="$SCRATCH/runtime-unknown"
set +e
unknown_output="$(timeout 5 "$SCRIPT_DIR/launch.sh" start 2>&1)"
unknown_status=$?
set -e
(( unknown_status != 0 )) || fail 'unknown live holder was bypassed'
grep -q '^ERROR orchestrator-singleton-held .*recovery=unproven' <<<"$unknown_output" ||
  fail "unknown live holder refusal was not explicit: $unknown_output"
[[ "$(stat -Lc '%d:%i' "$SINGLETON_LOCK")" == "$unknown_inode" ]] ||
  fail 'unknown live holder caused lock inode rotation'
: > "$unknown_release"
wait "$unknown_holder_pid" 2>/dev/null || true
unknown_holder_pid=""

# Reproduce the exact inherited-OFD failure. The original lock owner forks a
# long-lived survivor, then exits. /proc/locks retains that dead original PID;
# shared owner metadata carries the same reuse-safe PID/starttime and exact
# device+inode identity, so recovery has positive association rather than a
# generic "something holds the file" guess.
stale_ready="$SCRATCH/stale.ready"
stale_release="$SCRATCH/stale.release"
stale_survivor_file="$SCRATCH/stale-survivor.pid"
stale_provider_file="$SCRATCH/stale-provider.pid"
# shellcheck disable=SC2016 # Positional parameters belong to the fixture sh.
flock "$SINGLETON_LOCK" sh -c '
  printf "%s\n" "$$" > "$1"
  sleep 1000 &
  printf "%s\n" "$!" > "$2"
  : > "$3"
  while [ ! -f "$4" ]; do sleep 0.01; done
' sh "$stale_provider_file" "$stale_survivor_file" "$stale_ready" "$stale_release" &
stale_lock_owner_pid=$!
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  [[ -f "$stale_ready" ]] && break
  sleep 0.05
done
[[ -f "$stale_ready" ]] || fail 'stale-OFD fixture did not become ready'
stale_provider_pid="$(cat "$stale_provider_file")"
stale_provider_starttime="$(awk '{print $22}' "/proc/$stale_provider_pid/stat")"
stale_survivor_pid="$(cat "$stale_survivor_file")"
lock_inode="$(stat -Lc '%i' "$SINGLETON_LOCK")"
lock_major_minor="$(findmnt -T "$SINGLETON_LOCK" -n -o MAJ:MIN | tr -d '[:space:]')"
printf 'provider_pid=%s\nprovider_starttime=%s\nlock_owner_pid=%s\nlock_key=%s:%s\n' \
  "$stale_provider_pid" "$stale_provider_starttime" "$stale_lock_owner_pid" \
  "$lock_major_minor" "$lock_inode" \
  > "$SINGLETON_LOCK.owner"
: > "$stale_release"
wait "$stale_lock_owner_pid"
! kill -0 "$stale_provider_pid" 2>/dev/null ||
  fail 'stale provider did not exit'
! kill -0 "$stale_lock_owner_pid" 2>/dev/null ||
  fail 'original stale lock owner did not exit'
kill -0 "$stale_survivor_pid" 2>/dev/null ||
  fail 'inherited lock survivor did not outlive its original owner'
proc_lock_owner="$(awk -v inode="$lock_inode" '
  $2 == "FLOCK" { split($6, key, ":"); if (key[3] == inode) print $5 }
' /proc/locks)"
[[ "$proc_lock_owner" == "$stale_lock_owner_pid" ]] ||
  fail "kernel did not retain the dead original owner (got ${proc_lock_owner:-none})"

export ORCH_SESSION=singleton-reclaimed ORCH_RUNTIME_DIR="$SCRATCH/runtime-reclaimed"
set +e
reclaimed_output="$(timeout 10 "$SCRIPT_DIR/launch.sh" start 2>&1)"
reclaimed_status=$?
set -e
(( reclaimed_status == 0 )) ||
  fail "fresh launch did not recover the dead-provider lock (rc=$reclaimed_status): $reclaimed_output"
tmux -L "$TMUX_SOCKET" has-session -t singleton-reclaimed ||
  fail 'fresh launch did not reclaim a stale lockfile'
[[ "$(provider_count)" == 2 ]] ||
  fail 'stale-lock recovery left another empty pane instead of execing provider'
reclaimed_provider_pid="$(tail -n 1 "$ORCH_TEST_PROVIDER_PIDS")"
kill -0 "$reclaimed_provider_pid" 2>/dev/null ||
  fail 'recovered launch provider is not live'

printf 'singleton fail-closed tests: PASS\n'
