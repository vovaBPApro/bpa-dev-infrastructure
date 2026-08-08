#!/usr/bin/env bash
# Regression lock for V3-5.29: the orchestrator must survive a restart of the
# unit that launched it.
#
# WHAT FAILED, AND WHY A UNIT TEST OF THE LAUNCHER WOULD NOT HAVE CAUGHT IT.
# On 2026-08-06 at 06:16:44 local, unattended-upgrades restarted
# bpa-telegram-daemon.service. The fleet went headless for 71 minutes. Every
# tracked file was correct and every deployed unit matched its template; what was
# wrong was where a PROCESS lived. `orchestrator/launch.sh` was invoked from the
# daemon's relaunch path, the tmux server it spawned inherited the daemon's
# cgroup, and systemd stops a unit by killing that cgroup. No assertion about
# launch.sh's arguments, output, exit status or rendered command line can see
# that -- the defect is only visible in /proc/<pid>/cgroup, and only fatal when
# something else is stopped.
#
# So the load-bearing case in this file is a REHEARSAL, not an inspection: a
# daemon-analog unit is really started, a tmux server is really spawned from
# inside it, the daemon-analog is really stopped, and the session is asked
# whether it is still alive. The pre-fix spawn is run through the same fixture as
# a control and must DIE; that is the red-before, executed rather than described,
# and it is what makes the green-after mean anything.
#
# The real bpa-telegram-daemon.service is never touched. It carries the
# operator's live channel -- and this lane's own nudge path -- so restarting it to
# test a fix for it would reproduce the outage in order to prove it was fixed.
# Every fixture unit is named through probe_unit_name (V3-5.19: the `lane-`
# namespace is an interface two censuses read), and every fixture tmux session
# lives on a private `-L` socket, never the default one the live orchestrator
# owns.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
LIB="$SCRIPT_DIR/tmux-isolation.sh"
LAUNCH="$SCRIPT_DIR/launch.sh"
CHECK="$REPO/bootstrap/check-orchestrator-cgroup-drift.sh"
# shellcheck source=orchestrator/fleet/probe-unit-namespace.sh
. "$SCRIPT_DIR/fleet/probe-unit-namespace.sh"

