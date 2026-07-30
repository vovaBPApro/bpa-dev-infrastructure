#!/usr/bin/env bash
# One watchdog tick.  A timer invokes this script; it never loops itself.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${ORCH_CONFIG_FILE:-$SCRIPT_DIR/runtime.env}"
if [[ -f "$CONFIG_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
fi
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib.sh"
SESSION="${ORCH_SESSION:-orchestrator}"
RUNTIME_DIR="${ORCH_RUNTIME_DIR:-$SCRIPT_DIR/runtime}"
LOG_FILE="${ORCH_WATCHDOG_LOG:-$RUNTIME_DIR/watchdog.log}"
HEARTBEAT_FILE="${ORCH_HEARTBEAT_FILE:-$RUNTIME_DIR/orchestrator.heartbeat}"
HEARTBEAT_MAX_AGE="${ORCH_HEARTBEAT_MAX_AGE:-1200}"
HEARTBEAT_MISSING_SINCE_FILE="${ORCH_HEARTBEAT_MISSING_SINCE_FILE:-$RUNTIME_DIR/heartbeat-missing-since}"
LAUNCH_SCRIPT="${ORCH_LAUNCH_SCRIPT:-$SCRIPT_DIR/launch.sh}"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MISSION_CLI="${ORCH_MISSION_CLI:-$REPO_DIR/core/mission-cli.ts}"
STATE_DB="${ORCH_STATE_DB:-$REPO_DIR/runtime/state.db}"
LEASE_FILE="${ORCH_LEASE_FILE:-$RUNTIME_DIR/orchestrator.lease}"
# The watchdog is the ONLY thing that renews the orchestrator lease, so the TTL
# it renews with has to outlive its own tick interval — see the lease fence
# below. Same knob launch.sh acquires with, so there is one number, not two.
# 180000 is three ticks at the 60s default interval: two ticks of headroom (the
# fence's minimum) plus one tick of margin. It was 120000, which sat EXACTLY on
# the fence boundary — see the strictness note there.
LEASE_TTL_MS="${ORCH_LEASE_TTL_MS:-180000}"
# ── Tick cadence: ONE knob ──────────────────────────────────────────────────
# `ORCH_WATCHDOG_INTERVAL` is the name. `ORCH_WATCHDOG_INTERVAL_SECONDS` is a
# deprecated alias, honoured only because bootstrap/env.template shipped that
# spelling: every installed .env on disk carries it, and nothing read it, so the
# documented cadence silently never applied. Dropping the name outright would
# have changed those hosts' behaviour a second time, in silence, so it resolves
# here instead — and cadence-knob.test.sh fails if the template, this reader,
# install-watchdog.sh and the rendered timer ever disagree again.
WATCHDOG_INTERVAL_S="${ORCH_WATCHDOG_INTERVAL:-${ORCH_WATCHDOG_INTERVAL_SECONDS:-60}}"
INSTALL_ROOT="${ORCH_INSTALL_ROOT:-${INSTALL_ROOT:-$REPO_DIR}}"
NUDGE_OUTBOX_FILE="${NUDGE_OUTBOX_FILE:-$RUNTIME_DIR/nudges.outbox}"
FLEET_IDLE_NUDGE_MS="${FLEET_IDLE_NUDGE_MS:-900000}"
FLEET_NUDGE_REPEAT_MS="${FLEET_NUDGE_REPEAT_MS:-3600000}"
DISK_ALERT_PCT="${DISK_ALERT_PCT:-80}"
# ── Disk remediation thresholds ─────────────────────────────────────────────
# At DISK_ALERT_PCT the tick reclaims Docker space and re-measures; only if the
# filesystem is STILL at or above DISK_CRITICAL_PCT does the operator get told.
# Written after a real ENOSPC outage: a full disk truncates files mid-write, so
# detecting-and-alerting without reclaiming leaves the box to corrupt itself
# until a human wakes up.
DISK_CRITICAL_PCT="${DISK_CRITICAL_PCT:-88}"
# Set 0 to disable reclamation and keep the previous alert-only behaviour.
DOCKER_PRUNE_ENABLED="${DOCKER_PRUNE_ENABLED:-1}"
# Opt-in sweep of DISPOSABLE TAGGED images, which are not dangling and so are
# never reclaimed by `image prune`. Deliberately EMPTY by default: the reference
# implementation hard-coded the old project's tag vocabulary
# (rollback|release|pre-|night|batch|…), and shipping that verbatim here would
# either match nothing or, worse, match a tag this repo gives a different
# meaning. An operator who has such a convention names it; nobody else can be
# surprised by it. Never matches running containers' images — see the sweep.
DOCKER_STALE_TAG_PATTERN="${DOCKER_STALE_TAG_PATTERN:-}"
DOCKER_STALE_TAG_KEEP="${DOCKER_STALE_TAG_KEEP:-3}"
NUDGE_RATE_FILE="${NUDGE_RATE_FILE:-$RUNTIME_DIR/nudge-rate.tsv}"
# `/done` rest sentinel. The daemon writes this file on /done and /mission_done
# and deletes it on the next inbound Human directive (daemon/server.ts), and it
# tells the operator "Watchdog спить (квоту не палить)". That promise is only
# true if the watchdog actually reads the file, so this path MUST resolve to the
# same one the daemon writes — watchdog-supervision.test.sh derives it from
# daemon/server.ts and fails if the two drift.
TELEGRAM_STATE_DIR="${TELEGRAM_STATE_DIR:-$HOME/.claude/channels/telegram}"
DONE_SENTINEL="${ORCH_DONE_SENTINEL:-$TELEGRAM_STATE_DIR/daemon/runtime/orchestrator-done}"
# Restart anti-thrash. Every restart costs provider quota and drops whatever the
# session was doing, so a tick may only restart if the previous one is at least
# this old. Night (local 22:00–07:00) is stricter: the operator is asleep and
# cannot intervene, so recover sooner.
RESTART_STATE_FILE="${ORCH_RESTART_STATE_FILE:-$RUNTIME_DIR/watchdog-restart-state}"
WATCHDOG_HOUR="${ORCH_WATCHDOG_HOUR:-$(date +%H)}"
if (( 10#$WATCHDOG_HOUR >= 22 || 10#$WATCHDOG_HOUR < 7 )); then
  WATCHDOG_NIGHT=1
  RESTART_COOLDOWN_S="${ORCH_RESTART_COOLDOWN_NIGHT:-900}"
else
  WATCHDOG_NIGHT=0
  RESTART_COOLDOWN_S="${ORCH_RESTART_COOLDOWN:-1800}"
fi
# Daemon liveness. The daemon owns the Telegram token and drains the nudge
# outbox, so a dead daemon means the operator is deaf even while the
# orchestrator is healthy — and nothing else on this box notices.
# Expanded with `-`, not `:-`, so an explicitly EMPTY value disables the probe
# (which is how every hermetic suite keeps this tick off the network) instead of
# silently falling back to the default URL.
DAEMON_HEALTH_URL="${ORCH_DAEMON_HEALTH_URL-http://127.0.0.1:${TELEGRAM_DAEMON_PORT:-4822}/health}"

log() { mkdir -p "$RUNTIME_DIR"; printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG_FILE"; }
validate_numeric_knob() {
  local name="$1" default="$2" value="${!1}"
  if ! [[ "$value" =~ ^[0-9]+$ ]]; then
    log "WATCHDOG invalid-knob name=$name value=$value using-default=$default"
    printf -v "$name" '%s' "$default"
  fi
}
validate_numeric_knob FLEET_IDLE_NUDGE_MS 900000
validate_numeric_knob FLEET_NUDGE_REPEAT_MS 3600000
validate_numeric_knob DISK_ALERT_PCT 80
validate_numeric_knob HEARTBEAT_MAX_AGE 1200
validate_numeric_knob LEASE_TTL_MS 180000
validate_numeric_knob WATCHDOG_INTERVAL_S 60
validate_numeric_knob DISK_CRITICAL_PCT 88
validate_numeric_knob DOCKER_STALE_TAG_KEEP 3
validate_numeric_knob RESTART_COOLDOWN_S 1800

# ── `/done` rest ────────────────────────────────────────────────────────────
# Checked before anything else, exactly like the reference implementation. The
# daemon has already told the operator the watchdog is asleep; from here the
# tick does nothing at all — no nudge, no restart, no fence.
#
# Resting also means the orchestrator lease stops being renewed and will expire.
# That is safe now and was not before: an expired-but-uncontested lease is
# re-acquired by the guard below rather than read as a hostile takeover.
if [[ -f "$DONE_SENTINEL" ]]; then
  log "rest reason=done-sentinel path=$DONE_SENTINEL action=none"
  exit 0
fi

pane_pid() { tmux list-panes -t "$SESSION" -F '#{pane_pid}' 2>/dev/null | head -n 1; }
state_available() { [[ -f "$STATE_DB" ]]; }
mission_cli() { INFRA_STATE_DB="$STATE_DB" "$BUN_BIN" "$MISSION_CLI" "$@"; }
lease_state() {
  [[ -f "$LEASE_FILE" ]] || return 1
  LEASE_OWNER="$(sed -n 's/^owner=//p' "$LEASE_FILE")"
  LEASE_TOKEN="$(sed -n 's/^token=//p' "$LEASE_FILE")"
  [[ -n "$LEASE_OWNER" && "$LEASE_TOKEN" =~ ^[1-9][0-9]*$ ]]
}
write_lease_state() {
  local owner="$1" token="$2" tmp
  mkdir -p "$(dirname "$LEASE_FILE")"
  tmp="$(mktemp "$(dirname "$LEASE_FILE")/.orchestrator.lease.XXXXXX")"
  chmod 0600 "$tmp"
  printf 'owner=%s\ntoken=%s\n' "$owner" "$token" > "$tmp"
  mv -f "$tmp" "$LEASE_FILE"
}
stop_supervised_unit() { tmux kill-session -t "$SESSION" 2>/dev/null || true; }

# ── Lease fence ─────────────────────────────────────────────────────────────
# A failed `lease renew` is NOT by itself evidence that another orchestrator
# took over. It fails identically when the lease merely aged out with nobody
# else wanting it — which is the common case, because the watchdog is itself the
# renewer: any gap in ticks (timer not installed, box suspended, a tick slower
# than the TTL) ends with our own token expired and reaped. Treating that as a
# takeover kills a healthy singleton, and on this control plane the orchestrator
# session is the operator's only channel.
#
# So classify before firing:
#   nobody holds the lease            -> uncontested self-expiry: re-acquire
#   a VERIFIABLY LIVE other process   -> genuine displacement: stop the unit
#   anything else                     -> NO-GO in the log, never a kill
#
# The bias in the last row is deliberate. Mutual exclusion does not rest on this
# fence alone: launch.sh runs the supervised process under an flock on
# ORCH_SINGLETON_LOCK_FILE, so a second orchestrator cannot actually start even
# while the lease bookkeeping is confused (singleton-failclosed.test.sh). A
# wrong kill has no such backstop.

# Prints live|dead|unverifiable for an owner spelled "<host>:<pid>", the shape
# launch.sh writes. Only a local PID can be checked, so a foreign host or a
# malformed owner is reported as unverifiable rather than guessed at.
owner_liveness() {
  local owner="$1" host pid
  host="${owner%:*}"
  pid="${owner##*:}"
  if [[ "$owner" != *:* || -z "$host" || ! "$pid" =~ ^[1-9][0-9]*$ || "$host" != "$(hostname)" ]]; then
    printf 'unverifiable\n'
    return 0
  fi
  if kill -0 "$pid" 2>/dev/null; then printf 'live\n'; else printf 'dead\n'; fi
}

# Sets HOLDER_OWNER/HOLDER_TOKEN from the current ACTIVE orchestrator lease
# (`status` lists only unexpired, unreleased leases), empty when nobody holds
# it. Returns non-zero when the state store cannot be read or parsed at all —
# an unreadable store is not evidence of anything.
read_lease_holder() {
  local status_output parsed
  HOLDER_OWNER=""; HOLDER_TOKEN=""
  status_output="$(mission_cli status 2>/dev/null)" || return 1
  parsed="$(printf '%s' "$status_output" | "$BUN_BIN" -e '
const status = JSON.parse(await Bun.stdin.text());
const lease = (status.leases ?? []).find((entry) => entry.key === "orchestrator");
if (lease) process.stdout.write([lease.owner, lease.fencingToken].join("\t"));
' 2>/dev/null)" || return 1
  [[ -n "$parsed" ]] || return 0
  IFS=$'\t' read -r HOLDER_OWNER HOLDER_TOKEN <<<"$parsed"
  return 0
}

# Uncontested self-expiry. Take the lease back under the same owner and carry
# on. The fencing token necessarily changes; nothing enforces the token the
# supervised process was started with, so the lease file is the record that has
# to stay truthful.
reacquire_lease() {
  local liveness lease_output token
  liveness="$(owner_liveness "$LEASE_OWNER")"
  if [[ "$liveness" != live ]]; then
    log "WATCHDOG NO-GO reason=lease-self-owner-$liveness owner=$LEASE_OWNER token=$LEASE_TOKEN action=no-kill"
    return 0
  fi
  if ! lease_output="$(mission_cli lease acquire "$LEASE_OWNER" orchestrator "$LEASE_TTL_MS" 2>&1)"; then
    log "WATCHDOG NO-GO reason=lease-reacquire-refused owner=$LEASE_OWNER token=$LEASE_TOKEN action=no-kill"
    return 0
  fi
  token="$(sed -nE 's/^LEASE key=orchestrator owner=.* token=([1-9][0-9]*)$/\1/p' <<<"$lease_output")"
  if [[ -z "$token" ]]; then
    log "WATCHDOG NO-GO reason=lease-reacquire-token-invalid owner=$LEASE_OWNER token=$LEASE_TOKEN action=no-kill"
    return 0
  fi
  write_lease_state "$LEASE_OWNER" "$token"
  log "WATCHDOG lease-reacquired owner=$LEASE_OWNER stale-token=$LEASE_TOKEN token=$token action=continue"
  LEASE_TOKEN="$token"
  return 0
}

guard_lease_renew_failure() {
  local liveness
  if ! read_lease_holder; then
    log "WATCHDOG NO-GO reason=lease-state-unreadable owner=$LEASE_OWNER token=$LEASE_TOKEN action=no-kill"
    return 0
  fi
  if [[ -z "$HOLDER_OWNER" ]]; then
    reacquire_lease
    return 0
  fi
  if [[ "$HOLDER_OWNER" == "$LEASE_OWNER" ]]; then
    # Our own owner holds a live lease under a token we failed to renew: the
    # lease file and the store disagree. Contradictory, so not a kill.
    log "WATCHDOG NO-GO reason=lease-self-contradiction owner=$LEASE_OWNER token=$LEASE_TOKEN holder-token=$HOLDER_TOKEN action=no-kill"
    return 0
  fi
  liveness="$(owner_liveness "$HOLDER_OWNER")"
  if [[ "$liveness" == live ]]; then
    log "WATCHDOG lease-displaced owner=$LEASE_OWNER token=$LEASE_TOKEN holder=$HOLDER_OWNER holder-token=$HOLDER_TOKEN action=stop"
    stop_supervised_unit
    exit 0
  fi
  # A corpse (or an owner we cannot check) holding an unexpired lease is not a
  # takeover; `reap` clears those rows on the next launch.
  log "WATCHDOG NO-GO reason=lease-holder-not-live holder=$HOLDER_OWNER holder-token=$HOLDER_TOKEN liveness=$liveness owner=$LEASE_OWNER token=$LEASE_TOKEN action=no-kill"
  return 0
}
session_healthy() {
  tmux has-session -t "$SESSION" 2>/dev/null || return 1
  local pid; pid="$(pane_pid)"; [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null
}
heartbeat_stale() {
  local heartbeat now
  now="${ORCH_WATCHDOG_NOW:-$(date +%s)}"
  if [[ ! -f "$HEARTBEAT_FILE" ]]; then
    if [[ ! -f "$HEARTBEAT_MISSING_SINCE_FILE" ]]; then
      printf '%s\n' "$now" > "$HEARTBEAT_MISSING_SINCE_FILE"
      return 1
    fi
    heartbeat="$(cat "$HEARTBEAT_MISSING_SINCE_FILE" 2>/dev/null)" || return 0
    [[ "$heartbeat" =~ ^[0-9]+$ && "$now" =~ ^[0-9]+$ ]] || return 0
    (( now - heartbeat > HEARTBEAT_MAX_AGE ))
    return
  fi
  rm -f "$HEARTBEAT_MISSING_SINCE_FILE"
  heartbeat="$(cat "$HEARTBEAT_FILE" 2>/dev/null)" || return 0
  [[ "$heartbeat" =~ ^[0-9]+$ && "$now" =~ ^[0-9]+$ ]] || return 0
  (( now - heartbeat > HEARTBEAT_MAX_AGE ))
}

# ── Second liveness signal: is the pane still producing output? ─────────────
# The heartbeat above has exactly ONE ongoing writer — the turn-end hook
# (orchestrator-turnend-relay.sh, which Codex's notify and Claude's Stop hook
# both funnel into). It therefore says "a turn ENDED", never "a turn is running".
# A single turn longer than HEARTBEAT_MAX_AGE is completely ordinary for this
# role (a long dispatch, a slow build, a big review) and used to be indistinguish-
# able from a corpse: the tick went straight to kill-and-relaunch and shot a
# session that was alive and mid-work, losing the turn and burning quota.
#
# tmux knows better, because it sees the bytes. This is the newest-signal-wins
# rule from the reference watchdog, with one deliberate substitution:
#
#   the reference used `#{session_activity}`; MEASURED on tmux 3.4, that field
#   does NOT advance for a DETACHED session — which is the only shape an
#   orchestrator ever has. It stays frozen at session creation, so restoring it
#   verbatim would read "dead" for every healthy session and change nothing.
#   `#{window_activity}` does track pane output: ~0s for a busy pane, growing
#   with wall-clock for a wedged or SIGSTOPped one. That is the property this
#   guard needs, so that is the field used.
#
# Windows are max()'d rather than taking the session's current window, so a
# multi-window session is judged by its newest output anywhere.
# Prints the age in seconds of the newest pane output, or nothing at all when
# tmux cannot answer — absence of a signal is never evidence of death here.
session_activity_age() {
  local now="$1" newest age
  newest="$(tmux list-windows -t "$SESSION" -F '#{window_activity}' 2>/dev/null |
    grep -oE '^[0-9]+' | sort -n | tail -n 1)" || true
  [[ "$newest" =~ ^[0-9]+$ && "$now" =~ ^[0-9]+$ ]] || return 0
  # Some tmux builds report milliseconds.
  (( ${#newest} >= 13 )) && newest=$(( newest / 1000 ))
  age=$(( now - newest ))
  # A future timestamp means clock skew, not staleness. Clamp to fresh.
  (( age < 0 )) && age=0
  printf '%s\n' "$age"
}

# Watchdog nudge updates are written to a same-directory temporary file then
# renamed, so a Telegram reader observes either the old complete file or the
# new complete file. full-suite.sh follows the same outbox pattern.
append_nudge() {
  local line="$1" tmp lock_file lock_fd
  mkdir -p "$(dirname "$NUDGE_OUTBOX_FILE")"
  lock_file="${NUDGE_OUTBOX_FILE}.lock"
  exec {lock_fd}> "$lock_file"
  flock "$lock_fd"
  tmp="$(mktemp "$(dirname "$NUDGE_OUTBOX_FILE")/.nudges.outbox.XXXXXX")"
  [[ -f "$NUDGE_OUTBOX_FILE" ]] && cat "$NUDGE_OUTBOX_FILE" > "$tmp"
  printf '%s\n' "$line" >> "$tmp"
  mv -f "$tmp" "$NUDGE_OUTBOX_FILE"
  flock -u "$lock_fd"
  exec {lock_fd}>&-
}

nudge_due() {
  local kind="$1" key="$2" now="$3" last=0
  [[ "$now" =~ ^[0-9]+$ ]] || return 1
  if [[ -f "$NUDGE_RATE_FILE" ]]; then
    last="$(awk -F '\t' -v kind="$kind" -v key="$key" '$1 == kind && $2 == key { value=$3 } END { print value+0 }' "$NUDGE_RATE_FILE")"
  fi
  (( now - last >= FLEET_NUDGE_REPEAT_MS ))
}

record_nudge() {
  local kind="$1" key="$2" now="$3" tmp
  mkdir -p "$(dirname "$NUDGE_RATE_FILE")"
  tmp="$(mktemp "$(dirname "$NUDGE_RATE_FILE")/.nudge-rate.XXXXXX")"
  [[ -f "$NUDGE_RATE_FILE" ]] && awk -F '\t' -v kind="$kind" -v key="$key" '!($1 == kind && $2 == key)' "$NUDGE_RATE_FILE" > "$tmp"
  printf '%s\t%s\t%s\n' "$kind" "$key" "$now" >> "$tmp"
  mv -f "$tmp" "$NUDGE_RATE_FILE"
}

disk_pct() {
  df -P "$INSTALL_ROOT" 2>/dev/null | awk 'NR == 2 { value=$5; sub(/%$/, "", value); print value }'
}

# ── Docker reclamation ──────────────────────────────────────────────────────
# Conservative by construction. It touches exactly three things, all of which
# are rebuildable caches:
#   1. build cache   (`builder prune -f`)
#   2. DANGLING images only (`image prune -f` — never `-a`, which would delete
#      every image without a running container, including ones the operator
#      pulled deliberately)
#   3. disposable TAGGED images, and only when the operator has declared a tag
#      pattern for them (DOCKER_STALE_TAG_PATTERN, empty by default).
# It never touches volumes (`volume prune` is not called and never should be —
# that is operator data), never touches networks, and never stops or removes a
# container. Images in use by ANY container, running or not, are protected by
# `docker rmi` itself: it refuses with "image is being used", which is caught
# and logged rather than forced. There is no `-f` on the rmi for that reason.
docker_reclaim() {
  local before_pct="$1" output images image kept
  command -v docker >/dev/null 2>&1 || { log "SKIP reason=docker-unavailable"; return 0; }
  if ! docker info >/dev/null 2>&1; then
    log "SKIP reason=docker-daemon-unreachable"
    return 0
  fi

  if output="$(docker builder prune -f 2>&1)"; then
    log "DISK reclaim step=builder-prune $(printf '%s' "$output" | grep -i 'reclaimed' | tail -n 1)"
  else
    log "DISK reclaim step=builder-prune result=failed detail=$(printf '%s' "$output" | tr '\n' ' ' | cut -c1-200)"
  fi

  if output="$(docker image prune -f 2>&1)"; then
    log "DISK reclaim step=image-prune-dangling $(printf '%s' "$output" | grep -i 'reclaimed' | tail -n 1)"
  else
    log "DISK reclaim step=image-prune-dangling result=failed detail=$(printf '%s' "$output" | tr '\n' ' ' | cut -c1-200)"
  fi

  if [[ -z "$DOCKER_STALE_TAG_PATTERN" ]]; then
    log "DISK reclaim step=stale-tag-sweep result=disabled reason=no-pattern-configured"
  else
    # Newest-first, keep DOCKER_STALE_TAG_KEEP per repository so a recent
    # rollback target stays usable, drop the rest.
    images="$(docker images --format '{{.CreatedAt}}\t{{.Repository}}:{{.Tag}}' 2>/dev/null |
      grep -E -- "$DOCKER_STALE_TAG_PATTERN" |
      sort -r |
      awk -F '\t' -v keep="$DOCKER_STALE_TAG_KEEP" \
        '{ repo = $2; sub(/:.*/, "", repo); seen[repo]++; if (seen[repo] > keep) print $2 }')" || true
    kept=0
    while IFS= read -r image; do
      [[ -n "$image" ]] || continue
      if output="$(docker rmi "$image" 2>&1)"; then
        log "DISK reclaim step=stale-tag-sweep removed=$image"
      else
        kept=$(( kept + 1 ))
        log "DISK reclaim step=stale-tag-sweep retained=$image reason=$(printf '%s' "$output" | tr '\n' ' ' | cut -c1-120)"
      fi
    done <<< "$images"
    (( kept > 0 )) && log "DISK reclaim step=stale-tag-sweep retained_count=$kept reason=in-use-or-refused"
  fi

  log "DISK reclaim before_pct=$before_pct after_pct=$(disk_pct) root=$INSTALL_ROOT"
  return 0
}

check_disk_pressure() {
  local pct now after
  pct="$(disk_pct)"
  [[ "$pct" =~ ^[0-9]+$ ]] || { log "SKIP reason=disk-stat-unavailable root=$INSTALL_ROOT"; return; }
  (( pct >= DISK_ALERT_PCT )) || return
  log "WATCHDOG disk-pressure pct=$pct root=$INSTALL_ROOT"

  after="$pct"
  if (( DOCKER_PRUNE_ENABLED == 1 )); then
    docker_reclaim "$pct" || log "WATCHDOG NO-GO reason=docker-reclaim-failed root=$INSTALL_ROOT action=alert-only"
    after="$(disk_pct)"
    [[ "$after" =~ ^[0-9]+$ ]] || after="$pct"
  else
    log "SKIP reason=docker-prune-disabled root=$INSTALL_ROOT"
  fi

  now="${ORCH_WATCHDOG_NOW_MS:-$(( $(date +%s) * 1000 ))}"
  # The operator is told when the disk is still critically full AFTER
  # reclamation — that is the state a human has to act on. Reclamation that
  # brought it back under DISK_CRITICAL_PCT is a log line, not an interruption.
  if (( after >= DISK_CRITICAL_PCT )); then
    log "WATCHDOG disk-critical pct=$after was_pct=$pct root=$INSTALL_ROOT"
    if nudge_due disk "$INSTALL_ROOT" "$now"; then
      append_nudge "NUDGE disk-pressure pct=$after was_pct=$pct root=$INSTALL_ROOT needs=manual-cleanup"
      record_nudge disk "$INSTALL_ROOT" "$now"
    fi
  elif (( after < pct )); then
    log "WATCHDOG disk-recovered pct=$after was_pct=$pct root=$INSTALL_ROOT"
  fi
}

check_mission_pressure() {
  local status_output now
  state_available || { log "SKIP reason=mission-pressure-state-db-absent path=$STATE_DB"; return; }
  if ! status_output="$(mission_cli status 2>/dev/null)"; then
    log "SKIP reason=mission-pressure-status-unavailable"
    return
  fi
  now="${ORCH_WATCHDOG_NOW_MS:-$(( $(date +%s) * 1000 ))}"
  while IFS=$'\t' read -r correlation open_lanes active updated_at; do
    [[ -n "$correlation" ]] || continue
    [[ "$open_lanes" =~ ^[0-9]+$ && "$active" =~ ^[0-9]+$ && "$updated_at" =~ ^[0-9]+$ ]] || continue
    if (( open_lanes > 0 && now - updated_at >= FLEET_IDLE_NUDGE_MS )) && nudge_due mission "$correlation" "$now"; then
      append_nudge "NUDGE mission=$correlation open_lanes=$open_lanes active=$active idle_ms=$(( now - updated_at ))"
      record_nudge mission "$correlation" "$now"
    fi
  done < <(printf '%s' "$status_output" | "$BUN_BIN" -e '
const input = await Bun.stdin.text();
const status = JSON.parse(input);
for (const mission of status.missions) {
  const lanes = status.lanes.filter((lane) => lane.missionId === mission.id);
  const active = status.leases.filter((lease) => lanes.some((lane) => lane.id === lease.key)).length;
  const updatedAt = Math.max(mission.updatedAt, ...lanes.map((lane) => lane.updatedAt));
  console.log([mission.correlationId, lanes.length, active, updatedAt].join("\t"));
}')
}

# The daemon holds the Telegram token AND drains the nudge outbox, so if it is
# down the operator hears nothing at all. Report it; do not act on it — a dead
# daemon says nothing about the orchestrator, and the daemon has its own
# supervisor. The nudge is durable: it sits in the outbox until the daemon
# returns to drain it.
check_daemon_health() {
  local now
  [[ -n "$DAEMON_HEALTH_URL" ]] || { log "SKIP reason=daemon-health-disabled"; return 0; }
  command -v curl >/dev/null 2>&1 || { log "SKIP reason=daemon-health-no-curl url=$DAEMON_HEALTH_URL"; return 0; }
  if curl -s -m 5 -o /dev/null "$DAEMON_HEALTH_URL"; then
    return 0
  fi
  log "WATCHDOG daemon-unreachable url=$DAEMON_HEALTH_URL"
  now="${ORCH_WATCHDOG_NOW_MS:-$(( $(date +%s) * 1000 ))}"
  if nudge_due daemon "$DAEMON_HEALTH_URL" "$now"; then
    append_nudge "NUDGE daemon-unreachable url=$DAEMON_HEALTH_URL"
    record_nudge daemon "$DAEMON_HEALTH_URL" "$now"
  fi
  return 0
}

# ── Restart anti-thrash ─────────────────────────────────────────────────────
# Before this existed, every tick that saw a dead or stale session called
# `launch.sh start` unconditionally, at the installed 60s cadence. A provider
# that fails to come up therefore burned a launch (and its quota) once a minute,
# indefinitely, in silence. A restart is now both throttled and announced.
last_restart_at() {
  local value=0
  if [[ -f "$RESTART_STATE_FILE" ]]; then
    value="$(sed -n 's/^last_restart=//p' "$RESTART_STATE_FILE" | head -n 1)"
  fi
  [[ "$value" =~ ^[0-9]+$ ]] || value=0
  printf '%s\n' "$value"
}

record_restart_at() {
  local now="$1" tmp
  mkdir -p "$(dirname "$RESTART_STATE_FILE")"
  tmp="$(mktemp "$(dirname "$RESTART_STATE_FILE")/.watchdog-restart-state.XXXXXX")"
  printf 'last_restart=%s\n' "$now" > "$tmp"
  mv -f "$tmp" "$RESTART_STATE_FILE"
}

# supervise_restart <reason> <kill-first:0|1>
# Always terminal: it either restarts (and says so) or declines (and says why).
supervise_restart() {
  local reason="$1" kill_first="$2" now last since
  now="${ORCH_WATCHDOG_NOW:-$(date +%s)}"
  [[ "$now" =~ ^[0-9]+$ ]] || now="$(date +%s)"
  last="$(last_restart_at)"
  since=$(( now - last ))
  # A restart recorded in the future means the clock moved backwards (or the
  # state file was hand-edited). Suppressing on that would wedge recovery until
  # real time caught up, so drop the stale record instead of trusting it.
  if (( last > 0 && since < 0 )); then
    log "WATCHDOG restart-state-clock-skew last=$last now=$now action=reset"
    last=0
    since=0
  fi
  if (( last > 0 && since < RESTART_COOLDOWN_S )); then
    log "WATCHDOG restart-suppressed reason=$reason since_s=$since cooldown_s=$RESTART_COOLDOWN_S night=$WATCHDOG_NIGHT action=none"
    if nudge_due restart-suppressed "$SESSION" "$now"; then
      append_nudge "NUDGE watchdog-restart-suppressed session=$SESSION reason=$reason since_s=$since cooldown_s=$RESTART_COOLDOWN_S"
      record_nudge restart-suppressed "$SESSION" "$now"
    fi
    exit 0
  fi
  log "WATCHDOG restarting session=$SESSION reason=$reason night=$WATCHDOG_NIGHT action=restart"
  append_nudge "NUDGE watchdog-restarting session=$SESSION reason=$reason"
  record_restart_at "$now"
  if (( kill_first == 1 )); then
    "$LAUNCH_SCRIPT" stop || log "WATCHDOG restart-stop-failed session=$SESSION reason=$reason"
  fi
  if "$LAUNCH_SCRIPT" start; then
    log "WATCHDOG restarted session=$SESSION reason=$reason action=restarted"
    append_nudge "NUDGE watchdog-restarted session=$SESSION reason=$reason"
  else
    log "WATCHDOG NO-GO reason=restart-failed session=$SESSION trigger=$reason action=manual-intervention"
    append_nudge "NUDGE watchdog-restart-failed session=$SESSION reason=$reason needs=manual-intervention"
  fi
  exit 0
}

if state_available; then
  # A renewal that does not survive until the next tick is not a renewal: the
  # lease is guaranteed dead when this same script comes back to renew it. Two
  # ticks of headroom is the minimum that tolerates one skipped or slow tick.
  #
  # The comparison is `<=`, not `<`. At TTL == exactly two ticks the lease
  # expires at the very instant the second tick is due, so ANY jitter puts
  # expiry first — and systemd timers jitter by a minute at the default
  # AccuracySec. Zero margin is inside the trap this fence exists to catch, not
  # outside it. Strict `<` never fired at that boundary, and the shipped default
  # pair (60s / 120000ms) sat precisely on it, so the fence was silent in exactly
  # the configuration it was written for. The default TTL is now 180000.
  if (( LEASE_TTL_MS <= WATCHDOG_INTERVAL_S * 2000 )); then
    log "WATCHDOG NO-GO reason=lease-ttl-under-tick ttl_ms=$LEASE_TTL_MS interval_s=$WATCHDOG_INTERVAL_S needs_over_ms=$(( WATCHDOG_INTERVAL_S * 2000 )) action=no-kill"
  fi
  if ! lease_state; then
    log "SKIP reason=lease-state-missing"
  elif ! mission_cli lease renew "$LEASE_OWNER" orchestrator "$LEASE_TOKEN" "$LEASE_TTL_MS" >/dev/null 2>&1; then
    guard_lease_renew_failure
  fi
else
  log "SKIP reason=state-db-absent path=$STATE_DB"
fi

if ! session_healthy; then
  log "dead session=$SESSION action=relaunch"
  supervise_restart dead 0
fi
if heartbeat_stale; then
  # A stale heartbeat is a QUESTION, not a verdict. Ask the second signal before
  # killing anything: a busy session must never read as dead.
  watchdog_now="${ORCH_WATCHDOG_NOW:-$(date +%s)}"
  activity_age="$(session_activity_age "$watchdog_now")"
  if [[ -n "$activity_age" ]] && (( activity_age <= HEARTBEAT_MAX_AGE )); then
    # Alive and working, but the heartbeat writer has gone quiet for longer than
    # a turn should take. Never kill on this — but never swallow it either: the
    # most likely cause is that the turn-end relay itself broke, and a silently
    # tolerated broken relay is how the orchestrator's only liveness signal dies
    # unnoticed. Log every tick, nudge the operator on the usual throttle.
    log "WATCHDOG NO-GO reason=heartbeat-stale-session-active session=$SESSION activity_age_s=$activity_age max_age_s=$HEARTBEAT_MAX_AGE action=no-kill"
    now_ms="${ORCH_WATCHDOG_NOW_MS:-$(( watchdog_now * 1000 ))}"
    if nudge_due heartbeat-stale-active "$SESSION" "$now_ms"; then
      append_nudge "NUDGE heartbeat-stale-session-active session=$SESSION activity_age_s=$activity_age max_age_s=$HEARTBEAT_MAX_AGE"
      record_nudge heartbeat-stale-active "$SESSION" "$now_ms"
    fi
  elif [[ -f "$HEARTBEAT_FILE" ]]; then
    log "zombie session=$SESSION activity_age_s=${activity_age:-unavailable} action=kill-relaunch"
    supervise_restart zombie 1
  else
    log "heartbeat-missing session=$SESSION activity_age_s=${activity_age:-unavailable} action=kill-relaunch"
    supervise_restart heartbeat-missing 1
  fi
fi

check_daemon_health || log "WATCHDOG observability-check-failed check=daemon-health"
check_disk_pressure || log "WATCHDOG observability-check-failed check=disk-pressure"
check_mission_pressure || log "WATCHDOG observability-check-failed check=mission-pressure"
exit 0
