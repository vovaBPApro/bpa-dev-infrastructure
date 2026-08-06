#!/usr/bin/env bash
# Regression lock for V3-5.37: the launcher must start from the REPOSITORY, with
# no break-glass and no runtime.env.
#
# WHAT FAILED. On 2026-08-04 every `/start_claude` and `/start_codex` died. Two
# independent holes, both invisible to every gate in the tree:
#
#   1. orchestrator/launch.sh calls `mission_cli reap` and three `lease` verbs
#      whenever a state database exists. core/mission-cli.ts implemented none of
#      them, so the launcher died on `unknown action`. This did not fire on a
#      fresh box -- the block is guarded by state_available(), and a fresh box
#      has no state DB. Ordinary successful lane work created one, and from that
#      moment every start was dead. The regression was ARMED BY SUCCESS.
#   2. orchestrator/preflight-cli-auth.sh, which the launcher requires and
#      refuses without (exit 2), was absent from the tree and from HEAD.
#
# The orchestrator only came back because two lines were added to the gitignored
# orchestrator/runtime.env, pointing at /root/oldorch-breakglass/ -- a directory
# that travels with no repository. That is the Hard Floor 5 breach in full:
# `instance/incidents/2026-08-04-orchestrator-launcher-unstartable-from-git.md`.
#
# WHY THIS FILE IS A REHEARSAL AND NOT AN INSPECTION. Asserting that the CLI has
# a `reap` verb and that a preflight file exists would pass over both holes if
# the launcher called them differently, in a different order, or with arguments
# the CLI rejects. So the subject here is the real launch.sh, invoked directly,
# against a real state database created the way bootstrap/install.sh creates one,
# calling the REAL core/mission-cli.ts and the REAL tracked preflight. Nothing
# named ORCH_MISSION_CLI or ORCH_AUTH_PREFLIGHT is exported below, deliberately:
# the point is that the defaults work.
#
# Every fixture path is scratch and every tmux session lives on a private `-L`
# socket. The operator's live orchestrator, its singleton lock, its state DB and
# its default tmux socket are never touched.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
LAUNCH="$SCRIPT_DIR/launch.sh"

