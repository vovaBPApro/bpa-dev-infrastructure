#!/usr/bin/env bash
# Codex invokes this hook at turn end. The daemon endpoint is optional so a
# standalone runtime remains usable without Telegram.
set -euo pipefail

if [[ -n "${ORCH_RELAY_URL:-}" ]]; then
  curl --fail --silent --show-error --max-time 10 \
    --data-binary "${1:-}" "$ORCH_RELAY_URL" >/dev/null
fi
