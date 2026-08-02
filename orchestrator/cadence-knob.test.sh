#!/usr/bin/env bash
# Divergence lock for the watchdog tick cadence.
#
# The defect this suite exists for was not a wrong number, it was three numbers
# that never had to agree: bootstrap/env.template documented
# ORCH_WATCHDOG_INTERVAL_SECONDS=600, nothing on the box read that name,
# watchdog.sh and install-watchdog.sh read ORCH_WATCHDOG_INTERVAL with a default
# of 60, and the rendered systemd timer carried a hard-coded 10min. A fresh
# install therefore ticked at one cadence, computed its lease arithmetic against
# another, and told the operator a third. Every assertion below fails if any of
# those four surfaces drifts apart again.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SCRATCH="$(mktemp -d)"
SHIM="$SCRATCH/bin"
trap 'rm -rf "$SCRATCH"' EXIT
mkdir -p "$SHIM"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

TEMPLATE="$REPO_DIR/bootstrap/env.template"
TIMER_TEMPLATE="$REPO_DIR/bootstrap/units/bpa-orchestrator-watchdog.timer.in"
SERVICE_TEMPLATE="$REPO_DIR/bootstrap/units/bpa-orchestrator-watchdog.service.in"
LAUNCHER_TEMPLATE="$REPO_DIR/bootstrap/units/bpa-orchestrator.service.in"
INSTALL_SH="$REPO_DIR/bootstrap/install.sh"

# Wrong-session regression: render the canonical units, load their real
# EnvironmentFile, and execute both production resolvers. Static template grep
# alone can pass while one script resolves a different runtime boundary.
# shellcheck disable=SC2016
grep -Fq 'Environment=ORCH_CONFIG_FILE=$ENV_FILE' "$SERVICE_TEMPLATE" ||
  fail 'installed watchdog does not source the canonical launcher config'
# shellcheck disable=SC2016
grep -Fq 'Environment=ORCH_CONFIG_FILE=$ENV_FILE' "$LAUNCHER_TEMPLATE" ||
  fail 'installed launcher does not source the canonical config'
grep -Eq '^ORCH_SESSION=[^[:space:]]+$' "$TEMPLATE" ||
  fail 'instance config does not declare the orchestrator session'
if grep -Eq 'Environment=ORCH_SESSION=' "$SERVICE_TEMPLATE" "$LAUNCHER_TEMPLATE"; then
  fail 'an installed unit shadows the canonical configured session'
fi

IDENTITY_ENV="$SCRATCH/identity.env"
IDENTITY_RUNTIME="$SCRATCH/identity-runtime"
cat > "$IDENTITY_ENV" <<EOF
ORCH_SESSION=identity-session
ORCH_RUNTIME_DIR=$IDENTITY_RUNTIME
ORCH_STATE_DB=$SCRATCH/identity-state.db
ORCH_LEASE_FILE=$IDENTITY_RUNTIME/identity.lease
ORCH_LAUNCH_SCRIPT=$SCRIPT_DIR/launch.sh
ORCH_WATCHDOG_INTERVAL=60
ORCH_LEASE_TTL_MS=180000
EOF
launcher_identity="$(ORCH_CONFIG_FILE="$IDENTITY_ENV" "$SCRIPT_DIR/launch.sh" identity)"
watchdog_identity="$(ORCH_CONFIG_FILE="$IDENTITY_ENV" "$SCRIPT_DIR/watchdog.sh" identity)"
[[ "$launcher_identity" == "$watchdog_identity" ]] ||
  fail "installed launcher/watchdog resolve different behavioral identity"$'\n'"launcher:$launcher_identity"$'\n'"watchdog:$watchdog_identity"
for expected in \
  'session=identity-session' \
  "runtime_dir=$IDENTITY_RUNTIME" \
  "state_db=$SCRATCH/identity-state.db" \
  "lease_file=$IDENTITY_RUNTIME/identity.lease" \
  "launcher=$SCRIPT_DIR/launch.sh" \
  "config_file=$IDENTITY_ENV"; do
  grep -Fxq "$expected" <<<"$watchdog_identity" ||
    fail "behavioral identity omitted $expected"
