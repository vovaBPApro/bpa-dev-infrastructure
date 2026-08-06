#!/usr/bin/env bash
# One home for the orchestrator's cgroup isolation: where its tmux server is
# born, and how anything else decides whether that placement is correct.
#
# THE OUTAGE THIS EXISTS TO KEEP DEAD (2026-08-06, workboard V3-5.29).
# At 06:16:44 local, unattended-upgrades restarted bpa-telegram-daemon.service.
# The orchestrator died with it and the fleet ran headless for 71 minutes.
# Nothing was wrong with the orchestrator: the daemon's relaunch path calls
# `orchestrator/launch.sh start` (daemon/server.ts), a tmux server inherits the
# cgroup of whoever spawns it, and systemd stops a unit by killing its whole
# cgroup. So the tmux server sat in /system.slice/bpa-telegram-daemon.service and
# every daemon restart -- apt, deploy, crash -- was an orchestrator kill. Measured
# on the live host: the tmux server pid's /proc/<pid>/cgroup read
# `0::/system.slice/bpa-telegram-daemon.service`, and the previous orchestrator's
# transcript ends at the same second as the journal's "Stopping
# bpa-telegram-daemon.service".
#
# The repository already tracked the right design -- a dedicated
# bpa-orchestrator.service -- and the live launch path simply went around it.
# That is the Hard Floor 5 shape: the tracked topology and the running one
# diverged, and only an incident made the divergence visible.
#
# WHY THE FIX LIVES HERE AND NOT IN THE CALLER. There are three callers of
# `launch.sh start` -- the daemon relaunch path, orchestrator/watchdog.sh, and
# bpa-orchestrator.service -- and two of them run inside a cgroup that is not the
# orchestrator's. Fixing the daemon alone would leave the watchdog path (a
# Type=oneshot unit, whose cgroup is killed the moment the watchdog script
# exits). A rule that every future caller must remember is a rule the system does
# not have, so the placement is decided once, at the single spawn point, and the
# caller's cgroup stops mattering.
#
# WHAT "ISOLATED" MEANS, DECIDABLY. A positive allowlist, never a denylist of
# units that happen to be known today: the tmux server's cgroup leaf unit must be
# the orchestrator's OWN scope or its OWN service. Everything else -- the telegram
# daemon, the watchdog, a lane unit, a docker scope, an ssh login session -- is a
# foreign lifecycle that can end while the orchestrator is still meant to be
# alive, which is exactly the failure. A denylist would have to be extended for
# each new host mechanism, and the one nobody extends it for is the next outage.

# The transient scope the tmux server is born into. `.scope` is appended where a
# unit name is needed; systemd-run takes the bare name.
ORCH_TMUX_SCOPE="${ORCH_TMUX_SCOPE:-bpa-orchestrator-tmux}"
# The tracked unit that may also legitimately host the server: when
# bpa-orchestrator.service itself is the caller, its cgroup IS the orchestrator's
# own lifecycle, so a server sitting there is correctly placed.
ORCH_TMUX_UNIT="${ORCH_TMUX_UNIT:-bpa-orchestrator.service}"
# `systemd` (default) or `none`. `none` skips both the scope and the verification
# and is FOR FIXTURES ONLY -- suites that stub tmux with a recorder have no real
# server to place or measure. orchestrator/tmux-isolation.test.sh scans the
# tracked tree and fails if any non-test file selects it.
ORCH_TMUX_ISOLATION="${ORCH_TMUX_ISOLATION:-systemd}"
# Fixture-only tmux socket (`tmux -L`). Empty in production, and launch.sh must
# never set it: a fixture that spoke to the default socket would be talking to
# the operator's live orchestrator. Scanned by the same test as the knob above.
ORCH_TMUX_SOCKET="${ORCH_TMUX_SOCKET:-}"

# tmux_isolation_tmux <args...> -- tmux, on the fixture socket when one is set.
tmux_isolation_tmux() {
  if [[ -n "$ORCH_TMUX_SOCKET" ]]; then
    tmux -L "$ORCH_TMUX_SOCKET" "$@"
  else
    tmux "$@"
  fi
}

