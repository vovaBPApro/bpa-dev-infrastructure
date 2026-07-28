#!/usr/bin/env sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
test "$(awk '/^FROM / {print $2; exit}' "$ROOT/contour/Dockerfile")" = "python:3.12-alpine"
grep -F 'restart: unless-stopped' "$ROOT/contour/compose.yaml" >/dev/null
grep -F '127.0.0.1:18080:8080' "$ROOT/contour/compose.yaml" >/dev/null
grep -F '"status": "ok"' "$ROOT/contour/app.py" >/dev/null
printf '%s\n' 'contour static checks: PASS'
