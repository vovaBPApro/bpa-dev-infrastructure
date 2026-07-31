#!/usr/bin/env bash
# Disk-pressure remediation lock.
#
# Written against a real ENOSPC outage: a full disk does not fail cleanly, it
# truncates files mid-write, so source files and the orchestrator's own state
# corrupt while the alert sits unread in Telegram. Detecting and alerting is not
# enough — the tick has to reclaim what it OWNS, re-measure, and only then
# escalate what a human actually has to act on.
#
# The other half of this suite is the blast radius (BLOCKER 3). Reclamation
# runs unattended against the operator's shared host daemon, so the ownership
# boundary is the contract: only resources carrying the exact BPA ownership
# label (pro.bpa.owner=bpa-dev-infrastructure) may ever be deleted. Host-global
# `docker builder prune`, host-global `docker image prune`, and tag-regex `rmi`
# against unlabeled images are all forbidden — a foreign build-cache entry, a
# foreign dangling image, and a foreign image whose tag HAPPENS to match the
# operator's stale pattern must all survive untouched. Anything outside the
# label is alert-only.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRATCH="$(mktemp -d)"
SHIM="$SCRATCH/bin"
trap 'rm -rf "$SCRATCH"' EXIT
mkdir -p "$SHIM"

OWNER_LABEL='pro.bpa.owner=bpa-dev-infrastructure'

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

# The docker shim records every call verbatim and models a host with BOTH
# BPA-labeled and foreign resources. Never the real docker: this box runs the
# operator's live stands, and a test that prunes them is the outage it is meant
# to prevent.
#   * `images` answers ORCH_TEST_DOCKER_IMAGES_LABELED only when the exact
#     owner-label filter is passed; the unfiltered listing (which the sweep
#     must never use) would include ORCH_TEST_DOCKER_IMAGES_FOREIGN too.
#   * `image prune` only "reclaims" when label-filtered; an unfiltered call is
#     recorded so the blast-radius assertions can convict it.
cat > "$SHIM/docker" <<'EOF'
#!/usr/bin/env bash
printf 'docker %s\n' "$*" >> "${ORCH_TEST_DOCKER_CALLS:?}"
labeled=0
for arg in "$@"; do
  [[ "$arg" == "label=${ORCH_TEST_OWNER_LABEL:?}" ]] && labeled=1
done
case "$1 ${2:-}" in
  'info ')
    [[ "${ORCH_TEST_DOCKER_DOWN:-0}" == 1 ]] && exit 1
    exit 0
    ;;
  'builder prune')
    # Foreign build-cache fixture: any builder prune from the unattended tick
    # is host-global (there is no label filter for build cache) and would have
    # deleted it. Reaching here at all is the regression.
    printf 'Total reclaimed space: 4.2GB\n'
    ;;
  'image prune')
    if [[ "$labeled" == 1 ]]; then
      printf 'Total reclaimed space: 1.1GB\n'
      [[ -n "${ORCH_TEST_DF_AFTER:-}" ]] && printf '%s\n' "$ORCH_TEST_DF_AFTER" > "${ORCH_TEST_DF_FILE:?}"
    else
      # Unfiltered prune "reclaims" the foreign dangling image.
      printf 'Deleted: foreign-dangling\nTotal reclaimed space: 9.9GB\n'
    fi
    ;;
  images*)
    if [[ "$labeled" == 1 ]]; then
      printf '%s' "${ORCH_TEST_DOCKER_IMAGES_LABELED:-}"
    else
      printf '%s' "${ORCH_TEST_DOCKER_IMAGES_LABELED:-}${ORCH_TEST_DOCKER_IMAGES_FOREIGN:-}"
    fi
    ;;
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
export ORCH_TEST_OWNER_LABEL="$OWNER_LABEL"

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
    ORCH_LIVENESS_FILE="$RUNTIME/orchestrator.liveness" \
    ORCH_RESTART_STATE_FILE="$RUNTIME/watchdog-restart-state" \
    ORCH_INSTANCE_LOCK_FILE="$RUNTIME/instance.lock" \
    ORCH_DONE_SENTINEL="$SCRATCH/no-done-sentinel" ORCH_DAEMON_HEALTH_URL="" \
    ORCH_INSTALL_ROOT="$SCRATCH" ORCH_TEST_DF_FILE="$DF_FILE" \
    ORCH_TEST_DOCKER_CALLS="$CALLS" FLEET_NUDGE_REPEAT_MS=0 \
    "$@" "$SCRIPT_DIR/watchdog.sh"
}

assert_blast_radius() {
  # Nothing here belongs to this control plane unless labeled. Volumes are
  # operator data, containers are running work, `image prune -a` deletes
  # deliberately-pulled images — and HOST-GLOBAL prunes of any kind delete
  # other projects' caches and dangling layers.
  not_contains 'docker volume prune' "$CALLS"
  not_contains 'docker system prune' "$CALLS"
  not_contains 'docker image prune -a' "$CALLS"
  not_contains 'docker rm ' "$CALLS"
  not_contains 'docker stop' "$CALLS"
  not_contains 'docker kill' "$CALLS"
  not_contains 'docker network prune' "$CALLS"
  # The foreign build cache: `builder prune` has no label filter, so ANY call
  # is host-global mutation of somebody else's cache. Never.
  not_contains 'docker builder prune' "$CALLS"
  # Every image prune and every image listing must carry the exact owner label.
  if grep -E 'docker image(s| prune)' "$CALLS" | grep -Fv -- "--filter label=$OWNER_LABEL" | grep -q .; then
    fail "host-global image call: $(grep -E 'docker image(s| prune)' "$CALLS" | grep -Fv -- "--filter label=$OWNER_LABEL" | head -n 1)"
  fi
  # `rmi` is never forced: a refusal from the daemon means the image is in use.
  not_contains 'docker rmi -f' "$CALLS"
  not_contains 'docker rmi --force' "$CALLS"
}

