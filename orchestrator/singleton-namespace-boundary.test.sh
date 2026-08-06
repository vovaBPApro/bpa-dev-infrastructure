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
#   * and -- the r3 addition -- a MISSING /proc/locks ROW IS NOT A KERNEL
#     VERDICT UNTIL A REAL LOCK IS PROVEN TO EXIST. r2 removed
#     singleton_lock_key() from the probe but left `flock` shared between the
#     trigger and the adjudicator, and `flock` has a failure mode shaped like
#     success: exit 0 with no lock taken. No lock means no row, which the r2
#     probe reported as `unavailable` -- a kernel verdict -- while the same
#     broken flock removed the launcher's own row and fired the trigger. The
#     guard then degraded on its stated premise, "flock is already holding the
#     singleton", in the one world where that premise is false, and the
#     reviewer measured two live orchestrators under one lock path. The cases
#     below pin the repair: `unavailable` now requires positive proof of
#     exclusion through an independent contender, proven in both directions,
#     and a non-excluding flock refuses at `start` in BOTH worlds.
#
# Unshared pid+mount namespaces stand in for docker here: the kernel path under
# test is the namespace translation itself, which is identical either way.
set -euo pipefail

SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(dirname "$SCRIPT_PATH")"
LAUNCH="$SCRIPT_DIR/launch.sh"
FINDMNT_BIN="$(command -v findmnt || true)"
FLOCK_BIN="$(command -v flock || true)"

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
ALT_SOCKET=""
HOLDER_PID=""
HOLDER_RELEASE=""

cleanup() {
  [[ -z "$HOLDER_RELEASE" ]] || : > "$HOLDER_RELEASE" 2>/dev/null || true
  [[ -z "$HOLDER_PID" ]] || kill "$HOLDER_PID" 2>/dev/null || true
  [[ -z "$SOCKET" ]] || tmux -L "$SOCKET" kill-server 2>/dev/null || true
  [[ -z "$ALT_SOCKET" ]] || tmux -L "$ALT_SOCKET" kill-server 2>/dev/null || true
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
  [[ -n "$FLOCK_BIN" ]] || fail 'flock is required to exclude a second launcher'

  trap cleanup EXIT
  SCRATCH="$(mktemp -d)"
  SOCKET="singleton-nsboundary-$tag"
  ALT_SOCKET="singleton-nsboundary-alt-$tag"
  local shim="$SCRATCH/bin"
  local flock_shim="$SCRATCH/flockbin"
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
  # ── A flock that does not exclude ─────────────────────────────────────────
  # Kept OUT of the main shim dir and prepended per-invocation, so every other
  # case in this file runs the real flock and nothing here can silently weaken
  # the exclusion the rest of the suite asserts. Modes:
  #   silent -- exits 0 and takes no lock. The r2 defect exactly: no lock,
  #             therefore no /proc/locks row, which the r2 probe reported as a
  #             kernel verdict. This is the mandatory red-before case.
  #   deny   -- exits 1 always. A loud failure; acquisition itself fails.
  #   once   -- exits 0 for the first call and 1 for every call after. This one
  #             exists solely to make the probe's NEGATIVE control load-bearing.
  #             It passes the "an independent contender must be denied" check by
  #             being incapable of ever succeeding, so only the post-release
  #             control -- where the contender must SUCCEED -- catches it. Drop
  #             step (4) from the probe and this case degrades.
  #   pane   -- no-ops ONLY the pane's own acquisition (`flock -n 8`, the fd the
  #             pane command opens the singleton lock on) and is the real flock
  #             for everyone else. This is the one world where the probe is
  #             perfectly healthy and its answer is still not enough: it proves
  #             the kernel attributes nothing, truthfully, while the lock the
  #             degraded branch claims is "already holding the singleton" was
  #             never taken. Two launchers in that world would both start.
  mkdir -p "$flock_shim"
  cat > "$flock_shim/flock" <<EOF
#!/usr/bin/env bash
case "\${ORCH_TEST_FLOCK_MODE:-}" in
  silent) exit 0 ;;
  deny) exit 1 ;;
  once)
    if [[ -e "\${ORCH_TEST_FLOCK_ONCE_COUNTER:?}" ]]; then exit 1; fi
    : > "\$ORCH_TEST_FLOCK_ONCE_COUNTER"
    exit 0
    ;;
  pane)
    # Exactly the pane's invocation, and nothing else: the launcher's own guard
    # and the probe use dynamically allocated descriptors (10+), never fd 8.
    if [[ "\$*" == "-n 8" ]]; then exit 0; fi
    ;;
