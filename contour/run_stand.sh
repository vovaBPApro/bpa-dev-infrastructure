#!/usr/bin/env bash
set -euo pipefail

# Disposable Docker acceptance smoke. It always tears the stand down and
# writes evidence; a missing Docker command or failed check is NO-GO.
root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$root"
COMPOSE_FILE=compose.stand.yaml python3 docker_canary.py "${1:-stand-evidence.json}" "${SOAK_SECONDS:-5}" --short
