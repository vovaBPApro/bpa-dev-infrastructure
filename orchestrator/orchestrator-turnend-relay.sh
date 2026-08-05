#!/usr/bin/env bash
# Turn-end relay — the heartbeat's single ongoing writer, and the one place a
# finished provider turn is handed to the daemon.
#
# Why this file exists at all, stated once so it is never lost again: for
# fourteen hours on 2026-08-04/05 this path was referenced by launch.sh, named
# by watchdog.sh:348-350 as the ONLY ongoing writer of the heartbeat, and
# present in no commit and on no host. A `[[ -x ]]` guard skipped it in
# silence, the heartbeat aged to 41x its own threshold, and nothing fired
# because the tmux pane-activity fallback carried the whole system alone:
# instance/incidents/2026-08-05-the-heartbeat-has-had-no-writer-since-yesterday.md.
# Deleting this file, or unwiring it from launch.sh, is caught by
# orchestrator/heartbeat-writer.test.sh — that lock is the actual repair; this
# script is only the thing it protects.
#
# Both providers funnel here, because there must be exactly one implementation
# of "a turn ended":
#   * codex  — `--config notify=["<this script>"]`; the payload arrives as the
#              final argv element.
#   * claude — the Stop hook, via orchestrator-claude-stop-relay.sh; the
#              payload arrives on stdin.
#
# ORDER IS THE CONTRACT. The heartbeat is written FIRST, unconditionally, and
# before anything that can fail, block, or be bounded. Liveness must not depend
# on the daemon being up, on the payload being well-formed, or on a network
# call returning: every one of those failures is exactly the moment the
# watchdog most needs a truthful signal, and a liveness signal that dies with
# its delivery channel is not a second signal.
#
# Usage: orchestrator-turnend-relay.sh [json-payload]
#        orchestrator-turnend-relay.sh < json-payload

# NOT `set -e`: no downstream failure may abort this script before, or instead
# of, the heartbeat write and its explicit status accounting below.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# Same config seam as watchdog.sh, and for the same reason: the two must
# resolve the SAME heartbeat file. The pane inherits the tmux server's
# environment, not the launcher's, so runtime.env is the only thing that can
# put a non-default path in front of both.
CONFIG_FILE="${ORCH_CONFIG_FILE:-$SCRIPT_DIR/runtime.env}"
if [[ -f "$CONFIG_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
fi
RUNTIME_DIR="${ORCH_RUNTIME_DIR:-$SCRIPT_DIR/runtime}"
# Keep this default expression character-for-character identical to
# watchdog.sh's. heartbeat-writer.test.sh asserts both spellings AND compares
# the two resolved paths under one ORCH_RUNTIME_DIR: a writer stamping a file
# no watchdog reads is the same outage with extra steps.
HEARTBEAT_FILE="${ORCH_HEARTBEAT_FILE:-$RUNTIME_DIR/orchestrator.heartbeat}"
RELAY_CLI="${ORCH_RELAY_CLI:-$REPO_DIR/daemon/relay.ts}"
BUN_BIN="${BUN_BIN:-$(command -v bun || true)}"
# The Stop hook runs SYNCHRONOUSLY and blocks the provider's turn, so delivery
# is bounded. The bound announces itself as a distinct named outcome rather
# than reaching the caller as an ordinary non-zero — a kill is not a pass.
RELAY_TIMEOUT="${ORCH_RELAY_TIMEOUT:-10}"

status=0

# ── 1. The heartbeat, first and unconditionally ─────────────────────────────
# Written to a same-directory temporary file and renamed, so a watchdog tick
# reading concurrently observes either the old complete stamp or the new one,
# never a truncated file that `[[ =~ ^[0-9]+$ ]]` would reject as unusable and
# treat as ambiguity.
write_heartbeat() {
  local dir tmp now
  dir="$(dirname "$HEARTBEAT_FILE")"
  mkdir -p "$dir" || return 1
  now="$(date +%s)" || return 1
  [[ "$now" =~ ^[0-9]+$ ]] || return 1
  tmp="$(mktemp "$dir/.orchestrator.heartbeat.XXXXXX")" || return 1
  printf '%s\n' "$now" > "$tmp" || { rm -f "$tmp"; return 1; }
  mv -f "$tmp" "$HEARTBEAT_FILE" || { rm -f "$tmp"; return 1; }
  return 0
}

if ! write_heartbeat; then
  # Loud, and on stderr where both providers surface it. A relay that cannot
  # stamp the heartbeat has failed at its only irreplaceable job; the watchdog
  # will see staleness, which is now TRUE rather than an artifact of an absent
  # writer.
  printf 'ERROR orchestrator-turnend-heartbeat-unwritable path=%s\n' "$HEARTBEAT_FILE" >&2
  status=1
fi

# ── 2. The payload, from whichever provider called ──────────────────────────
payload="${1-}"
if [[ -z "$payload" && ! -t 0 ]]; then
  # Bounded: a hook that hangs reading stdin hangs the turn.
  payload="$(timeout "$RELAY_TIMEOUT" cat)"
  read_status=$?
  if (( read_status == 124 )); then
    printf 'WARN orchestrator-turnend-relay-stdin-timeout seconds=%s\n' "$RELAY_TIMEOUT" >&2
    payload=""
  fi
fi

if [[ -z "${payload//[[:space:]]/}" ]]; then
  # No payload is not a heartbeat failure: the stamp above already landed. Say
  # so and stop — there is nothing to deliver.
  printf 'WARN orchestrator-turnend-relay-empty-payload heartbeat=%s\n' "$HEARTBEAT_FILE" >&2
  exit "$status"
fi

# ── 3. Delivery — best effort, never fatal, never silent ────────────────────
# A delivery failure exits 0 on purpose. The Stop hook's exit status is the
# provider's business: failing the hook because Telegram is down would turn a
# notification outage into a turn outage, and the operator would lose the
# channel AND the work. Every failure below is named on stderr instead.
deliver() {
  local out rc
  if [[ -n "${ORCH_RELAY_URL:-}" ]]; then
    # Documented override (runtime.env.example): sends the RAW provider payload
    # to a sink that speaks that format. No daemon route accepts it — that
    # mistake is what cost the watchdog its liveness signal once already.
    out="$(printf '%s' "$payload" |
      timeout "$RELAY_TIMEOUT" curl -sS -X POST -H 'content-type: application/json' \
        --data-binary @- "$ORCH_RELAY_URL" 2>&1)"
    rc=$?
  else
    if [[ -z "$BUN_BIN" ]]; then
      printf 'WARN orchestrator-turnend-relay-bun-missing; turn-end payload not delivered\n' >&2
      return 0
    fi
    if [[ ! -f "$RELAY_CLI" ]]; then
      printf 'WARN orchestrator-turnend-relay-cli-missing path=%s; turn-end payload not delivered\n' "$RELAY_CLI" >&2
      return 0
    fi
    # daemon/relay.ts normalizes both provider payload shapes and POSTs the
    # normalized record to /orchestrator/turn-end.
    out="$(printf '%s' "$payload" | timeout "$RELAY_TIMEOUT" "$BUN_BIN" "$RELAY_CLI" 2>&1)"
    rc=$?
  fi
  if (( rc == 124 )); then
    printf 'WARN orchestrator-turnend-relay-timeout seconds=%s; turn-end payload not delivered\n' "$RELAY_TIMEOUT" >&2
    return 0
  fi
  if (( rc != 0 )); then
    printf 'WARN orchestrator-turnend-relay-failed status=%s detail=%s\n' "$rc" "${out//$'\n'/ }" >&2
    return 0
  fi
  return 0
}

deliver
exit "$status"
