#!/usr/bin/env bash
# Fail when the LIVE orchestrator tmux server sits in a cgroup that some other
# unit's lifecycle can kill.
#
# The sibling check in this directory, bootstrap/check-unit-drift.sh, compares
# tracked unit TEMPLATES against deployed unit FILES. It is blind to this defect
# by construction: on 2026-08-06 every unit file on this host matched its
# template exactly, and the orchestrator still died with the telegram daemon,
# because what had drifted was not a file but the RUNTIME TOPOLOGY -- which
# cgroup the tmux server actually landed in. `bpa-orchestrator.service` was
# tracked, correct, and simply not the path the daemon used to relaunch.
#
# So this is the same drift family asking the question a file comparison cannot:
# not "does the deployed unit match the tracked one" but "is the running process
# where the tracked design says it must be". Both are needed; neither implies the
# other. (Hard Floor 5: a mechanism running only on the host is already a
# regression, and a host whose topology no template describes is that regression
# made invisible.)
#
# The predicate itself is NOT defined here. It has one home, orchestrator/
# tmux-isolation.sh, which is also what launch.sh enforces at spawn time -- a
# checker with its own second copy of the rule is a checker that can disagree
# with the mechanism it audits, and the disagreement always surfaces as a false
# green.
#
# Exit codes, deliberately four rather than two (Hard Floor 7: a missing
# observation is not a pass):
#
#   0  ISOLATED     -- the server is in the orchestrator's own scope or service
#   1  NOT-ISOLATED -- drift: a foreign unit can kill the orchestrator
#   2  UNMEASURABLE -- the subject could not be observed (bad usage, unreadable
#                     /proc, cgroup v1). Never reported as clean.
#   3  ABSENT       -- no such tmux session; there is no orchestrator to place.
#                     Distinct from 0 on purpose: "nothing is wrong" and "nothing
#                     is there" are different answers, and a monitor that
#                     conflates them reports a dead fleet as healthy.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${REPO_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
ISOLATION_LIB="${ORCH_TMUX_ISOLATION_LIB:-$REPO_ROOT/orchestrator/tmux-isolation.sh}"

if [[ ! -r "$ISOLATION_LIB" ]]; then
  printf 'ERROR isolation-predicate-missing path=%s (refusing to re-derive the rule locally)\n' \
    "$ISOLATION_LIB" >&2
  exit 2
fi
# shellcheck source=orchestrator/tmux-isolation.sh
source "$ISOLATION_LIB"

usage() {
  cat <<'EOF'
Usage: check-orchestrator-cgroup-drift.sh [--session NAME] [--pid PID]

  --session NAME  tmux session to resolve the server from (default: $ORCH_SESSION,
                  then "orchestrator")
  --pid PID       check this pid's cgroup directly instead of resolving a session.
                  Used by fixtures to hold the predicate to a known placement.

Environment: ORCH_TMUX_SCOPE, ORCH_TMUX_UNIT (what counts as the orchestrator's
own lifecycle) and ORCH_TMUX_SOCKET (fixture tmux socket) are read from
orchestrator/tmux-isolation.sh, which owns their defaults.
EOF
}

session="${ORCH_SESSION:-orchestrator}"
pid=""
while (($#)); do
  case "$1" in
    --session) session="${2:-}"; shift 2 ;;
    --pid) pid="${2:-}"; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) printf 'ERROR unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -z "$pid" ]]; then
  if ! command -v tmux >/dev/null 2>&1; then
    printf 'UNMEASURABLE reason=tmux-missing session=%s\n' "$session" >&2
    exit 2
  fi
  if ! pid="$(tmux_isolation_server_pid "$session")"; then
    # Tell the two absent cases apart. A session that exists but whose server pid
    # cannot be read is an observation failure, not an absent orchestrator.
    if tmux_isolation_tmux has-session -t "$session" 2>/dev/null; then
      printf 'UNMEASURABLE reason=server-pid-unresolved session=%s\n' "$session" >&2
      exit 2
    fi
    printf 'ABSENT session=%s reason=no-such-tmux-session\n' "$session"
    exit 3
  fi
fi

status=0
verdict="$(tmux_isolation_check_pid "$pid")" || status=$?
case "$status" in
  0)
    printf '%s session=%s pid=%s\n' "$verdict" "$session" "$pid"
    exit 0
    ;;
  1)
    printf 'CGROUP-DRIFT %s session=%s pid=%s\n' "$verdict" "$session" "$pid" >&2
    printf 'The orchestrator dies whenever that unit is restarted (workboard V3-5.29).\n' >&2
    printf 'Repair: restart the orchestrator through orchestrator/launch.sh, which spawns into %s.\n' \
      "$ORCH_TMUX_SCOPE.scope" >&2
    exit 1
    ;;
  *)
    printf 'UNMEASURABLE %s session=%s pid=%s\n' "$verdict" "$session" "$pid" >&2
    exit 2
    ;;
esac