done

template_value() { sed -n "s/^$1=//p" "$TEMPLATE" | tail -n 1; }
# The effective numeric default baked into a `VAR="${KNOB:-…}"` expansion. The
# innermost literal wins, so a knob written as a fallback CHAIN
# (`${KNOB:-${DEPRECATED_ALIAS:-60}}`) still reports 60.
shell_default() {
  sed -nE "s/^[A-Z_]+=\"\\\$\{$2:-(.*)\}\"\$/\1/p" "$1" | head -n 1 |
    grep -oE '[0-9]+' | tail -n 1
}

# ── 1. Every cadence name the template ships must be read by the code ───────
# This is the assertion that would have caught the original defect on the day it
# landed: a knob documented to the operator that no reader resolves is not a
# knob, it is a lie with a number in it.
while IFS= read -r name; do
  [[ -n "$name" ]] || continue
  grep -q "$name" "$SCRIPT_DIR/watchdog.sh" ||
    fail "bootstrap/env.template ships $name but orchestrator/watchdog.sh never reads it"
  grep -q "$name" "$SCRIPT_DIR/install-watchdog.sh" ||
    fail "bootstrap/env.template ships $name but orchestrator/install-watchdog.sh never reads it"
done < <(sed -nE 's/^(ORCH_WATCHDOG_INTERVAL[A-Z_]*)=.*/\1/p' "$TEMPLATE")

TEMPLATE_INTERVAL="$(template_value ORCH_WATCHDOG_INTERVAL)"
[[ "$TEMPLATE_INTERVAL" =~ ^[1-9][0-9]*$ ]] ||
  fail "bootstrap/env.template must set a positive ORCH_WATCHDOG_INTERVAL (got '$TEMPLATE_INTERVAL')"

# ── 2. The rendered timer must carry the template's cadence ─────────────────
# The timer is what actually decides how often the tick runs. It used to be
# hard-coded, so the operator could set any number they liked in .env and the
# real cadence never moved.
# shellcheck disable=SC2016  # the literal envsubst placeholder is the assertion
grep -q 'OnUnitActiveSec=${ORCH_WATCHDOG_INTERVAL}' "$TIMER_TEMPLATE" ||
  fail 'bpa-orchestrator-watchdog.timer.in hard-codes its cadence instead of rendering ORCH_WATCHDOG_INTERVAL'
grep -q 'ORCH_WATCHDOG_INTERVAL=' "$INSTALL_SH" ||
  fail 'bootstrap/install.sh does not pass ORCH_WATCHDOG_INTERVAL to envsubst; the timer would render empty'

rendered="$(ORCH_WATCHDOG_INTERVAL="$TEMPLATE_INTERVAL" envsubst < "$TIMER_TEMPLATE")"
grep -qx "OnUnitActiveSec=${TEMPLATE_INTERVAL}s" <<<"$rendered" ||
  fail "rendered timer cadence does not match the template value ${TEMPLATE_INTERVAL}s"

# ── 3. install-watchdog.sh renders the same cadence, alias included ─────────
cat > "$SHIM/systemctl" <<'EOF'
#!/usr/bin/env bash
printf 'systemctl %s\n' "$*" >> "${ORCH_TEST_SYSTEMCTL_CALLS:?}"
exit 0
EOF
chmod +x "$SHIM/systemctl"
export ORCH_TEST_SYSTEMCTL_CALLS="$SCRATCH/systemctl.calls"

install_unit_dir() { # <unit-dir> <env assignments...>
  local dir="$1"; shift
  mkdir -p "$dir"
  env PATH="$SHIM:$PATH" ORCH_SYSTEMD_USER_DIR="$dir" ORCH_WATCHDOG_UNIT=cadence-fixture \
    "$@" "$SCRIPT_DIR/install-watchdog.sh" install >/dev/null
}