# ── 1. Pressure reclaims OWNED resources, re-measures, escalates the rest ───
tick 91
contains 'WATCHDOG disk-pressure pct=91' "$LOG"
contains "docker image prune -f --filter label=$OWNER_LABEL" "$CALLS"
contains 'step=builder-cache result=skipped reason=no-label-filter-exists-global-prune-forbidden' "$LOG"
contains 'step=image-prune-dangling-owned' "$LOG"
contains 'Total reclaimed space: 1.1GB' "$LOG"
contains 'DISK reclaim before_pct=91 after_pct=91' "$LOG"
# Still critical after reclaiming what we own: a human has to act on the rest —
# including the foreign resources this tick deliberately did not touch.
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
assert_blast_radius

# ── 3. Between the alert and critical thresholds: reclaim, do not escalate ──
tick 84 ORCH_TEST_DF_AFTER=84
contains 'WATCHDOG disk-pressure pct=84' "$LOG"
contains "docker image prune -f --filter label=$OWNER_LABEL" "$CALLS"
[[ ! -e "$OUTBOX" ]] || fail 'a non-critical disk level escalated to the operator'
assert_blast_radius

# ── 4. Below the alert threshold nothing runs at all ────────────────────────
tick 40
[[ ! -s "$CALLS" ]] || fail 'docker was touched with the disk under the alert threshold'
[[ ! -e "$OUTBOX" ]] || fail 'a healthy disk produced a nudge'

# ── 5. The stale-tag sweep: owner-labeled images only, and still opt-in ─────
tick 91
contains 'step=stale-tag-sweep result=disabled reason=no-pattern-configured' "$LOG"
not_contains 'docker rmi' "$CALLS"
assert_blast_radius

# With a pattern declared: the candidate list is label-filtered FIRST, then
# newest-first, keep N per repository, drop the rest. The foreign images —
# including foreign:release-9, whose tag MATCHES the pattern — exist only in
# the unfiltered listing the sweep must never ask for.
LABELED=$'2026-07-30 10:00:00\tbpa-app:release-5\n2026-07-29 10:00:00\tbpa-app:release-4\n2026-07-28 10:00:00\tbpa-app:release-3\n2026-07-27 10:00:00\tbpa-app:release-2\n2026-07-26 10:00:00\tbpa-app:release-1\n2026-07-30 10:00:00\tbpa-app:latest\n'
FOREIGN=$'2026-07-20 10:00:00\tforeign:release-9\n2026-07-30 10:00:00\tother:latest\n'
tick 91 ORCH_TEST_DOCKER_IMAGES_LABELED="$LABELED" ORCH_TEST_DOCKER_IMAGES_FOREIGN="$FOREIGN" \
  DOCKER_STALE_TAG_PATTERN=':release-' DOCKER_STALE_TAG_KEEP=3
contains 'removed=bpa-app:release-2' "$LOG"
contains 'removed=bpa-app:release-1' "$LOG"
for keep in bpa-app:release-5 bpa-app:release-4 bpa-app:release-3; do
  not_contains "docker rmi $keep" "$CALLS"
done
# A tag outside the declared pattern is not disposable, whatever its age.
not_contains 'docker rmi bpa-app:latest' "$CALLS"
# The foreign image whose tag matches the pattern is NOT BPA's to delete: it
# never enters the candidate list because the listing is label-filtered.
not_contains 'docker rmi foreign:release-9' "$CALLS"
not_contains 'docker rmi other:latest' "$CALLS"
assert_blast_radius

# An image a container still references is retained, with the daemon's reason.
IN_USE=$'2026-07-30 10:00:00\tbpa-app:release-in-use-9\n2026-07-29 10:00:00\tbpa-app:release-in-use-8\n'
tick 91 ORCH_TEST_DOCKER_IMAGES_LABELED="$IN_USE" DOCKER_STALE_TAG_PATTERN=':release-' DOCKER_STALE_TAG_KEEP=1
contains 'retained=bpa-app:release-in-use-8' "$LOG"
contains 'retained_count=1' "$LOG"
assert_blast_radius

# A malformed owner-label override could widen the filter; reclamation shuts
# itself off (alert-only) instead of running with a broken boundary.
tick 91 ORCH_DOCKER_OWNER_LABEL='not a label'
contains 'NO-GO reason=docker-owner-label-invalid action=alert-only' "$LOG"
if grep -E 'docker (image|images|rmi|builder)' "$CALLS" | grep -q .; then
  fail 'a malformed owner label still mutated docker state'
fi
contains 'NUDGE disk-pressure pct=91' "$OUTBOX"

# ── 6. No docker, or a docker that will not answer: skip, never fail ────────
# A dead docker daemon says nothing about the orchestrator, and the disk alert
# still has to reach the operator.
tick 91 ORCH_TEST_DOCKER_DOWN=1
contains 'SKIP reason=docker-daemon-unreachable' "$LOG"
contains 'NUDGE disk-pressure pct=91' "$OUTBOX"
not_contains 'docker image prune' "$CALLS"
not_contains 'docker builder prune' "$CALLS"

# An operator who does not want unattended pruning keeps the alert.
tick 91 DOCKER_PRUNE_ENABLED=0
contains 'SKIP reason=docker-prune-disabled' "$LOG"
[[ ! -s "$CALLS" ]] || fail 'docker was invoked while reclamation was disabled'
contains 'NUDGE disk-pressure pct=91' "$OUTBOX"

printf 'docker remediation tests: PASS\n'
