#!/usr/bin/env bash
# Claude Stop-hook relay — the claude-side entry point of the turn-end relay.
#
# launch.sh's claude branch wires this path into the Stop hook of the generated
# settings JSON; the codex branch wires orchestrator-turnend-relay.sh into
# `--config notify=[…]`. Two entry points, ONE implementation: "a turn ended"
# must mean the same thing, and write the same heartbeat, whichever provider is
# running. A second copy of that logic here is how the two would drift, and
# drift on this particular signal is what
# instance/incidents/2026-08-05-the-heartbeat-has-had-no-writer-since-yesterday.md
# is about.
#
# The Stop hook delivers its JSON payload on stdin, which `exec` hands through
# untouched.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TURNEND_RELAY="${ORCH_TURNEND_RELAY:-$SCRIPT_DIR/orchestrator-turnend-relay.sh}"

if [[ ! -x "$TURNEND_RELAY" ]]; then
  # Fail loud, never fail quiet: this is the exact shape that went unnoticed
  # for fourteen hours. Refusing here also means the heartbeat is NOT written,
  # so the watchdog sees true staleness rather than a signal nobody renews.
  printf 'ERROR orchestrator-turnend-relay-unavailable path=%s reason=%s\n' \
    "$TURNEND_RELAY" "$([[ -e "$TURNEND_RELAY" ]] && printf 'not executable' || printf missing)" >&2
  exit 1
fi

exec "$TURNEND_RELAY" "$@"
