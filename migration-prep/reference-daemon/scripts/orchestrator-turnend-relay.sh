#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$HOME/.claude/channels/telegram/daemon"
RELAY_TS="$SCRIPT_DIR/relay.ts"

if [[ ! -f "$RELAY_TS" ]]; then
  echo "[orchestrator-turnend-relay] missing relay.ts at $RELAY_TS" >&2
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "[orchestrator-turnend-relay] bun is required" >&2
  exit 1
fi

exec bun "$RELAY_TS"
