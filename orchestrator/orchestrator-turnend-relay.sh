#!/usr/bin/env bash
# Codex invokes this hook at turn end. The daemon endpoint is optional so a
# standalone runtime remains usable without Telegram.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib.sh"
RUNTIME_DIR="${ORCH_RUNTIME_DIR:-$SCRIPT_DIR/runtime}"
HEARTBEAT_FILE="${ORCH_HEARTBEAT_FILE:-$RUNTIME_DIR/orchestrator.heartbeat}"
RELAY_ENTRY="${ORCH_RELAY_ENTRY:-$SCRIPT_DIR/../daemon/relay.ts}"

# Liveness is recorded BEFORE delivery is attempted, and must stay that way.
# The heartbeat asserts "a turn ended", which is already true the moment this
# hook runs; it is not a statement about the daemon accepting the payload.
# Regression this ordering fixes: runtime.env.example advertised
# ORCH_RELAY_URL=http://127.0.0.1:4822/notify, but /notify requires {"text":…}
# and answers a Codex notify payload with HTTP 400. `curl --fail` then exited
# 22, `set -e` aborted the script before the heartbeat write, and the watchdog
# saw an orchestrator that had gone silent — a delivery misconfiguration
# masquerading as a dead orchestrator. Delivery failures must stay loud (this
# script still exits non-zero) but must never fake death.
mkdir -p "$(dirname "$HEARTBEAT_FILE")"
heartbeat_tmp="$(mktemp "$(dirname "$HEARTBEAT_FILE")/.orchestrator-heartbeat.XXXXXX")"
printf '%s\n' "$(date +%s)" > "$heartbeat_tmp"
mv -f "$heartbeat_tmp" "$HEARTBEAT_FILE"

if [[ -n "${ORCH_RELAY_URL:-}" ]]; then
  curl --fail --silent --show-error --max-time 10 \
    --data-binary "${1:-}" "$ORCH_RELAY_URL" >/dev/null
elif [[ -f "$RELAY_ENTRY" ]]; then
  printf '%s' "${1:-}" |
    ORCH_TELEGRAM_RELAY=1 "$BUN_BIN" "$RELAY_ENTRY" >/dev/null
fi
