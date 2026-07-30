#!/usr/bin/env bash
# Disk-pressure remediation lock.
#
# Written against a real ENOSPC outage: a full disk does not fail cleanly, it
# truncates files mid-write, so source files and the orchestrator's own state
# corrupt while the alert sits unread in Telegram. Detecting and alerting is not
# enough — the tick has to reclaim, re-measure, and only then escalate what a
# human actually has to act on.
#
# The other half of this suite is the blast radius. Reclamation runs unattended
# on the operator's box, so what it must NEVER touch is as much a contract as
# what it prunes: no volumes (that is data), no containers, and no `image prune
# -a`, which would delete every image without a running container including ones
# the operator pulled deliberately.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRATCH="$(mktemp -d)"
SHIM="$SCRATCH/bin"
trap 'rm -rf "$SCRATCH"' EXIT
mkdir -p "$SHIM"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
contains() { grep -Fq -- "$1" "$2" || fail "missing from $(basename "$2"): $1"; }
not_contains() { ! grep -Fq -- "$1" "$2" || fail "forbidden call: $1"; }

# df reads its answer from a file so the docker shim can make the disk "recover".
cat > "$SHIM/df" <<'EOF'
#!/usr/bin/env bash
pct="$(cat "${ORCH_TEST_DF_FILE:?}" 2>/dev/null || echo 10)"
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n'
printf 'fixture 100 50 50 %s%% /\n' "$pct"
EOF

# The docker shim records every call verbatim. Never the real docker: this box
# runs the operator's live stands, and a test that prunes them is the outage it
# is meant to prevent.
cat > "$SHIM/docker" <<'EOF'
#!/usr/bin/env bash
printf 'docker %s\n' "$*" >> "${ORCH_TEST_DOCKER_CALLS:?}"
case "$1 ${2:-}" in
  'info ')
    [[ "${ORCH_TEST_DOCKER_DOWN:-0}" == 1 ]] && exit 1
    exit 0
    ;;
  'builder prune')
    printf 'Total reclaimed space: 4.2GB\n'
    [[ -n "${ORCH_TEST_DF_AFTER:-}" ]] && printf '%s\n' "$ORCH_TEST_DF_AFTER" > "${ORCH_TEST_DF_FILE:?}"
    ;;
  'image prune') printf 'Total reclaimed space: 1.1GB\n' ;;
  images*) printf '%s' "${ORCH_TEST_DOCKER_IMAGES:-}" ;;
  rmi*)
    # An image an existing container still references cannot be removed, and the
    # sweep must accept that answer rather than force it.
    if [[ "$2" == *in-use* ]]; then
      printf 'Error response from daemon: conflict: unable to delete (must be forced)\n' >&2
      exit 1
    fi
    ;;
esac
exit 0
EOF

cat > "$SHIM/tmux" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  has-session) exit 0 ;;
  list-panes) ps -o ppid= -p "$PPID" | tr -d ' ' ;;
  list-windows) date +%s ;;
  *) exit 0 ;;
esac
EOF
chmod +x "$SHIM/df" "$SHIM/docker" "$SHIM/tmux"

CASE_INDEX=0
tick() { # <df-pct> <env assignments…>
  local pct="$1"; shift
  CASE_INDEX=$(( CASE_INDEX + 1 ))
  RUNTIME="$SCRATCH/case-$CASE_INDEX"
  LOG="$RUNTIME/watchdog.log"
  OUTBOX="$RUNTIME/nudges.outbox"
  CALLS="$RUNTIME/docker.calls"
  DF_FILE="$RUNTIME/df.pct"
  mkdir -p "$RUNTIME"
  printf '%s\n' "$pct" > "$DF_FILE"
  : > "$CALLS"
  # Full ORCH_*/NUDGE_* isolation. This lane inherits the operator's live
  # environment, where ORCH_RUNTIME_DIR is the real runtime directory and
  # NUDGE_OUTBOX_FILE is drained straight into Telegram; ORCH_DONE_SENTINEL is
  # not covered by ORCH_RUNTIME_DIR at all (it lives under the daemon's state
  # dir), and an operator who had typed /done would make every case below pass
  # with the tick doing nothing.
  env PATH="$SHIM:$PATH" ORCH_CONFIG_FILE="$SCRATCH/no-config" \
    ORCH_STATE_DB="$SCRATCH/absent-state.db" ORCH_RUNTIME_DIR="$RUNTIME" \
    ORCH_WATCHDOG_LOG="$LOG" NUDGE_OUTBOX_FILE="$OUTBOX" \
    NUDGE_RATE_FILE="$RUNTIME/nudge-rate.tsv" ORCH_LEASE_FILE="$RUNTIME/orchestrator.lease" \
    ORCH_HEARTBEAT_FILE="$RUNTIME/orchestrator.heartbeat" \
    ORCH_HEARTBEAT_MISSING_SINCE_FILE="$RUNTIME/heartbeat-missing-since" \
    ORCH_RESTART_STATE_FILE="$RUNTIME/watchdog-restart-state" \
    ORCH_INSTANCE_LOCK_FILE="$RUNTIME/instance.lock" \
    ORCH_DONE_SENTINEL="$SCRATCH/no-done-sentinel" ORCH_DAEMON_HEALTH_URL="" \
    ORCH_INSTALL_ROOT="$SCRATCH" ORCH_TEST_DF_FILE="$DF_FILE" \
    ORCH_TEST_DOCKER_CALLS="$CALLS" FLEET_NUDGE_REPEAT_MS=0 \
    "$@" "$SCRIPT_DIR/watchdog.sh"
}

