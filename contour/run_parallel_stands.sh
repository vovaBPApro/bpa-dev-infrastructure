#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$root"
run_one() { HOST_PORT="$1" COMPOSE_PROJECT_NAME="contour-stand-$1" SHORT=1 SOAK_SECONDS="${SOAK_SECONDS:-5}" COMPOSE_FILE=compose.stand.yaml python3 "$root/docker_canary.py" "$root/evidence-$1.json" "$SOAK_SECONDS" --short; }
run_one 18080 & p1=$!
run_one 18081 & p2=$!
wait "$p1"; wait "$p2"