failures=0
pass() { printf 'ok   %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1"; failures=$((failures + 1)); }
check() { # check <name> <status> [detail]
  if (( $2 == 0 )); then pass "$1"; else fail "$1${3:+ — $3}"; fi
}

capability_forced_missing() {
  [[ ",${INFRA_TEST_FORCE_MISSING_CAPABILITIES:-}," == *",$1,"* ]]
}

SCRATCH="$(mktemp -d)"
declare -a PROBE_UNITS=()
declare -a PROBE_SOCKETS=()
cleanup() {
  local u s
  for s in ${PROBE_SOCKETS[@]+"${PROBE_SOCKETS[@]}"}; do
    tmux -L "$s" kill-server >/dev/null 2>&1 || true
  done
  for u in ${PROBE_UNITS[@]+"${PROBE_UNITS[@]}"}; do
    systemctl stop "$u" >/dev/null 2>&1 || true
    systemctl reset-failed "$u" >/dev/null 2>&1 || true
  done
  rm -rf "$SCRATCH"
  return 0
}
trap cleanup EXIT

[[ -r "$LIB" ]] || { printf 'FAIL the isolation library is missing: %s\n' "$LIB"; exit 1; }
# shellcheck source=orchestrator/tmux-isolation.sh
. "$LIB"

# ───────────────────────────────────────────────────────────────────────────
# 1. The predicate reads a cgroup path the way systemd owns lifecycles.
#
# Table-driven against literal cgroup strings, including the exact one measured
# on the live host during the outage. These need no systemd, so the core rule is
# proven even where the live case below is excluded.
# ───────────────────────────────────────────────────────────────────────────
unit_of() { tmux_isolation_unit_of_cgroup "$1"; }

[[ "$(unit_of '/system.slice/bpa-telegram-daemon.service')" == 'bpa-telegram-daemon.service' ]]
check "the measured outage cgroup resolves to the telegram daemon unit" $?

[[ "$(unit_of '/system.slice/bpa-orchestrator-tmux.scope')" == 'bpa-orchestrator-tmux.scope' ]]
check "a scope cgroup resolves to the scope unit" $?

# A process may sit BELOW its unit (delegated subtrees, container payloads). The
# lifecycle that can kill it is the nearest enclosing unit, so the walk is from
# the leaf upward -- reading from the root would have named the outer slice.
[[ "$(unit_of '/system.slice/bpa-telegram-daemon.service/payload/leaf')" == 'bpa-telegram-daemon.service' ]]
check "a nested cgroup resolves to its innermost enclosing unit" $?

[[ -z "$(unit_of '/')" ]]
check "a cgroup naming no systemd unit resolves to nothing" $?

# ───────────────────────────────────────────────────────────────────────────
# 2. The verdict discriminates, and does so by allowlist.
#
# A predicate that cannot refuse anything passes every other assertion in this
# file while protecting nothing, so it is shown refusing the exact placement that
# caused the outage — and accepting only the two the orchestrator itself owns.
# ───────────────────────────────────────────────────────────────────────────
verdict_of() { tmux_isolation_verdict "$1" "$2" 2>/dev/null; }

daemon_verdict="$(verdict_of 'bpa-telegram-daemon.service' '/system.slice/bpa-telegram-daemon.service')"
daemon_status=$?
(( daemon_status != 0 ))
check "the telegram daemon cgroup is refused" $? "verdict: $daemon_verdict"
[[ "$daemon_verdict" == *'reason=inside-the-telegram-daemon-cgroup'* ]]
check "the refusal names the measured cause rather than a generic one" $? "$daemon_verdict"

verdict_of "$ORCH_TMUX_SCOPE.scope" '/system.slice/bpa-orchestrator-tmux.scope' >/dev/null
check "the orchestrator's own scope is accepted" $?

verdict_of "$ORCH_TMUX_UNIT" '/system.slice/bpa-orchestrator.service' >/dev/null
check "the orchestrator's own service is accepted" $?

# The allowlist half: a unit that is neither, and has nothing to do with the
# daemon, must still be refused. A denylist would have let this through, and the
# next host mechanism nobody thought to list is the next 71 minutes.
foreign_verdict="$(verdict_of 'bpa-orchestrator-watchdog.service' '/system.slice/bpa-orchestrator-watchdog.service')"
foreign_status=$?
(( foreign_status != 0 ))
check "an unrelated unit is refused too (allowlist, not a denylist)" $? "verdict: $foreign_verdict"

# The watchdog case is not hypothetical: orchestrator/watchdog.sh calls
# `launch.sh start`, and its unit is Type=oneshot with no RemainAfterExit, so its
# cgroup is torn down the instant the watchdog script returns. A restart from
# that path would have spawned an orchestrator with a lifetime of milliseconds.
grep -q '"\$LAUNCH_SCRIPT" start' "$SCRIPT_DIR/watchdog.sh"
check "the watchdog still restarts through launch.sh (the second unisolated caller)" $? \
  'orchestrator/watchdog.sh no longer calls the launcher — re-derive which callers need this fix'

# ───────────────────────────────────────────────────────────────────────────
# 3. An unmeasurable subject is its own outcome, never a pass.
# ───────────────────────────────────────────────────────────────────────────
tmux_isolation_check_pid '' >/dev/null 2>&1
[[ $? -eq 2 ]]
check "an empty pid is UNMEASURABLE (exit 2), not clean" $?

tmux_isolation_check_pid 'not-a-pid' >/dev/null 2>&1
[[ $? -eq 2 ]]
check "a malformed pid is UNMEASURABLE (exit 2), not clean" $?

# A pid that certainly does not exist. 4194304 is above the default pid_max, so
# it can never be live and the case cannot flake on pid reuse.
tmux_isolation_check_pid 4194304 >/dev/null 2>&1
[[ $? -eq 2 ]]
check "a dead pid is UNMEASURABLE (exit 2), not clean" $?

# ───────────────────────────────────────────────────────────────────────────
# 4. The launcher is wired to the one home, and has no second spawn path.
#
# The mechanism is only as good as its wiring, and the failure mode is silent: a
# future edit restoring a bare `tmux new-session` would reintroduce the outage
# with every test above still green.
# ───────────────────────────────────────────────────────────────────────────
grep -q 'source "\$SCRIPT_DIR/tmux-isolation.sh"' "$LAUNCH"
check "launch.sh sources the isolation library" $?

grep -q 'tmux_isolation_spawn new-session' "$LAUNCH"
check "launch.sh creates its session through tmux_isolation_spawn" $?

grep -q 'tmux_isolation_assert_session "\$SESSION"' "$LAUNCH"
check "launch.sh verifies placement against the live server" $?

# The refusal must be a refusal. A verified-then-warned launcher reports success
# for an orchestrator that dies on the next apt upgrade.
grep -A2 'if ! tmux_isolation_assert_session "\$SESSION"; then' "$LAUNCH" | grep -q 'kill-session'
check "an unisolated session is torn down rather than warned about" $?

! grep -Eq '^[[:space:]]*(if !|)[[:space:]]*tmux new-session' "$LAUNCH"
check "launch.sh has no bare tmux new-session left" $? \
  'a second, unisolated spawn path would reintroduce the outage silently'

# The launcher must not select the fixture escapes for itself.
! grep -q 'ORCH_TMUX_ISOLATION=' "$LAUNCH"
check "launch.sh does not set the isolation mode knob" $?
! grep -q 'ORCH_TMUX_SOCKET=' "$LAUNCH"
check "launch.sh does not set the fixture tmux socket" $?

# ───────────────────────────────────────────────────────────────────────────
# 5. The off switch is reachable only from fixtures.
#
# ORCH_TMUX_ISOLATION=none disables the scope AND the verification. It exists
# because suites that stub tmux with a recorder have no real server to place or
# measure. If it ever appears in shipped code -- a script, a unit template, an env
# file -- the protection is off in production and every other assertion here is
# still green. So the tracked tree is scanned, not trusted.
# ───────────────────────────────────────────────────────────────────────────
mapfile -t isolation_off_files < <(
  cd "$REPO" && git grep -l -E '(^|[[:space:]])(export[[:space:]]+)?ORCH_TMUX_ISOLATION=none' -- . 2>/dev/null || true
)
offenders=()
for f in ${isolation_off_files[@]+"${isolation_off_files[@]}"}; do
  [[ "$f" == *.test.sh || "$f" == *.test.ts ]] || offenders+=("$f")
done
(( ${#offenders[@]} == 0 ))
check "the isolation off switch is selected only by test fixtures" $? \
  "shipped files select it: ${offenders[*]:-}"

# Vacuity guard. If the scan matches nothing at all it is not enforcing a rule,
# it is failing to read -- the exact shape V3-5.19 round 1 had to repair.
(( ${#isolation_off_files[@]} >= 1 ))
check "the off-switch scan found the fixtures that do select it" $? \
  'the scan matched no file; it proves nothing'

# ───────────────────────────────────────────────────────────────────────────
# 6. The drift check reports four distinct outcomes.
#
# Held to the SCRIPT, not to the predicate it calls: the exit code is what a
# monitor or a landing gate reads, and conflating "isolated" with "no
# orchestrator at all" would report a dead fleet as healthy.
# ───────────────────────────────────────────────────────────────────────────
[[ -x "$CHECK" ]]
check "the drift check is executable" $? "$CHECK"

# Both the owned foreign-process fixture below and the lifecycle rehearsal use
# transient units. Probe that capability once, and make absence an explicit
# exclusion rather than silently falling back to the ambient test runner (which
# may correctly live in the allowlisted orchestrator service).
systemd_usable=true
capability_probe="$(probe_unit_name isolation-capability "$$")" || systemd_usable=false
if capability_forced_missing systemd-transient-unit; then
  systemd_usable=false
elif ! command -v systemd-run >/dev/null 2>&1 || ! command -v tmux >/dev/null 2>&1; then
  systemd_usable=false
elif ! timeout 60 systemd-run --collect --wait --quiet --unit "$capability_probe" \
  /bin/true >/dev/null 2>&1; then
  systemd_usable=false
fi
systemctl reset-failed "$capability_probe" >/dev/null 2>&1 || true

bash "$CHECK" --pid 4194304 >/dev/null 2>&1
[[ $? -eq 2 ]]
check "the drift check exits 2 on an unmeasurable subject" $?

ORCH_TMUX_SOCKET="no-such-socket-$$" bash "$CHECK" --session "no-such-session-$$" >/dev/null 2>&1
[[ $? -eq 3 ]]
check "the drift check exits 3 when there is no session, distinct from clean" $?

# Own the subject and prove its placement before testing the checker. The test
# runner is deliberately unsuitable: when this suite is launched by the
# correctly deployed bpa-orchestrator.service, $$ is allowlisted and exit 0 is
# the honest production verdict.
if ! "$systemd_usable"; then
  printf '%s\n' 'tmux-isolation: EXCLUDED case=foreign-cgroup-verdict capability=systemd-transient-unit'
else
  foreign_unit="$(probe_unit_name drift-foreign "$$")" || foreign_unit=''
  foreign_pid=''
  foreign_cgroup=''
  if [[ -n "$foreign_unit" ]]; then
    PROBE_UNITS+=("$foreign_unit.service")
    systemctl reset-failed "$foreign_unit.service" >/dev/null 2>&1 || true
    timeout 60 systemd-run --collect --quiet --unit "$foreign_unit" \
      /bin/sleep 300 >/dev/null 2>&1 || foreign_unit=''
  fi
  if [[ -n "$foreign_unit" ]]; then
    deadline=$((SECONDS + 20))
    until [[ "$foreign_pid" =~ ^[1-9][0-9]*$ ]]; do
      (( SECONDS < deadline )) || break
      foreign_pid="$(systemctl show --property MainPID --value "$foreign_unit.service" 2>/dev/null)"
      [[ "$foreign_pid" =~ ^[1-9][0-9]*$ ]] || sleep 0.2
    done
  fi
  if [[ "$foreign_pid" =~ ^[1-9][0-9]*$ ]]; then
    foreign_cgroup="$(sed -n 's|^0::||p' "/proc/$foreign_pid/cgroup" 2>/dev/null | head -n 1)"
  fi
  [[ -n "$foreign_unit" && "$(unit_of "$foreign_cgroup")" == "$foreign_unit.service" ]]
  check "the foreign-process fixture owns and proves its cgroup" $? \
    "unit=${foreign_unit:-<missing>} pid=${foreign_pid:-<missing>} cgroup=${foreign_cgroup:-<unread>}"
  bash "$CHECK" --pid "$foreign_pid" >/dev/null 2>&1
  [[ $? -eq 1 ]]
  check "the drift check exits 1 for the owned foreign-cgroup process" $?
fi

# ───────────────────────────────────────────────────────────────────────────
# 7. LIVE REHEARSAL: the property itself.
#
# Everything above inspects. This runs the failure.
# ───────────────────────────────────────────────────────────────────────────
if ! "$systemd_usable"; then
  printf '%s\n' 'tmux-isolation: EXCLUDED case=daemon-restart-rehearsal capability=systemd-transient-unit'
else
  # The payload runs INSIDE the daemon-analog unit and is the only thing that
  # differs between the control and the fix: `none` is the pre-fix spawn (bare
  # tmux, caller's cgroup), `systemd` is the shipped one. Both go through the
  # production helper, so the control is the real old behaviour rather than a
  # re-implementation of it that might not match.
  payload="$SCRATCH/spawn-in-unit.sh"
  cat > "$payload" <<'PAYLOAD'
#!/usr/bin/env bash
set -euo pipefail
mode="$1"; lib="$2"; sock="$3"; scope="$4"; session="$5"
export ORCH_TMUX_ISOLATION="$mode"
export ORCH_TMUX_SOCKET="$sock"
export ORCH_TMUX_SCOPE="$scope"
# shellcheck source=orchestrator/tmux-isolation.sh
. "$lib"
tmux_isolation_spawn new-session -d -s "$session" /bin/sleep 600
exec /bin/sleep 600
PAYLOAD
  chmod +x "$payload"

  # rehearse <mode> -> sets REHEARSAL_CGROUP and REHEARSAL_OUTCOME
  # (survived|died|no-session), leaving nothing running.
  rehearse() {
    local mode="$1" unit scope sock session pid deadline
    REHEARSAL_CGROUP=''
    REHEARSAL_OUTCOME='no-session'
    unit="$(probe_unit_name daemon-analog "$mode" "$$")" || return 1
    scope="$(probe_unit_name orch-tmux "$mode" "$$")" || return 1
    sock="infra-probe-tmux-$mode-$$"
    session="orch-analog"
    PROBE_UNITS+=("$unit.service" "$scope.scope")
    PROBE_SOCKETS+=("$sock")
    systemctl reset-failed "$unit.service" "$scope.scope" >/dev/null 2>&1 || true
    timeout 60 systemd-run --collect --quiet --unit "$unit" \
      /bin/bash "$payload" "$mode" "$LIB" "$sock" "$scope" "$session" >/dev/null 2>&1 || return 1

    deadline=$((SECONDS + 20))
    until tmux -L "$sock" has-session -t "$session" 2>/dev/null; do
      (( SECONDS < deadline )) || return 1
      sleep 0.2
    done
    pid="$(tmux -L "$sock" display-message -p -t "$session" '#{pid}' 2>/dev/null)" || pid=''
    [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
    REHEARSAL_CGROUP="$(sed -n 's|^0::||p' "/proc/$pid/cgroup" 2>/dev/null | head -n 1)"

    # The daemon restart, in miniature: systemd stops the unit, which kills its
    # whole cgroup. Nothing signals the tmux server directly.
    systemctl stop "$unit.service" >/dev/null 2>&1 || true
    deadline=$((SECONDS + 20))
    while systemctl is-active --quiet "$unit.service"; do
      (( SECONDS < deadline )) || break
      sleep 0.2
    done
    sleep 1
    if tmux -L "$sock" has-session -t "$session" 2>/dev/null; then
      REHEARSAL_OUTCOME='survived'
    else
      REHEARSAL_OUTCOME='died'
    fi
    tmux -L "$sock" kill-server >/dev/null 2>&1 || true
    systemctl stop "$scope.scope" >/dev/null 2>&1 || true
    systemctl reset-failed "$unit.service" "$scope.scope" >/dev/null 2>&1 || true
    return 0
  }

  # ── Control: the pre-fix spawn. This MUST die, or the fixture is not
  # reproducing the outage and the green half below proves nothing.
  if rehearse none; then
    [[ "$REHEARSAL_CGROUP" == *"daemon-analog-none-$$.service" ]]
    check "red-before: the pre-fix spawn lands in the caller's own cgroup" $? \
      "cgroup: ${REHEARSAL_CGROUP:-<unread>}"
    [[ "$REHEARSAL_OUTCOME" == died ]]
    check "red-before: the pre-fix session dies when the caller unit is stopped" $? \
      "outcome: $REHEARSAL_OUTCOME"
  else
    fail "the pre-fix control rehearsal could not run; the green case below would prove nothing"
  fi

  # ── The fix.
  if rehearse systemd; then
    [[ "$REHEARSAL_CGROUP" == *"/infra-probe-orch-tmux-systemd-$$.scope" ]]
    check "green-after: the session's server lands in its own scope, outside the caller" $? \
      "cgroup: ${REHEARSAL_CGROUP:-<unread>}"
    [[ "$REHEARSAL_OUTCOME" == survived ]]
    check "green-after: the session SURVIVES the caller unit being stopped" $? \
      "outcome: $REHEARSAL_OUTCOME"
  else
    fail "the isolated rehearsal could not run"
  fi

  # ── And the drift check agrees with the rehearsal, on a live server.
  # Same subject, independent reader: the check must call the isolated placement
  # clean and the unisolated one drift, or the monitor and the mechanism disagree.
  live_scope="$(probe_unit_name check-agrees "$$")" || live_scope=''
  live_sock="infra-probe-check-$$"
  if [[ -n "$live_scope" ]]; then
    PROBE_UNITS+=("$live_scope.scope")
    PROBE_SOCKETS+=("$live_sock")
    (
      export ORCH_TMUX_SCOPE="$live_scope" ORCH_TMUX_SOCKET="$live_sock"
      # shellcheck source=orchestrator/tmux-isolation.sh
      . "$LIB"
      tmux_isolation_spawn new-session -d -s check-agrees /bin/sleep 300 >/dev/null 2>&1
    )
    ORCH_TMUX_SCOPE="$live_scope" ORCH_TMUX_SOCKET="$live_sock" \
      bash "$CHECK" --session check-agrees >/dev/null 2>&1
    check "the drift check reports a live, correctly scoped server as clean" $?

    # The same live server, judged against the DEFAULT expectation: its scope is
    # not bpa-orchestrator-tmux.scope, so the check must call it drift. This is
    # what turns the check red on today's host.
    ORCH_TMUX_SOCKET="$live_sock" bash "$CHECK" --session check-agrees >/dev/null 2>&1
    [[ $? -eq 1 ]]
    check "the drift check reports a server outside the expected scope as drift" $?

    tmux -L "$live_sock" kill-server >/dev/null 2>&1 || true
    systemctl stop "$live_scope.scope" >/dev/null 2>&1 || true
    systemctl reset-failed "$live_scope.scope" >/dev/null 2>&1 || true
  else
    fail 'could not name the live check probe'
  fi
  printf '%s\n' 'tmux-isolation: RAN case=daemon-restart-rehearsal'
fi

if (( failures > 0 )); then
  printf 'tmux isolation: FAIL (%d)\n' "$failures"
  exit 1
fi
printf 'tmux isolation: PASS\n'
