#!/usr/bin/env bash
# Regression lock: the singleton guard's OBSERVATION boundary (V3-5.38).
#
# launch.sh proves which process took the singleton lock by reading /proc/locks.
# That read works only in the initial pid namespace: fs/locks.c drops a row whose
# owner pid it cannot translate into the namespace of the procfs being read, and
# the launcher's lock is taken by a `flock -n` that exits immediately, so the row
# it needs is exactly the one only init_pid_ns keeps. Inside any container the
# guard therefore cannot observe its own subject.
#
# What this locks is the split that answer forces:
#   * exclusion is flock's and holds everywhere -- a second launcher is refused
#     in BOTH worlds, and that is asserted in both;
#   * ownership EVIDENCE is unavailable in a namespace, so the launcher records
#     a sentinel, says so, and starts;
#   * with the sentinel recorded, automatic stale-lock recovery can never be
#     proven -- a leaked lock stays an operator decision;
#   * where the kernel DOES attribute locks, an unresolvable owner is still a
#     hard refusal, so the degradation cannot be reached on a real host;
#   * and BROKEN TOOLING is never mistaken for a kernel boundary. This is the
#     r2 addition. Round 1's adjudicating probe resolved its own probe file
#     through singleton_lock_key() -- the very helper whose failure is one of
#     the two degradation triggers -- so a globally failing findmnt made the
#     trigger fire and guaranteed the probe would agree with it. A fully
#     attributing host silently started degraded where it had always refused.
#     Two cases below pin the repair: the probe answers `available` under a
#     globally broken findmnt, and `start` refuses in that world in BOTH
#     worlds rather than degrading in either.
#
# Unshared pid+mount namespaces stand in for docker here: the kernel path under
# test is the namespace translation itself, which is identical either way.
set -euo pipefail

SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(dirname "$SCRIPT_PATH")"
LAUNCH="$SCRIPT_DIR/launch.sh"
FINDMNT_BIN="$(command -v findmnt || true)"

capability_forced_missing() {
  [[ ",${INFRA_TEST_FORCE_MISSING_CAPABILITIES:-}," == *",$1,"* ]]
}

# ── The driver's own oracle, owing nothing to the subject under test ─────────
# Deliberately NOT `launch.sh singleton-attribution`. A driver that classifies
# its world by asking the binary under test cannot tell "this world is blind"
# from "the subject is broken or does not implement that question yet" -- and
# it resolves both to a silent EXCLUDED. Run against the pre-V3-5.38 tree the
# old driver exited 2 on `Usage:` and reported the host half EXCLUDED, so the
# lock's red-before was never the regression. With an independent oracle the
# same run is a named FAILURE of the subject, which is what it is.
#
# Same question, minimal parts: take a flock through a child that exits, then
# ask /proc/locks whether the row still names that child.
world_attributes_locks() {
  local dir fd pid found=1
  local -a fields=()
  [[ -r /proc/locks ]] || return 1
  dir="$(mktemp -d)"
  exec {fd}>"$dir/probe"
  flock -n "$fd" &
  pid=$!
  if ! wait "$pid"; then
    exec {fd}>&-
    rm -rf "$dir"
    return 1
  fi
  while read -ra fields; do
    if [[ "${fields[1]:-}" == FLOCK && "${fields[4]:-}" == "$pid" ]]; then
      found=0
      break
    fi
  done < /proc/locks
  exec {fd}>&-
  rm -rf "$dir"
  return "$found"
}

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

SCRATCH=""
SOCKET=""
HOLDER_PID=""
HOLDER_RELEASE=""

cleanup() {
  [[ -z "$HOLDER_RELEASE" ]] || : > "$HOLDER_RELEASE" 2>/dev/null || true
  [[ -z "$HOLDER_PID" ]] || kill "$HOLDER_PID" 2>/dev/null || true
  [[ -z "$SOCKET" ]] || tmux -L "$SOCKET" kill-server 2>/dev/null || true
  [[ -z "$SCRATCH" ]] || rm -rf "$SCRATCH"
}

provider_count() {
  [[ -f "${ORCH_TEST_PROVIDER_PIDS:-}" ]] || { printf '0\n'; return; }
  wc -l < "$ORCH_TEST_PROVIDER_PIDS"
}

await_gone() {
  local pid="$1" _
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.1
  done
  return 1
}

