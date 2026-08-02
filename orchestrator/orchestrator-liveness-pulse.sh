#!/usr/bin/env bash
# Positive in-turn liveness signal for the supervised orchestrator.
#
# The problem this solves: the heartbeat has exactly one ongoing writer, the
# turn-end hook, so it proves "a turn ENDED" — never "a turn is running". tmux
# window_activity proves "bytes were printed". A legitimate long turn that
# prints nothing (a slow build, a big review, a long tool call) satisfies
# neither, and the watchdog used to classify it as a zombie and shoot it
# mid-answer. Negative signals cannot fix that; only a POSITIVE, continuously
# renewed proof of life can.
#
# Design (the contract watchdog.sh relies on):
#   * launch.sh starts this loop INSIDE the supervised tmux pane, watching the
#     provider's PID (the pane shell exec's into the provider, so the PID it is
#     handed IS the orchestrator process).
#   * While that PID exists, the loop atomically re-stamps LIVENESS_FILE with
#     the current epoch every INTERVAL seconds — including mid-turn, which is
#     the whole point: renewal does not depend on turns ending or bytes flowing.
#   * The signal is owned by the supervised process tree and dies with it: the
#     moment the watched PID is gone the loop exits, and on pane teardown tmux
#     kills the loop outright. Nothing external (no systemd unit, no timer, no
#     watchdog write) ever renews it, so a fresh stamp cannot outlive the
#     process it vouches for beyond one interval.
#   * The last stamp is deliberately LEFT BEHIND on exit. Present-but-stale
#     says the renewer stopped renewing; deleting it would be racy under
#     SIGKILL anyway. But this loop is a HELPER — a separate process from the
#     provider — so a stale stamp alone can also mean the HELPER died alone
#     (crash, OOM kill, stray kill) over a perfectly live provider. That is
#     why the identity sidecar below exists: watchdog.sh kills only on
#     stale-heartbeat + no-output + STALE PULSE + the RECORDED PROVIDER
#     VERIFIABLY GONE (same pid, same starttime). A fresh pulse is proof of
#     life; an ABSENT pulse file is ambiguity — alert, never kill; a stale
#     pulse over a live provider is DEGRADED liveness — alert, never kill.
#   * At startup the loop records WHICH provider the stamp vouches for in
#     `$LIVENESS_FILE.identity`: pid= plus the kernel's reuse-safe starttime=
#     (/proc/<pid>/stat field 22). launch.sh seeds the same record, so the
#     fence holds even if this loop dies before its first write.
#
# Usage: orchestrator-liveness-pulse.sh <watched-pid> [liveness-file] [interval-s]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/knobs.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/proc-identity.sh"
RUNTIME_DIR="${ORCH_RUNTIME_DIR:-$SCRIPT_DIR/runtime}"

WATCH_PID="${1:?usage: orchestrator-liveness-pulse.sh <watched-pid> [liveness-file] [interval-s]}"
LIVENESS_FILE="${2:-${ORCH_LIVENESS_FILE:-$RUNTIME_DIR/orchestrator.liveness}}"
# Derived, not a knob: the identity must never point at a different file than
# the stamp it fences. watchdog.sh derives the same path from ITS liveness file.
IDENTITY_FILE="$LIVENESS_FILE.identity"
INTERVAL="${3:-${ORCH_LIVENESS_PULSE_INTERVAL:-30}}"

if ! [[ "$WATCH_PID" =~ ^[1-9][0-9]*$ ]]; then
  printf 'orchestrator-liveness-pulse: invalid watched pid\n' >&2
  exit 2
fi
# An invalid interval must not disable the signal (that would look like death)
# and must not spin: fall back to the documented default.
if ! knob_check "$INTERVAL" 5 600; then
  INTERVAL=30
fi

mkdir -p "$(dirname "$LIVENESS_FILE")"
# Record the provider identity BEFORE the first stamp. starttime is fixed at
# fork and survives exec (the pane shell exec's into the provider under the
# same pid), so reading it once here is exact for the whole session. If /proc
# cannot answer, starttime= is left empty — the watchdog then treats a stale
# stamp over that pid as unverifiable and never kills on it.
WATCH_STARTTIME="$(proc_starttime "$WATCH_PID")"
tmp="$(mktemp "$IDENTITY_FILE.XXXXXX")"
printf 'pid=%s\nstarttime=%s\n' "$WATCH_PID" "$WATCH_STARTTIME" > "$tmp"
mv -f "$tmp" "$IDENTITY_FILE"
while kill -0 "$WATCH_PID" 2>/dev/null; do
  tmp="$(mktemp "$(dirname "$LIVENESS_FILE")/.orchestrator.liveness.XXXXXX")"
  printf '%s\n' "$(date +%s)" > "$tmp"
  mv -f "$tmp" "$LIVENESS_FILE"
  sleep "$INTERVAL"
done
