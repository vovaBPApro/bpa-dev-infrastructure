#!/usr/bin/env bash
set -euo pipefail

port="${TELEGRAM_DAEMON_PORT:-4822}"
health_url="${TELEGRAM_DAEMON_HEALTH_URL:-http://127.0.0.1:${port}/health}"
timeout_seconds="${TELEGRAM_DAEMON_HEALTH_TIMEOUT_SECONDS:-3}"

if ! health_json="$(curl -fsS --max-time "$timeout_seconds" "$health_url" 2>&1)"; then
  printf 'WARN telegram-daemon-mcp: health endpoint unavailable: %s\n' \
    "$(printf '%s' "$health_json" | tr '\n' ' ' | sed -E 's/[[:space:]]+/ /g; s/ $//')"
  exit 0
fi

detached="$(printf '%s' "$health_json" | sed -n 's/.*"mcp_detached"[[:space:]]*:[[:space:]]*\(true\|false\).*/\1/p')"
duration_seconds="$(printf '%s' "$health_json" | sed -n 's/.*"mcp_detached_duration_seconds"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p')"

if [ "$detached" = 'true' ]; then
  if [ -z "$duration_seconds" ]; then
    printf 'WARN telegram-daemon-mcp: mcp_detached:true; duration unavailable\n'
  else
    printf 'WARN telegram-daemon-mcp: mcp_detached:true for %ss\n' "$duration_seconds"
  fi
elif [ "$detached" = 'false' ]; then
  printf 'OK telegram-daemon-mcp: MCP connected\n'
else
  printf 'WARN telegram-daemon-mcp: invalid health response\n'
fi