# ── Scenario ────────────────────────────────────────────────────────────────
# Runs in whichever world it is invoked in; `mode` states which one that is, so
# a world that does not behave as claimed fails rather than quietly adapting.
scenario() {
  local mode="$1" tag="$2"
  [[ "$mode" == observable || "$mode" == blind ]] || fail "unknown scenario mode: $mode"
  [[ -n "$FINDMNT_BIN" ]] || fail 'findmnt is required to resolve a lock identity'

  trap cleanup EXIT
  SCRATCH="$(mktemp -d)"
  SOCKET="singleton-nsboundary-$tag"
  local shim="$SCRATCH/bin"
  local singleton_lock="$SCRATCH/orchestrator.singleton.lock"

  # The fixture owns its world: private tmux socket IN ITS OWN SCRATCH DIR,
  # private HOME, no systemd, no state DB, a fixed umask. Nothing here reads
  # host configuration and nothing survives the scratch dir. TMUX_TMPDIR is
  # what keeps the second half of that true: a `-L` socket otherwise lands in
  # the shared /tmp/tmux-$UID and the file outlives `kill-server`, so a lock
  # that is otherwise perfectly hermetic still litters one entry per run.
  umask 022
  export TMUX_TMPDIR="$SCRATCH"
  mkdir -p "$shim" "$SCRATCH/home"
  cat > "$shim/tmux" <<'EOF'
#!/usr/bin/env bash
exec /usr/bin/tmux -L "${ORCH_TEST_TMUX_SOCKET:?}" "$@"
EOF
  cat > "$shim/systemd-run" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' 'Failed to connect to user scope bus via local transport' >&2
exit 1
EOF
  cat > "$shim/codex" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$$" >> "${ORCH_TEST_PROVIDER_PIDS:?}"
exec sleep 1000
EOF
  # Two distortion modes, because the guard's two triggers are NOT one failure
  # and r2 exists because round 1 treated them as one:
  #   ORCH_TEST_FINDMNT_WRONG_DEV=<path> -- reports a plausible but wrong
  #     device for one exact path. singleton_lock_key() then SUCCEEDS and
  #     returns a well-formed key that matches no row in /proc/locks, which is
  #     the real "this kernel attributes locks, but will not name THIS one"
  #     anomaly -- an unnameable owner with the identity path intact.
  #   ORCH_TEST_FINDMNT_DENY_ALL=1 -- findmnt broken outright, the util-linux
  #     absence of a minimal image. This takes out singleton_lock_key()
  #     globally, which is BOTH a degradation trigger and, in round 1, the
  #     adjudicating probe's own dependency.
  cat > "$shim/findmnt" <<EOF
#!/usr/bin/env bash
[[ -n "\${ORCH_TEST_FINDMNT_DENY_ALL:-}" ]] && exit 1
for arg in "\$@"; do
  if [[ "\$arg" == "\${ORCH_TEST_FINDMNT_WRONG_DEV:-}" ]]; then
    printf '999:999\n'
    exit 0
  fi
done
exec $(printf '%q' "$FINDMNT_BIN") "\$@"
EOF
  cat > "$SCRATCH/preflight.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  chmod +x "$shim/tmux" "$shim/systemd-run" "$shim/codex" "$shim/findmnt" \
    "$SCRATCH/preflight.sh"

  export PATH="$shim:$PATH"
  export HOME="$SCRATCH/home"
  export ORCH_TEST_TMUX_SOCKET="$SOCKET"
  export ORCH_CONFIG_FILE="$SCRATCH/no-runtime.env"
  export ORCH_STATE_DB="$SCRATCH/absent/state.db"
  export ORCH_INSTANCE_LOCK_FILE="$SCRATCH/instance.lock"
  export ORCH_SINGLETON_LOCK_FILE="$singleton_lock"
  export ORCH_LIVENESS_FILE="$SCRATCH/orchestrator.liveness"
  export ORCH_TEST_PROVIDER_PIDS="$SCRATCH/provider-pids"
  export ORCH_PROVIDER=codex
  export ORCH_TMUX_ISOLATION=none
  export ORCH_AUTH_PREFLIGHT="$SCRATCH/preflight.sh"

  # ── The guard's own verdict must match the world it is standing in ────────
  # The expected value comes from world_attributes_locks(), an oracle the
  # subject does not supply, so a subject that cannot answer at all fails here
  # by name instead of being classified as some other world.
  local verdict expected_verdict
  verdict="$(ORCH_RUNTIME_DIR="$SCRATCH/runtime-probe" bash "$LAUNCH" singleton-attribution 2>&1 ||
    printf ' <subject exited non-zero>')"
  case "$mode" in
    observable) expected_verdict='singleton-owner-attribution: available' ;;
    blind) expected_verdict='singleton-owner-attribution: unavailable' ;;
  esac
  [[ "$verdict" == "$expected_verdict" ]] ||
    fail "$mode world reported the wrong attribution verdict: $verdict"
  printf 'singleton-nsboundary: RAN case=attribution-verdict mode=%s\n' "$mode"

  # ── The probe must not share a failure mode with what it adjudicates ──────
  # Round 1 answered `unavailable` here on a fully attributing host, because it
  # resolved its own probe file through singleton_lock_key(). The verdict must
  # be unchanged by a helper that has nothing to do with the kernel's willingness
  # to attribute a lock.
  local broken_key_verdict
  broken_key_verdict="$(ORCH_TEST_FINDMNT_DENY_ALL=1 \
    ORCH_RUNTIME_DIR="$SCRATCH/runtime-probe-nokey" bash "$LAUNCH" singleton-attribution 2>&1 ||
    printf ' <subject exited non-zero>')"
  [[ "$broken_key_verdict" == "$expected_verdict" ]] ||
    fail "a broken findmnt changed the $mode world's attribution verdict to: $broken_key_verdict"
  printf 'singleton-nsboundary: RAN case=probe-independent-of-lock-key mode=%s\n' "$mode"

  # ── ...and must not be forgeable by squatting its path ────────────────────
  # Round 1's probe file was $RUNTIME_DIR/.singleton-attribution-probe.$$ --
  # pid-derived, therefore predictable. A directory pre-created there defeated
  # both the `rm -f` and the `: >`, and the probe reported `unavailable` on an
  # attributing host. `exec` below preserves the pid, so the squat lands on the
  # exact path the probe would have chosen.
  local squat_verdict
  squat_verdict="$(ORCH_RUNTIME_DIR="$SCRATCH/runtime-probe-squat" bash -c \
    'mkdir -p "$ORCH_RUNTIME_DIR/.singleton-attribution-probe.$$"
     exec bash "$1" singleton-attribution' _ "$LAUNCH" 2>&1 ||
    printf ' <subject exited non-zero>')"
  [[ "$squat_verdict" == "$expected_verdict" ]] ||
    fail "a squatted probe path changed the $mode world's verdict to: $squat_verdict"
  printf 'singleton-nsboundary: RAN case=probe-path-not-squattable mode=%s\n' "$mode"

  # ── Broken tooling is a REFUSAL, in every world ───────────────────────────
  # This is the r2 regression lock. With findmnt failing outright the launcher
  # cannot identify its own lock file -- which says nothing about the kernel,
  # so the pre-V3-5.38 hard refusal stands. Round 1 started here on this host,
  # printing a WARN that blamed a namespace boundary that did not exist.
  local nokey_output nokey_status
  export ORCH_SESSION=nsboundary-nokey ORCH_RUNTIME_DIR="$SCRATCH/runtime-nokey"
  export ORCH_TEST_PROVIDER_PIDS="$SCRATCH/provider-pids-nokey"
  export ORCH_TEST_FINDMNT_DENY_ALL=1
  set +e
  nokey_output="$(timeout 60 bash "$LAUNCH" start 2>&1)"
  nokey_status=$?
  set -e
  unset ORCH_TEST_FINDMNT_DENY_ALL
  export ORCH_TEST_PROVIDER_PIDS="$SCRATCH/provider-pids"
  (( nokey_status != 0 )) ||
    fail "$mode world started with no resolvable lock identity: $nokey_output"
  grep -q '^ERROR orchestrator-singleton-owner-unverified .*reason=lock-key-unresolved' \
    <<<"$nokey_output" ||
    fail "expected a lock-key-unresolved refusal (rc=$nokey_status), got: $nokey_output"
  if grep -q 'orchestrator-singleton-owner-unattributable' <<<"$nokey_output"; then
    fail "broken tooling was reported as a kernel boundary: $nokey_output"
  fi
  [[ ! -e "$singleton_lock.owner" ]] ||
    fail 'a refused launch recorded an owner file'
  if tmux -L "$SOCKET" has-session -t nsboundary-nokey 2>/dev/null; then
    fail 'refused no-lock-key session remained running'
  fi
  printf 'singleton-nsboundary: RAN case=broken-lock-key-still-refuses mode=%s\n' "$mode"

  # ── Where attribution works, an unnameable owner is STILL a hard refusal ──
  # The degradation must be unreachable on a real host. Misreporting the device
  # of the singleton lock alone keeps its identity resolvable and its /proc/locks
  # row unfindable, which is the ownership anomaly proper.
  local expected_providers=0
  if [[ "$mode" == observable ]]; then
    local anomaly_output anomaly_status
    # Its own counter file. The launcher validates ownership as soon as the pane
    # publishes its pid, which is BEFORE that pane execs the provider, so
    # whether this refusal raced past a provider exec is genuinely undefined --
    # and must not be allowed to perturb the exact counts asserted below.
    export ORCH_SESSION=nsboundary-anomaly ORCH_RUNTIME_DIR="$SCRATCH/runtime-anomaly"
    export ORCH_TEST_PROVIDER_PIDS="$SCRATCH/provider-pids-anomaly"
    export ORCH_TEST_FINDMNT_WRONG_DEV="$singleton_lock"
    set +e
    anomaly_output="$(timeout 60 bash "$LAUNCH" start 2>&1)"
    anomaly_status=$?
    set -e
    unset ORCH_TEST_FINDMNT_WRONG_DEV
    export ORCH_TEST_PROVIDER_PIDS="$SCRATCH/provider-pids"
    (( anomaly_status != 0 )) ||
      fail "an unnameable lock owner started anyway on an attributing host: $anomaly_output"
    grep -q '^ERROR orchestrator-singleton-owner-unverified .*reason=owner-unnameable' \
      <<<"$anomaly_output" ||
      fail "expected the unchanged hard refusal, got (rc=$anomaly_status): $anomaly_output"
    if grep -q 'orchestrator-singleton-owner-unattributable' <<<"$anomaly_output"; then
      fail "an attributing host took the degraded path: $anomaly_output"
    fi
    [[ ! -e "$singleton_lock.owner" ]] ||
      fail 'a refused launch recorded an owner file'
    if tmux -L "$SOCKET" has-session -t nsboundary-anomaly 2>/dev/null; then
      fail 'refused anomaly session remained running'
    fi
    printf 'singleton-nsboundary: RAN case=observable-anomaly-still-refuses\n'
  fi

  # ── First launch must SUCCEED in both worlds ──────────────────────────────
  # This is the red-before/green-after case: before V3-5.38 the blind world
  # refused here with orchestrator-singleton-owner-unverified.
  local first_output first_status first_provider_pid first_provider_starttime
  export ORCH_SESSION=nsboundary-first ORCH_RUNTIME_DIR="$SCRATCH/runtime-first"
  set +e
  first_output="$(env -u DBUS_SESSION_BUS_ADDRESS -u XDG_RUNTIME_DIR \
    timeout 60 bash "$LAUNCH" start 2>&1)"
  first_status=$?
  set -e
  (( first_status == 0 )) ||
    fail "$mode world refused a first launch (rc=$first_status): $first_output"
  tmux -L "$SOCKET" has-session -t nsboundary-first ||
    fail 'first launch did not spawn a detached tmux session'
  expected_providers=$(( expected_providers + 1 ))
  [[ "$(provider_count)" == "$expected_providers" ]] ||
    fail "first launch reported success before the provider exec boundary: $(provider_count)"
  first_provider_pid="$(tail -n 1 "$ORCH_TEST_PROVIDER_PIDS")"
  kill -0 "$first_provider_pid" 2>/dev/null ||
    fail 'first launch left only a pane shell, not a live provider'
  first_provider_starttime="$(awk '{print $22}' "/proc/$first_provider_pid/stat")"

  local recorded_owner
  recorded_owner="$(sed -n 's/^lock_owner_pid=//p' "$singleton_lock.owner")"
  case "$mode" in
    observable)
      [[ "$recorded_owner" =~ ^[1-9][0-9]*$ ]] ||
        fail "an attributing host recorded a non-numeric lock owner: $recorded_owner"
      if grep -q 'orchestrator-singleton-owner-unattributable' <<<"$first_output"; then
        fail "an attributing host announced a degradation: $first_output"
      fi
      ;;
    blind)
      [[ "$recorded_owner" == unattributable ]] ||
        fail "a blind world recorded lock_owner_pid=$recorded_owner instead of the sentinel"
      grep -q '^WARN orchestrator-singleton-owner-unattributable ' <<<"$first_output" ||
        fail "a blind world degraded without saying so: $first_output"
      ;;
  esac
  printf 'singleton-nsboundary: RAN case=first-launch mode=%s\n' "$mode"

  # ── Two owners stay impossible — in BOTH worlds ───────────────────────────
  local live_lock_inode second_output second_status
  live_lock_inode="$(stat -Lc '%d:%i' "$singleton_lock")"
  export ORCH_SESSION=nsboundary-second ORCH_RUNTIME_DIR="$SCRATCH/runtime-second"
  set +e
  second_output="$(timeout 60 bash "$LAUNCH" start 2>&1)"
  second_status=$?
  set -e
  (( second_status != 0 )) ||
    fail "$mode world admitted a second orchestrator"
  grep -q '^ERROR orchestrator-singleton-held .*recovery=unproven' <<<"$second_output" ||
    fail "second launch did not report singleton refusal: $second_output"
  if tmux -L "$SOCKET" has-session -t nsboundary-second 2>/dev/null; then
    fail 'refused second session remained running'
  fi
  [[ "$(stat -Lc '%d:%i' "$singleton_lock")" == "$live_lock_inode" ]] ||
    fail 'live singleton holder was bypassed by rotating the lock inode'
  [[ "$(provider_count)" == "$expected_providers" ]] ||
    fail "singleton refusal executed another provider: $(provider_count)"
  kill -0 "$first_provider_pid" 2>/dev/null ||
    fail 'singleton refusal killed the live provider'
  printf 'singleton-nsboundary: RAN case=second-launch-refused mode=%s\n' "$mode"

  # ── A blind world never auto-recovers, however recoverable it looks ───────
  # The state built here is the one that DOES recover on an attributing host
  # (orchestrator/singleton-failclosed.test.sh, case stale-ofd-recovery): the
  # recorded provider is provably gone and a live holder has the lock. Without
  # an owner pid the kernel will confirm, it must still refuse.
  if [[ "$mode" == blind ]]; then
    tmux -L "$SOCKET" kill-session -t nsboundary-first
    await_gone "$first_provider_pid" || fail 'fixture provider did not exit with its session'

    local ready="$SCRATCH/holder.ready" lock_key
    HOLDER_RELEASE="$SCRATCH/holder.release"
    (
      exec 7>"$singleton_lock"
      flock 7
      : > "$ready"
      while [[ ! -f "$HOLDER_RELEASE" ]]; do sleep 0.01; done
    ) &
    HOLDER_PID=$!
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
      [[ -f "$ready" ]] && break
      sleep 0.05
    done
    [[ -f "$ready" ]] || fail 'leaked-lock fixture never acquired the singleton lock'

    lock_key="$(findmnt -T "$singleton_lock" -n -o MAJ:MIN | tr -d '[:space:]')"
    lock_key="$lock_key:$(stat -Lc '%i' "$singleton_lock")"
    printf 'provider_pid=%s\nprovider_starttime=%s\nlock_owner_pid=unattributable\nlock_key=%s\n' \
      "$first_provider_pid" "$first_provider_starttime" "$lock_key" \
      > "$singleton_lock.owner"

    local leaked_output leaked_status leaked_inode
    leaked_inode="$(stat -Lc '%d:%i' "$singleton_lock")"
    export ORCH_SESSION=nsboundary-leaked ORCH_RUNTIME_DIR="$SCRATCH/runtime-leaked"
    set +e
    leaked_output="$(timeout 60 bash "$LAUNCH" start 2>&1)"
    leaked_status=$?
    set -e
    (( leaked_status != 0 )) ||
      fail "a blind world auto-recovered a lock it cannot prove leaked: $leaked_output"
    grep -q '^ERROR orchestrator-singleton-held .*recovery=unproven owner-attribution=unavailable' \
      <<<"$leaked_output" ||
      fail "the refusal did not name the missing evidence: $leaked_output"
    [[ "$(stat -Lc '%d:%i' "$singleton_lock")" == "$leaked_inode" ]] ||
      fail 'a refused recovery rotated the lock inode anyway'
    [[ "$(provider_count)" == "$expected_providers" ]] ||
      fail "a refused recovery started a provider: $(provider_count)"
    printf 'singleton-nsboundary: RAN case=blind-recovery-refused\n'
  fi
}

if [[ "${1:-}" == --scenario ]]; then
  scenario "${2:?scenario mode}" "${3:?scenario tag}"
  exit 0
fi

# ── Driver ──────────────────────────────────────────────────────────────────
run_tag="$$"

if capability_forced_missing proc-lock-observability || ! world_attributes_locks; then
  # This suite also runs inside the rebuilt container, where the ambient world
  # IS the blind one. Say so rather than asserting host behavior that cannot
  # hold there. The classification is the oracle's, not the subject's.
  printf '%s\n' 'singleton-nsboundary: EXCLUDED case=attributing-host capability=proc-lock-observability'
else
  bash "$SCRIPT_PATH" --scenario observable "host-$run_tag"
fi

if capability_forced_missing pid-mount-namespace ||
   ! unshare --pid --fork --mount-proc true 2>/dev/null; then
  printf '%s\n' 'singleton-nsboundary: EXCLUDED case=blind-namespace capability=pid-mount-namespace'
else
  unshare --pid --fork --mount-proc bash "$SCRIPT_PATH" --scenario blind "ns-$run_tag"
fi

printf 'singleton namespace-boundary tests: PASS\n'
