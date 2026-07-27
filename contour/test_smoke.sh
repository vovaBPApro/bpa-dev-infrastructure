#!/usr/bin/env sh
set -eu
test "$(awk '/^FROM / {print $2; exit}' Dockerfile)" = "python:3.12-alpine"
grep -F 'restart: unless-stopped' compose.yaml >/dev/null
grep -F '127.0.0.1:18080:8080' compose.yaml >/dev/null
grep -F '"status": "ok"' app.py >/dev/null
printf '%s\n' 'contour static checks: PASS'