# tmux_isolation_cgroup_of_pid <pid> -> the unified (v2) cgroup path.
#
# Exit 2 means UNMEASURABLE, never "fine": a dead pid, a cgroup-v1 host, or a
# /proc this process cannot read all answer "I cannot tell", and a check that
# cannot observe its subject must not report the subject healthy (Hard Floor 7).
tmux_isolation_cgroup_of_pid() {
  local pid="${1:-}" path
  if ! [[ "$pid" =~ ^[1-9][0-9]*$ ]]; then
    printf 'ERROR tmux-isolation-bad-pid pid=%s\n' "${pid:-<empty>}" >&2
    return 2
  fi
  if [[ ! -r "/proc/$pid/cgroup" ]]; then
    printf 'ERROR tmux-isolation-cgroup-unreadable pid=%s\n' "$pid" >&2
    return 2
  fi
  path="$(sed -n 's|^0::||p' "/proc/$pid/cgroup" 2>/dev/null | head -n 1)"
  if [[ -z "$path" ]]; then
    # No `0::` line means cgroup v1 (or a hybrid hierarchy). The placement is
    # then genuinely unmeasurable by this predicate; say so rather than guess.
    printf 'ERROR tmux-isolation-no-unified-cgroup pid=%s\n' "$pid" >&2
    return 2
  fi
  printf '%s\n' "$path"
}

# tmux_isolation_unit_of_cgroup <cgroup-path> -> the innermost .service/.scope
# component, or the empty string when the path names no systemd unit at all.
#
# Walks from the leaf upward because a process may sit in a sub-cgroup of its
# unit (systemd's own `/init.scope`-style nesting, delegated subtrees, a
# container payload); the unit that OWNS its lifecycle is the nearest enclosing
# unit component, not the first one from the root.
tmux_isolation_unit_of_cgroup() {
  local path="${1:-}" component
  local -a components=()
  IFS='/' read -r -a components <<<"$path"
  local i
  for (( i = ${#components[@]} - 1; i >= 0; i-- )); do
    component="${components[i]}"
    case "$component" in
      *.service | *.scope) printf '%s\n' "$component"; return 0 ;;
    esac
  done
  printf '\n'
}

# tmux_isolation_verdict <unit> [<cgroup>] -> 0 isolated, 1 not.
# Prints one decidable line either way; the caller may quote it verbatim.
tmux_isolation_verdict() {
  local unit="${1:-}" cgroup="${2:-}" own
  for own in "$ORCH_TMUX_SCOPE.scope" "$ORCH_TMUX_UNIT"; do
    if [[ -n "$unit" && "$unit" == "$own" ]]; then
      printf 'ISOLATED unit=%s cgroup=%s\n' "$unit" "${cgroup:-<unstated>}"
      return 0
    fi
  done
  if [[ -z "$unit" ]]; then
    printf 'NOT-ISOLATED unit=<none> cgroup=%s reason=cgroup-names-no-systemd-unit\n' \
      "${cgroup:-<unstated>}"
    return 1
  fi
  # The measured case gets its own reason token. The generic one is correct for
  # it too, but an operator reading a monitor should not have to re-derive which
  # unit was the 2026-08-06 outage.
  local reason=hosted-by-a-foreign-unit-lifecycle
  [[ "$unit" != bpa-telegram-daemon.service ]] || reason=inside-the-telegram-daemon-cgroup
  printf 'NOT-ISOLATED unit=%s cgroup=%s reason=%s expected=%s|%s\n' \
    "$unit" "${cgroup:-<unstated>}" "$reason" "$ORCH_TMUX_SCOPE.scope" "$ORCH_TMUX_UNIT"
  return 1
}

# tmux_isolation_check_pid <pid> -> 0 isolated, 1 drift, 2 unmeasurable.
tmux_isolation_check_pid() {
  local pid="${1:-}" cgroup unit
  cgroup="$(tmux_isolation_cgroup_of_pid "$pid")" || {
    printf 'UNMEASURABLE pid=%s reason=cgroup-unreadable\n' "${pid:-<empty>}"
    return 2
  }
  unit="$(tmux_isolation_unit_of_cgroup "$cgroup")"
  tmux_isolation_verdict "$unit" "$cgroup"
}

# tmux_isolation_server_pid <session> -> the tmux SERVER pid hosting <session>.
#
# The server, not the pane: the pane is a child that dies with the server, and it
# is the server's cgroup that systemd kills. `#{pid}` is the server pid.
tmux_isolation_server_pid() {
  local session="${1:-}" pid
  pid="$(tmux_isolation_tmux display-message -p -t "$session" '#{pid}' 2>/dev/null)" || return 1
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  printf '%s\n' "$pid"
}

# tmux_isolation_spawn <tmux-args...> -- create the session inside its own scope.
#
# `--scope` is right rather than a transient service: the process is started by
# us and adopted by systemd, not started by systemd. The scope lands under
# /system.slice regardless of the caller's cgroup -- that IS the fix -- and
# `--collect` garbage-collects it once the tmux server exits, so a stopped
# orchestrator leaves no unit behind to block the next start.
tmux_isolation_spawn() {
  local tmux_bin
  case "$ORCH_TMUX_ISOLATION" in
    none)
      printf 'WARN orchestrator-tmux-isolation-disabled mode=none; the session inherits the caller cgroup and is NOT protected from a caller restart (fixtures only)\n' >&2
      tmux_isolation_tmux "$@"
      return
      ;;
    systemd) ;;
    *)
      printf 'ERROR orchestrator-tmux-isolation-unknown-mode mode=%s expected=systemd|none\n' \
        "$ORCH_TMUX_ISOLATION" >&2
      return 1
      ;;
  esac
  if ! command -v systemd-run >/dev/null 2>&1; then
    printf 'ERROR orchestrator-tmux-isolation-unavailable reason=systemd-run-missing; refusing to start an orchestrator that dies with its caller (workboard V3-5.29)\n' >&2
    return 1
  fi
  # Resolve tmux here rather than letting systemd-run search: the resolution must
  # happen against THIS process's PATH, which is what a fixture stubs.
  tmux_bin="$(command -v tmux 2>/dev/null)" || tmux_bin=""
  if [[ -z "$tmux_bin" ]]; then
    printf 'ERROR orchestrator-tmux-missing\n' >&2
    return 1
  fi
  # A scope left FAILED by an earlier crash would refuse the name. Clearing it is
  # not destructive: reset-failed only drops systemd's record of a dead unit.
  systemctl reset-failed "$ORCH_TMUX_SCOPE.scope" >/dev/null 2>&1 || true
  if [[ -n "$ORCH_TMUX_SOCKET" ]]; then
    systemd-run --scope --collect --quiet --unit "$ORCH_TMUX_SCOPE" \
      "$tmux_bin" -L "$ORCH_TMUX_SOCKET" "$@"
  else
    systemd-run --scope --collect --quiet --unit "$ORCH_TMUX_SCOPE" "$tmux_bin" "$@"
  fi
}

