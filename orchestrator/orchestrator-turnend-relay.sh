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

if [[ -n "${ORCH_RELAY_URL:-}" ]]; then
  curl --fail --silent --show-error --max-time 10 \
    --data-binary "${1:-}" "$ORCH_RELAY_URL" >/dev/null
elif [[ -f "$RELAY_ENTRY" ]]; then
  printf '%s' "${1:-}" |
    ORCH_TELEGRAM_RELAY=1 "$BUN_BIN" "$RELAY_ENTRY" >/dev/null
fi

mkdir -p "$(dirname "$HEARTBEAT_FILE")"
heartbeat_tmp="$(mktemp "$(dirname "$HEARTBEAT_FILE")/.orchestrator-heartbeat.XXXXXX")"
printf '%s\n' "$(date +%s)" > "$heartbeat_tmp"
mv -f "$heartbeat_tmp" "$HEARTBEAT_FILE"
