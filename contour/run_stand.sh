#!/usr/bin/env bash
set -euo pipefail

# Disposable Docker acceptance smoke. It always tears the stand down and
# writes evidence; a missing Docker command or failed check is NO-GO.
root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$root"
args=("${1:-stand-evidence.json}" "${SOAK_SECONDS:-14400}")
if [[ "${SHORT:-0}" == "1" ]]; then args+=(--short); fi
COMPOSE_FILE=compose.stand.yaml COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-contour-stand}" python3 docker_canary.py "${args[@]}"