# tmux_isolation_assert_session <session> -> 0 when the session's server is
# correctly placed, 1 otherwise. The caller is expected to tear the session down
# and refuse: a silently unisolated orchestrator is the outage, not a warning.
#
# Verifying AFTER the spawn rather than probing before it is deliberate. A tmux
# client attaches to whatever server already owns the socket, so a scope around
# the client proves nothing about where the server ended up -- only reading the
# live server's cgroup does.
tmux_isolation_assert_session() {
  local session="${1:-}" pid verdict status
  if [[ "$ORCH_TMUX_ISOLATION" == none ]]; then
    printf 'WARN orchestrator-tmux-isolation-unverified mode=none session=%s\n' "$session" >&2
    return 0
  fi
  if ! pid="$(tmux_isolation_server_pid "$session")"; then
    printf 'ERROR orchestrator-tmux-server-pid-unresolved session=%s\n' "$session" >&2
    return 1
  fi
  status=0
  verdict="$(tmux_isolation_check_pid "$pid")" || status=$?
  if (( status != 0 )); then
    printf 'ERROR orchestrator-tmux-not-isolated session=%s pid=%s %s\n' \
      "$session" "$pid" "$verdict" >&2
    return 1
  fi
  printf 'orchestrator-tmux-isolated session=%s pid=%s %s\n' "$session" "$pid" "$verdict" >&2
  return 0
}
