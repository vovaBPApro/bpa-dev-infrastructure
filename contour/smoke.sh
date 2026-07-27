#!/usr/bin/env sh
set -eu
base="${CONTOUR_URL:-http://127.0.0.1:18080}"
body=""
for _ in $(seq 1 30); do
  body="$(curl -fsS "$base/health" 2>/dev/null || true)"
  [ -n "$body" ] && break
  sleep 1
done
[ -n "$body" ]
printf '%s\n' "$body" | grep -F '"status": "ok"' >/dev/null
printf 'contour smoke: PASS (%s)\n' "$base"