install_unit_dir "$SCRATCH/units-canonical" ORCH_WATCHDOG_INTERVAL=123
grep -qx 'OnUnitActiveSec=123' "$SCRATCH/units-canonical/cadence-fixture.timer" ||
  fail 'install-watchdog.sh ignored ORCH_WATCHDOG_INTERVAL'

# The deprecated spelling is honoured on purpose: every .env written by the old
# template carries it, and dropping it silently would change those hosts a
# second time without telling anyone.
install_unit_dir "$SCRATCH/units-alias" ORCH_WATCHDOG_INTERVAL_SECONDS=600
grep -qx 'OnUnitActiveSec=600' "$SCRATCH/units-alias/cadence-fixture.timer" ||
  fail 'install-watchdog.sh ignored the deprecated ORCH_WATCHDOG_INTERVAL_SECONDS alias'

# The canonical name wins when both are present.
install_unit_dir "$SCRATCH/units-both" ORCH_WATCHDOG_INTERVAL=45 ORCH_WATCHDOG_INTERVAL_SECONDS=600
grep -qx 'OnUnitActiveSec=45' "$SCRATCH/units-both/cadence-fixture.timer" ||
  fail 'the deprecated alias outranked the canonical ORCH_WATCHDOG_INTERVAL'

# ── 4. Shipped defaults must satisfy the fence they are measured against ────
# watchdog.sh and launch.sh both carry a lease TTL default and must carry the
# SAME one: the watchdog is the only renewer of what the launcher acquires.
WATCHDOG_TTL_DEFAULT="$(shell_default "$SCRIPT_DIR/watchdog.sh" ORCH_LEASE_TTL_MS)"
LAUNCH_TTL_DEFAULT="$(shell_default "$SCRIPT_DIR/launch.sh" ORCH_LEASE_TTL_MS)"
INTERVAL_DEFAULT="$(shell_default "$SCRIPT_DIR/watchdog.sh" ORCH_WATCHDOG_INTERVAL)"
[[ "$WATCHDOG_TTL_DEFAULT" =~ ^[0-9]+$ && "$LAUNCH_TTL_DEFAULT" =~ ^[0-9]+$ && "$INTERVAL_DEFAULT" =~ ^[0-9]+$ ]] ||
  fail 'could not read the shipped lease-TTL / interval defaults'
[[ "$WATCHDOG_TTL_DEFAULT" == "$LAUNCH_TTL_DEFAULT" ]] ||
  fail "watchdog.sh defaults the lease TTL to $WATCHDOG_TTL_DEFAULT but launch.sh to $LAUNCH_TTL_DEFAULT: one number, not two"
(( WATCHDOG_TTL_DEFAULT > INTERVAL_DEFAULT * 2000 )) ||
  fail "the shipped defaults sit on or inside the fence: ${WATCHDOG_TTL_DEFAULT}ms TTL against two ${INTERVAL_DEFAULT}s ticks"

# The template pair has to clear the same bar, or a bootstrap install starts life
# logging a NO-GO on every tick.
TEMPLATE_TTL="$(template_value ORCH_LEASE_TTL_MS)"
[[ "$TEMPLATE_TTL" =~ ^[1-9][0-9]*$ ]] ||
  fail 'bootstrap/env.template does not pin ORCH_LEASE_TTL_MS alongside its slower cadence'
(( TEMPLATE_TTL > TEMPLATE_INTERVAL * 2000 )) ||
  fail "bootstrap/env.template ships ${TEMPLATE_TTL}ms against two ${TEMPLATE_INTERVAL}s ticks: the lease dies between renewals"

# ── 5. The fence must fire AT the boundary, not just below it ───────────────
# TTL == exactly two ticks means the lease expires at the instant the second tick
# is due, so any scheduling jitter puts expiry first. The comparison used to be
# strict `<`, which never fired there — and the old default pair (60s/120000ms)
# sat precisely on that boundary, so the guard was silent in exactly the
# configuration it was written for.
cat > "$SHIM/tmux" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  has-session) exit 0 ;;
  list-panes) ps -o ppid= -p "$PPID" | tr -d ' ' ;;
  list-windows) date +%s ;;
  *) exit 0 ;;