esac
exec $(printf '%q' "$FLOCK_BIN") "\$@"
EOF
  cat > "$SCRATCH/preflight.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  chmod +x "$shim/tmux" "$shim/systemd-run" "$shim/codex" "$shim/findmnt" \
    "$flock_shim/flock" "$SCRATCH/preflight.sh"

  # A genuinely absent flock, not a shim pretending to be absent: a farm holding
  # everything the inherited PATH provides EXCEPT flock. Mirroring the real PATH
  # is what keeps this honest -- a hand-listed set of binaries rots into "the
  # six someone remembered in 2026", and the first thing it dropped here was
  # `bun`, whose absence killed launch.sh under `set -e` before it reached the
  # probe at all. Built BEFORE $shim is prepended below, so no fixture shim can
  # leak into it.
  local noflock="$SCRATCH/noflock" farm_dir farm_path farm_base
  mkdir -p "$noflock"
  for farm_dir in ${PATH//:/ }; do
    [[ -d "$farm_dir" ]] || continue
    for farm_path in "$farm_dir"/*; do
      farm_base="${farm_path##*/}"
      if [[ "$farm_base" == flock ]]; then continue; fi
      [[ -e "$noflock/$farm_base" ]] ||
        ln -s "$farm_path" "$noflock/$farm_base" 2>/dev/null || true
    done
  done
  [[ ! -e "$noflock/flock" ]] || fail 'the no-flock fixture still resolves a flock'
  # Assert the fixture is a working world before trusting what it reports: a
  # farm that lost the shell, or bun, fails the subject for the wrong reason and
  # would read as a pass of the case below.
  [[ -x "$noflock/bash" ]] || fail 'the no-flock fixture lost its shell'
  PATH="$noflock" command -v bun >/dev/null ||
    fail 'the no-flock fixture lost bun; launch.sh would die before probing'

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

  # ── `unavailable` requires PROOF that a real lock existed ─────────────────
  # The r3 regression lock, and the heart of it. In each world below no real
  # lock is ever taken, so /proc/locks carries no row -- indistinguishable, on
  # the row alone, from the blind namespace. The r2 probe answered `unavailable`
  # for all of them, which is a claim about the KERNEL made from evidence about
  # the PROBE. The only honest answer is that nothing was measured, and it must
  # be the answer in the observable world and the blind one alike: a broken
  # locker is not a namespace boundary in either.
  local flock_case flock_verdict
  for flock_case in silent deny once; do
    flock_verdict="$(ORCH_TEST_FLOCK_MODE="$flock_case" \
      ORCH_TEST_FLOCK_ONCE_COUNTER="$SCRATCH/flock-once-counter" \
      PATH="$flock_shim:$PATH" \
      ORCH_RUNTIME_DIR="$SCRATCH/runtime-probe-flock-$flock_case" \
      ORCH_SINGLETON_LOCK_FILE="$SCRATCH/probe-flock-$flock_case/s.lock" \
      bash "$LAUNCH" singleton-attribution 2>&1 ||
      printf ' <subject exited non-zero>')"
    [[ "$flock_verdict" == 'singleton-owner-attribution: undetermined' ]] ||
      fail "a non-excluding flock ($flock_case) produced a verdict about the kernel in the $mode world: $flock_verdict"
  done
  printf 'singleton-nsboundary: RAN case=probe-refuses-unproven-exclusion mode=%s\n' "$mode"

  # Same boundary, reached by losing flock outright rather than by it lying.
  local absent_verdict
  absent_verdict="$(PATH="$noflock" \
    ORCH_RUNTIME_DIR="$SCRATCH/runtime-probe-noflock" \
    ORCH_SINGLETON_LOCK_FILE="$SCRATCH/probe-noflock/s.lock" \
    bash "$LAUNCH" singleton-attribution 2>&1 ||
    printf ' <subject exited non-zero>')"
  [[ "$absent_verdict" == 'singleton-owner-attribution: undetermined' ]] ||
    fail "an absent flock produced a verdict about the kernel in the $mode world: $absent_verdict"
  printf 'singleton-nsboundary: RAN case=probe-refuses-without-flock mode=%s\n' "$mode"

  # ── ...and refuses when it cannot lay down a fixture at all ───────────────
  # The probe now proves exclusion on a file beside the real singleton lock, so
  # that it proves it on the filesystem whose semantics the guard is about to
  # trust. Where it cannot create that file it has measured nothing. The fixture
  # makes the probe directory UNUSABLE (a regular file stands where the
  # directory must be) rather than merely mode-0555: this suite runs as root on
  # this host, where permission bits would not stop the write and the case would
  # pass without ever exercising the branch. Unusable holds for every uid.
  local nodir_verdict
  : > "$SCRATCH/probe-dir-is-a-file"
  nodir_verdict="$(ORCH_RUNTIME_DIR="$SCRATCH/runtime-probe-nodir" \
    ORCH_SINGLETON_LOCK_FILE="$SCRATCH/probe-dir-is-a-file/s.lock" \
    bash "$LAUNCH" singleton-attribution 2>&1 ||
    printf ' <subject exited non-zero>')"
  [[ "$nodir_verdict" == 'singleton-owner-attribution: undetermined' ]] ||
    fail "an unusable probe directory produced a verdict about the kernel in the $mode world: $nodir_verdict"
  printf 'singleton-nsboundary: RAN case=probe-refuses-without-fixture mode=%s\n' "$mode"

  # ── A non-excluding flock must REFUSE AT START, in both worlds ────────────
  # The measured harm, not just the diagnostic. At r2's SHA this world started
  # rc=0 with `WARN ...-owner-unattributable`, and a second launcher started too
  # -- two live orchestrators under one lock path, on a fully attributing host,
  # each announcing that exclusion held. The shim is in the environment for the
  # whole launch, so the pane's own `flock -n 8` is the broken one as well; the
  # dedicated tmux socket is what makes that true regardless of where this case
  # sits in the file, since a tmux server started earlier would hand its pane
  # the environment IT was started with and quietly restore a working flock.
  local nonexcl_output nonexcl_status
  export ORCH_SESSION=nsboundary-nonexcluding
  export ORCH_RUNTIME_DIR="$SCRATCH/runtime-nonexcluding"
  export ORCH_TEST_PROVIDER_PIDS="$SCRATCH/provider-pids-nonexcluding"
  set +e
  nonexcl_output="$(ORCH_TEST_FLOCK_MODE=silent PATH="$flock_shim:$PATH" \
    ORCH_TEST_TMUX_SOCKET="$ALT_SOCKET" timeout 60 bash "$LAUNCH" start 2>&1)"
  nonexcl_status=$?
  set -e
  export ORCH_TEST_PROVIDER_PIDS="$SCRATCH/provider-pids"
  (( nonexcl_status != 0 )) ||
    fail "$mode world started on a flock that excludes nothing: $nonexcl_output"
  grep -q '^ERROR orchestrator-singleton-owner-unverified .*reason=attribution-undetermined' \
    <<<"$nonexcl_output" ||
    fail "expected a refusal naming the unmeasurable probe (rc=$nonexcl_status), got: $nonexcl_output"
  if grep -q 'orchestrator-singleton-owner-unattributable' <<<"$nonexcl_output"; then
    fail "a broken locker was reported as a kernel boundary: $nonexcl_output"
  fi
  [[ ! -e "$singleton_lock.owner" ]] ||
    fail 'a refused launch recorded an owner file'
  if tmux -L "$ALT_SOCKET" has-session -t nsboundary-nonexcluding 2>/dev/null; then
    fail 'refused non-excluding-flock session remained running'
  fi
  tmux -L "$ALT_SOCKET" kill-server 2>/dev/null || true
  printf 'singleton-nsboundary: RAN case=nonexcluding-flock-still-refuses mode=%s\n' "$mode"

  # ── The degraded branch checks its own premise on the REAL lock ───────────
  # The last line of defence, and the only case where a perfectly healthy probe
  # is not enough. Here flock works for everyone except the pane, so the probe
  # measures the world correctly -- exclusion real, kernel attributes nothing --
  # while the singleton lock the branch is about to trust was never actually
  # taken. Its stated premise, "flock is already holding the singleton", is
  # false, and it must find that out by asking rather than by assuming.
  #
  # The expected refusal differs by world, and BOTH are refusals: where the
  # kernel attributes, the missing row is an ownership anomaly and the reason
  # stays `owner-unnameable`; only the blind world gets far enough to test the
  # premise, and there the reason is `exclusion-unproven`.
  local premise_output premise_status premise_reason
  case "$mode" in
    observable) premise_reason='owner-unnameable' ;;
    blind) premise_reason='exclusion-unproven' ;;
  esac
  export ORCH_SESSION=nsboundary-premise
  export ORCH_RUNTIME_DIR="$SCRATCH/runtime-premise"
  export ORCH_TEST_PROVIDER_PIDS="$SCRATCH/provider-pids-premise"
  set +e
  premise_output="$(ORCH_TEST_FLOCK_MODE=pane PATH="$flock_shim:$PATH" \
    ORCH_TEST_TMUX_SOCKET="$ALT_SOCKET" timeout 60 bash "$LAUNCH" start 2>&1)"
  premise_status=$?
  set -e
  export ORCH_TEST_PROVIDER_PIDS="$SCRATCH/provider-pids"
  (( premise_status != 0 )) ||
    fail "$mode world started while nothing held its singleton lock: $premise_output"
  grep -q "^ERROR orchestrator-singleton-owner-unverified .*reason=$premise_reason" \
    <<<"$premise_output" ||
    fail "expected reason=$premise_reason (rc=$premise_status), got: $premise_output"
  if grep -q 'orchestrator-singleton-owner-unattributable' <<<"$premise_output"; then
    fail "the guard degraded on an exclusion that did not exist: $premise_output"
  fi
  [[ ! -e "$singleton_lock.owner" ]] ||
    fail 'a refused launch recorded an owner file'
  if tmux -L "$ALT_SOCKET" has-session -t nsboundary-premise 2>/dev/null; then
    fail 'refused unheld-lock session remained running'
  fi
  tmux -L "$ALT_SOCKET" kill-server 2>/dev/null || true
  printf 'singleton-nsboundary: RAN case=degradation-checks-its-own-premise mode=%s\n' "$mode"

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
