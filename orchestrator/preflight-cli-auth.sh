#!/usr/bin/env bash
# Minimal subscription-mode guard; deployments may replace via ORCH_AUTH_PREFLIGHT.
set -euo pipefail
for key in ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN OPENAI_API_KEY; do
  if [[ -n "${!key:-}" ]]; then
    printf 'refusing API-key auth: %s is set\n' "$key" >&2
    exit 1
  fi
done
case "${1:-}" in claude|codex) ;; *) printf 'unsupported provider\n' >&2; exit 2;; esac