esac
EOF
cat > "$SCRATCH/launch.sh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$1" >> "${ORCH_TEST_ACTIONS:?}"
EOF
chmod +x "$SHIM/tmux" "$SCRATCH/launch.sh"

STATE_DB="$SCRATCH/state.db"
INFRA_STATE_DB="$STATE_DB" bun "$REPO_DIR/core/mission-cli.ts" status >/dev/null

fence_tick() { # <log> <env assignments...>
  local log="$1"; shift
  local runtime; runtime="$(mktemp -d "$SCRATCH/fence.XXXXXX")"
  env PATH="$SHIM:$PATH" ORCH_CONFIG_FILE="$SCRATCH/no-config" ORCH_STATE_DB="$STATE_DB" \
    ORCH_RUNTIME_DIR="$runtime" ORCH_WATCHDOG_LOG="$log" \
    ORCH_LEASE_FILE="$runtime/orchestrator.lease" \
    ORCH_HEARTBEAT_FILE="$runtime/orchestrator.heartbeat" \
    ORCH_HEARTBEAT_MISSING_SINCE_FILE="$runtime/heartbeat-missing-since" \
    ORCH_RESTART_STATE_FILE="$runtime/watchdog-restart-state" \
    NUDGE_OUTBOX_FILE="$runtime/nudges.outbox" NUDGE_RATE_FILE="$runtime/nudge-rate.tsv" \
    ORCH_INSTANCE_LOCK_FILE="$runtime/instance.lock" \
    ORCH_DONE_SENTINEL="$SCRATCH/no-done-sentinel" ORCH_DAEMON_HEALTH_URL="" \
    ORCH_LAUNCH_SCRIPT="$SCRATCH/launch.sh" ORCH_TEST_ACTIONS="$SCRATCH/actions" \
    ORCH_INSTALL_ROOT="$SCRATCH" DOCKER_PRUNE_ENABLED=0 \
    "$@" "$SCRIPT_DIR/watchdog.sh"
}
fired() { grep -q 'NO-GO reason=lease-ttl-under-tick' "$1"; }

BOUNDARY_LOG="$SCRATCH/boundary.log"
fence_tick "$BOUNDARY_LOG" ORCH_WATCHDOG_INTERVAL=60 ORCH_LEASE_TTL_MS=120000
fired "$BOUNDARY_LOG" ||
  fail 'a TTL of exactly two ticks did not trip the fence: zero headroom is inside the trap, not outside it'

INSIDE_LOG="$SCRATCH/inside.log"
fence_tick "$INSIDE_LOG" ORCH_WATCHDOG_INTERVAL=60 ORCH_LEASE_TTL_MS=119999
fired "$INSIDE_LOG" || fail 'a TTL under two ticks did not trip the fence'

CLEAR_LOG="$SCRATCH/clear.log"
fence_tick "$CLEAR_LOG" ORCH_WATCHDOG_INTERVAL=60 ORCH_LEASE_TTL_MS=120001
! fired "$CLEAR_LOG" || fail 'a TTL with headroom tripped the fence'

# The alias must reach the fence too, or a host configured the old way computes
# its lease arithmetic against a cadence it is not running at.
ALIAS_LOG="$SCRATCH/alias.log"
fence_tick "$ALIAS_LOG" ORCH_WATCHDOG_INTERVAL_SECONDS=600 ORCH_LEASE_TTL_MS=1200000
fired "$ALIAS_LOG" ||
  fail 'the deprecated cadence alias never reached the lease fence'
grep -q 'interval_s=600' "$ALIAS_LOG" ||
  fail 'the fence logged a cadence other than the one configured through the alias'

printf 'cadence knob tests: PASS\n'