assert_blast_radius() {
  # Nothing in this list is a cache. Volumes are operator data, containers are
  # running work, and `image prune -a` deletes deliberately-pulled images.
  not_contains 'docker volume prune' "$CALLS"
  not_contains 'docker system prune' "$CALLS"
  not_contains 'docker image prune -a' "$CALLS"
  not_contains 'docker rm ' "$CALLS"
  not_contains 'docker stop' "$CALLS"
  not_contains 'docker kill' "$CALLS"
  not_contains 'docker network prune' "$CALLS"
  # `rmi` is never forced: a refusal from the daemon means the image is in use.
  not_contains 'docker rmi -f' "$CALLS"
  not_contains 'docker rmi --force' "$CALLS"
}

# ── 1. Pressure reclaims, re-measures, and escalates what remains ───────────
tick 91
contains 'WATCHDOG disk-pressure pct=91' "$LOG"
contains 'docker builder prune -f' "$CALLS"
contains 'docker image prune -f' "$CALLS"
contains 'step=builder-prune Total reclaimed space: 4.2GB' "$LOG"
contains 'step=image-prune-dangling Total reclaimed space: 1.1GB' "$LOG"
contains 'DISK reclaim before_pct=91 after_pct=91' "$LOG"
# Still critical after reclaiming: this is the state a human has to act on.
contains 'WATCHDOG disk-critical pct=91' "$LOG"
contains 'NUDGE disk-pressure pct=91 was_pct=91' "$OUTBOX"
contains 'needs=manual-cleanup' "$OUTBOX"
assert_blast_radius

# ── 2. Reclamation that works is a log line, not an interruption ────────────
# The old behaviour alerted on every tick above the threshold. Waking the
# operator for a problem the tick already solved is how alerts get ignored.
tick 91 ORCH_TEST_DF_AFTER=40
contains 'DISK reclaim before_pct=91 after_pct=40' "$LOG"
contains 'WATCHDOG disk-recovered pct=40 was_pct=91' "$LOG"
[[ ! -e "$OUTBOX" ]] || fail 'the operator was interrupted for pressure the tick had already relieved'

# ── 3. Between the alert and critical thresholds: reclaim, do not escalate ──
tick 84 ORCH_TEST_DF_AFTER=84
contains 'WATCHDOG disk-pressure pct=84' "$LOG"
contains 'docker builder prune -f' "$CALLS"
[[ ! -e "$OUTBOX" ]] || fail 'a non-critical disk level escalated to the operator'

# ── 4. Below the alert threshold nothing runs at all ────────────────────────
tick 40
[[ ! -s "$CALLS" ]] || fail 'docker was touched with the disk under the alert threshold'
[[ ! -e "$OUTBOX" ]] || fail 'a healthy disk produced a nudge'

# ── 5. The stale-tag sweep is opt-in ────────────────────────────────────────
# The reference implementation hard-coded one project's tag vocabulary. Shipping
# that verbatim here would either match nothing or match a tag this repo gives a
# different meaning, so an operator has to name their own convention.
tick 91
contains 'step=stale-tag-sweep result=disabled reason=no-pattern-configured' "$LOG"
not_contains 'docker rmi' "$CALLS"

# With a pattern declared: newest-first, keep N per repository, drop the rest.
IMAGES=$'2026-07-30 10:00:00\tapp:release-5\n2026-07-29 10:00:00\tapp:release-4\n2026-07-28 10:00:00\tapp:release-3\n2026-07-27 10:00:00\tapp:release-2\n2026-07-26 10:00:00\tapp:release-1\n2026-07-30 10:00:00\tapp:latest\n'
tick 91 ORCH_TEST_DOCKER_IMAGES="$IMAGES" DOCKER_STALE_TAG_PATTERN=':release-' DOCKER_STALE_TAG_KEEP=3
contains 'removed=app:release-2' "$LOG"
contains 'removed=app:release-1' "$LOG"
for keep in app:release-5 app:release-4 app:release-3; do
  not_contains "docker rmi $keep" "$CALLS"
done
# A tag outside the declared pattern is not disposable, whatever its age.
not_contains 'docker rmi app:latest' "$CALLS"
assert_blast_radius

# An image a container still references is retained, with the daemon's reason.
IN_USE=$'2026-07-30 10:00:00\tapp:release-in-use-9\n2026-07-29 10:00:00\tapp:release-in-use-8\n'
tick 91 ORCH_TEST_DOCKER_IMAGES="$IN_USE" DOCKER_STALE_TAG_PATTERN=':release-' DOCKER_STALE_TAG_KEEP=1
contains 'retained=app:release-in-use-8' "$LOG"
contains 'retained_count=1' "$LOG"
assert_blast_radius

# ── 6. No docker, or a docker that will not answer: skip, never fail ────────
# A dead docker daemon says nothing about the orchestrator, and the disk alert
# still has to reach the operator.
tick 91 ORCH_TEST_DOCKER_DOWN=1
contains 'SKIP reason=docker-daemon-unreachable' "$LOG"
contains 'NUDGE disk-pressure pct=91' "$OUTBOX"
not_contains 'docker builder prune' "$CALLS"

# An operator who does not want unattended pruning keeps the alert.
tick 91 DOCKER_PRUNE_ENABLED=0
contains 'SKIP reason=docker-prune-disabled' "$LOG"
[[ ! -s "$CALLS" ]] || fail 'docker was invoked while reclamation was disabled'
contains 'NUDGE disk-pressure pct=91' "$OUTBOX"

printf 'docker remediation tests: PASS\n'