failures=0
pass() { printf 'ok   %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1"; failures=$((failures + 1)); }
check() { # check <name> <status> [detail]
  if (( $2 == 0 )); then pass "$1"; else fail "$1${3:+ — $3}"; fi
}

SCRATCH="$(mktemp -d)"
TMUX_SOCKET="launcher-from-git-$$"
cleanup() {
  tmux -L "$TMUX_SOCKET" kill-server >/dev/null 2>&1 || true
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

BUN_BIN_RESOLVED="${BUN_BIN:-$(command -v bun 2>/dev/null || true)}"
if [[ -z "$BUN_BIN_RESOLVED" || ! -x "$BUN_BIN_RESOLVED" ]]; then
  printf 'FAIL no bun on PATH; this lock cannot run\n'
  exit 1
fi

mkdir -p "$SCRATCH/bin" "$SCRATCH/runtime" "$SCRATCH/home"
cat > "$SCRATCH/bin/tmux" <<'EOF'
#!/usr/bin/env bash
exec /usr/bin/tmux -L "${ORCH_TEST_TMUX_SOCKET:?}" "$@"
EOF
cat > "$SCRATCH/bin/codex" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$$" > "${ORCH_TEST_PROVIDER_PID:?}"
exec sleep 1000
EOF
chmod +x "$SCRATCH/bin/tmux" "$SCRATCH/bin/codex"

# ── Credential fixtures ─────────────────────────────────────────────────────
# The tracked preflight reads its credential store through ORCH_CODEX_AUTH_FILE,
# its own documented parameter. That is an instance fact supplied by the
# environment, not a substitution of the mechanism: the real gate really runs,
# really parses with Bun, and really decides. Pointing it at $HOME instead would
# make this suite's verdict depend on whether the machine happens to be logged
# in, which is the V3-2.8 shape (a test whose result moves with host state).
printf '%s\n' '{"tokens":{"access_token":"fixture-not-a-secret","id_token":"fixture-not-a-secret"}}' \
  > "$SCRATCH/codex-subscription.json"
printf '%s\n' '{"OPENAI_API_KEY":"fixture-not-a-secret"}' \
  > "$SCRATCH/codex-metered.json"

export PATH="$SCRATCH/bin:$PATH"
export HOME="$SCRATCH/home"
export ORCH_TEST_TMUX_SOCKET="$TMUX_SOCKET"
export ORCH_TEST_PROVIDER_PID="$SCRATCH/provider.pid"
# The whole point: no runtime.env. This path does not exist and must not.
export ORCH_CONFIG_FILE="$SCRATCH/absent-runtime.env"
export ORCH_RUNTIME_DIR="$SCRATCH/runtime"
export ORCH_SINGLETON_LOCK_FILE="$SCRATCH/orchestrator.singleton.lock"
export ORCH_INSTANCE_LOCK_FILE="$SCRATCH/instance.lock"
export ORCH_LOCK_FILE="$SCRATCH/launch.lock"
export ORCH_STATE_DB="$SCRATCH/state.db"
export ORCH_LEASE_FILE="$SCRATCH/orchestrator.lease"
export ORCH_OPS_JOURNAL="$SCRATCH/ops-journal.log"
export ORCH_PROVIDER=codex
export ORCH_SESSION="launcher-from-git-$$"
export ORCH_WORK_DIR="$REPO"
export ORCH_READINESS_WINDOW_MS=300
# Fixture tmux is a PATH shim onto a private socket; there is no real server to
# place. Placement has its own capability-gated rehearsal in tmux-isolation.test.sh.
export ORCH_TMUX_ISOLATION=none
unset ORCH_AUTH_PREFLIGHT ORCH_MISSION_CLI ORCH_CLAUDE_CRED_FILE

state_cli() { INFRA_STATE_DB="$ORCH_STATE_DB" "$BUN_BIN_RESOLVED" "$REPO/core/mission-cli.ts" "$@"; }
# Exactly how bootstrap/install.sh:initialize_state_db creates one -- which is
# what armed hole 1 on the live host.
reset_state_db() { rm -f "$ORCH_STATE_DB" "$ORCH_LEASE_FILE"; state_cli status >/dev/null; }
reset_singleton() { rm -f "$ORCH_SINGLETON_LOCK_FILE" "$ORCH_SINGLETON_LOCK_FILE".* "$ORCH_LOCK_FILE"; }
lease_holder() {
  state_cli status | "$BUN_BIN_RESOLVED" -e '
const status = JSON.parse(await Bun.stdin.text());
const lease = (status.leases ?? []).find((entry) => entry.key === "orchestrator");
process.stdout.write(lease ? `${lease.owner} ${lease.fencingToken}` : "");
'
}

# ───────────────────────────────────────────────────────────────────────────
# 1. The mechanisms the launcher requires are TRACKED, at the paths it defaults to.
# ───────────────────────────────────────────────────────────────────────────
git -C "$REPO" ls-files --error-unmatch orchestrator/preflight-cli-auth.sh >/dev/null 2>&1
check "the auth preflight is a tracked file" $? \
  'launch.sh defaults AUTH_PREFLIGHT to $SCRIPT_DIR/preflight-cli-auth.sh'

[[ -x "$SCRIPT_DIR/preflight-cli-auth.sh" ]]
check "the auth preflight is executable in the tree" $? \
  'launch.sh refuses with exit 2 unless [[ -x ]]'

# It must also be executable AS COMMITTED: a clean clone restores the mode bit
# from the index, so a file that is only chmod +x in this worktree would be
# refused on the rebuilt host and nowhere else.
[[ "$(git -C "$REPO" ls-files -s orchestrator/preflight-cli-auth.sh | cut -d' ' -f1)" == 100755 ]]
check "the auth preflight is committed with its executable bit" $? \
  'git mode must be 100755, or a clean clone cannot run it'

[[ ! -e "$ORCH_CONFIG_FILE" ]]
check "the rehearsal really runs with no runtime.env" $? "$ORCH_CONFIG_FILE exists"

[[ -z "${ORCH_AUTH_PREFLIGHT:-}" && -z "${ORCH_MISSION_CLI:-}" ]]
check "no break-glass override is exported into the rehearsal" $?

# ───────────────────────────────────────────────────────────────────────────
# 2. The launcher reaches the auth gate, which means it got PAST reap and lease.
#
# launch.sh runs `mission_cli reap`, `mission_cli status` and the lease-held
# check BEFORE the auth preflight. Under `set -e` an unknown action aborts the
# script there, so the auth gate's own refusal is positive proof that the whole
# state-database block executed. This case needs no session and no /proc/locks,
# so it runs everywhere -- including the meteorite container.
# ───────────────────────────────────────────────────────────────────────────
reset_state_db
reset_singleton
ORCH_CODEX_AUTH_FILE="$SCRATCH/codex-metered.json" bash "$LAUNCH" start >"$SCRATCH/metered.out" 2>&1
metered_status=$?
(( metered_status == 2 ))
check "a launch with metered credentials is refused with the auth gate's exit 2" $? \
  "exit=$metered_status output: $(tr '\n' ' ' < "$SCRATCH/metered.out")"

grep -q 'refusing API-key auth' "$SCRATCH/metered.out"
check "the refusal is the TRACKED preflight's own, not a missing-file stub" $? \
  "output: $(tr '\n' ' ' < "$SCRATCH/metered.out")"

! grep -q 'auth preflight missing or not executable' "$SCRATCH/metered.out"
check "the launcher no longer reports its auth gate missing" $?

# The red-before, stated as an assertion rather than a story: this exact string
# is what the V3-5.36 container stage measured (`launch-refused:error-unknown-action`).
! grep -q 'unknown action' "$SCRATCH/metered.out"
check "the launcher no longer dies on an unknown mission-cli action" $? \
  "output: $(tr '\n' ' ' < "$SCRATCH/metered.out")"

# ───────────────────────────────────────────────────────────────────────────
# 3. `reap` clears a dead holder, and does NOT clear a live one.
#
# The live regression: the previous orchestrator died inside its 180s TTL, so
# without a working reaper every restart refuses with `orchestrator-lease-held`
# until the lease ages out. The launcher's own reap call is the subject -- the
# lease is seeded through the CLI and read back through the CLI, but nothing
# calls reap except launch.sh.
# ───────────────────────────────────────────────────────────────────────────
reset_state_db
reset_singleton
dead_pid_holder() { # a PID on this host that is provably gone
  local pid
  ( exit 0 ) & pid=$!
  wait "$pid" 2>/dev/null
  printf '%s:%s\n' "$(hostname)" "$pid"
}
dead_owner="$(dead_pid_holder)"
state_cli lease acquire "$dead_owner" orchestrator 180000 >/dev/null 2>&1
[[ "$(lease_holder)" == "$dead_owner 1" ]]
seeded_dead=$?
# Guarded, because every assertion below is about what the launcher DID to this
# lease. With no lease seeded they would all read as "nothing held it" and pass
# vacuously -- which is exactly what they do against the pre-fix tree, where the
# seeding itself dies on `unknown action: lease acquire`.
check "the dead-holder fixture really seeded a live lease" $seeded_dead "holder: $(lease_holder)"
if (( seeded_dead == 0 )); then
  ORCH_CODEX_AUTH_FILE="$SCRATCH/codex-metered.json" bash "$LAUNCH" start >"$SCRATCH/deadlease.out" 2>&1
  deadlease_status=$?
  (( deadlease_status == 2 ))
  check "a dead holder's unexpired lease no longer blocks a start" $? \
    "exit=$deadlease_status output: $(tr '\n' ' ' < "$SCRATCH/deadlease.out")"

  ! grep -q 'orchestrator-lease-held' "$SCRATCH/deadlease.out"
  check "the launcher does not report a corpse as the lease holder" $?

  [[ -z "$(lease_holder)" ]]
  check "the launcher's reap released the dead holder's lease" $? "holder: $(lease_holder)"
fi

# The fence must still bite. A reaper that clears everything is not a fix, it is
# the singleton guard removed.
reset_state_db
reset_singleton
live_owner="$(hostname):$$"
state_cli lease acquire "$live_owner" orchestrator 180000 >/dev/null 2>&1
[[ "$(lease_holder)" == "$live_owner 1" ]]
seeded_live=$?
check "the live-holder fixture really seeded a live lease" $seeded_live "holder: $(lease_holder)"
if (( seeded_live == 0 )); then
  ORCH_CODEX_AUTH_FILE="$SCRATCH/codex-subscription.json" bash "$LAUNCH" start >"$SCRATCH/livelease.out" 2>&1
  livelease_status=$?
  # Held to the REFUSAL, not only to the exit status. Exit 1 is also what a
  # launcher that died on `unknown action` returns, so the status alone would
  # accept the broken launcher as evidence that the fence works.
  grep -q "ERROR orchestrator-lease-held owner=$live_owner" "$SCRATCH/livelease.out"
  check "a LIVE holder's lease still refuses the start, by name" $? \
    "exit=$livelease_status output: $(tr '\n' ' ' < "$SCRATCH/livelease.out")"

  (( livelease_status == 1 ))
  check "the lease-held refusal exits 1" $? "exit=$livelease_status"

  [[ "$(lease_holder)" == "$live_owner 1" ]]
  check "the refused start left the live lease exactly where it was" $? "holder: $(lease_holder)"
fi

# ───────────────────────────────────────────────────────────────────────────
# 4. LIVE REHEARSAL: a whole start, from a repository-only tree.
#
# Everything above stops at the auth gate. This runs the launcher all the way
# through, which is the only way to exercise `lease acquire` and the two
# `lease renew` probes that follow it -- a failed renew tears the session down
# and returns 1, so a start that returns 0 is proof that all three succeeded.
#
# Capability-gated on /proc/locks visibility. launch.sh verifies its singleton
# owner by finding the FLOCK row for its lock file there, and /proc/locks is
# namespace-filtered: inside a container it lists nothing, so the launcher fails
# closed with `orchestrator-singleton-owner-unverified` and no start is possible
# at all (measured by the V3-5.36 container stage). The case announces its own
# exclusion rather than passing quietly.
# ───────────────────────────────────────────────────────────────────────────
proc_locks_visible() {
  local probe="$SCRATCH/proc-locks-probe" fd
  : > "$probe"
  exec {fd}>"$probe"
  flock -n "$fd" || { exec {fd}>&-; return 1; }
  local key inode
  inode="$(stat -c '%i' "$probe")"
  # Matched on the probe file's inode, never on a PID: the kernel attributes an
  # flock row to whichever task took it, which is not necessarily this shell.
  # The question here is only whether /proc/locks shows this namespace's locks
  # at all -- launch.sh does its own, stricter owner resolution.
  key="$(awk -v inode="$inode" '$2 == "FLOCK" { split($6, k, ":"); if (k[3] == inode) print "yes" }' /proc/locks 2>/dev/null | head -n 1)"
  exec {fd}>&-
  [[ "$key" == yes ]]
}

if ! proc_locks_visible; then
  printf '%s\n' 'launcher-startable-from-git: EXCLUDED case=full-start capability=proc-locks-visibility'
else
  reset_state_db
  reset_singleton
  rm -f "$ORCH_TEST_PROVIDER_PID"
  ORCH_CODEX_AUTH_FILE="$SCRATCH/codex-subscription.json" bash "$LAUNCH" start >"$SCRATCH/start.out" 2>&1
  start_status=$?
  (( start_status == 0 ))
  check "launch.sh start succeeds against a real state DB with no break-glass" $? \
    "exit=$start_status output: $(tr '\n' ' ' < "$SCRATCH/start.out")"

  if (( start_status == 0 )); then
    provider_pid="$(cat "$ORCH_TEST_PROVIDER_PID" 2>/dev/null || true)"
    [[ "$(lease_holder)" == "$(hostname):$provider_pid 1" ]]
    check "the launcher acquired the orchestrator lease for its own provider" $? \
      "holder: $(lease_holder) provider_pid: $provider_pid"

    # The launcher renews twice before returning; a failed renew is a teardown
    # and a non-zero exit, so reaching here with a live lease proves both.
    grep -q "^owner=$(hostname):$provider_pid$" "$ORCH_LEASE_FILE" &&
      grep -q '^token=1$' "$ORCH_LEASE_FILE"
    check "the durable lease and the launcher's lease file agree" $? \
      "lease file: $(tr '\n' ' ' < "$ORCH_LEASE_FILE" 2>/dev/null)"

    bash "$LAUNCH" stop >"$SCRATCH/stop.out" 2>&1
    stop_status=$?
    (( stop_status == 0 ))
    check "launch.sh stop succeeds" $? "exit=$stop_status output: $(tr '\n' ' ' < "$SCRATCH/stop.out")"

    [[ -z "$(lease_holder)" ]]
    check "stop released the orchestrator lease" $? "holder: $(lease_holder)"

    [[ ! -e "$ORCH_LEASE_FILE" ]]
    check "stop removed the launcher's lease file" $?
  fi
fi

if (( failures > 0 )); then
  printf 'launcher-startable-from-git: %d FAILED\n' "$failures"
  exit 1
fi
printf 'launcher-startable-from-git: PASS\n'
