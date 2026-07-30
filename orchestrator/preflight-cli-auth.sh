#!/usr/bin/env bash
# Subscription-only auth gate. Deployments may replace it via ORCH_AUTH_PREFLIGHT.
#
# Standing operator rule: every AI this control plane launches runs on a
# SUBSCRIPTION (Claude Pro/Max, Codex via ChatGPT login, Gemini via Google
# OAuth). API keys exist for real paying client work and nothing else. A provider
# key or a cloud-routing flag left in the environment does not fail loudly — the
# CLI silently switches to metered billing and the operator finds out on an
# invoice. So this gate fails CLOSED and names the offending variable.
#
# Usage: preflight-cli-auth.sh <claude|codex>
# Exit:  0 subscription auth intact
#        1 an API-key/metered-billing signal was found (message names it)
#        2 unsupported provider argument
set -euo pipefail

fail() { printf 'refusing API-key auth: %s\n' "$*" >&2; exit 1; }

# ── 1. Banned environment ───────────────────────────────────────────────────
# Two distinct hazards, both metered:
#   * a raw provider key (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY,
#     GOOGLE_API_KEY, ANTHROPIC_AUTH_TOKEN);
#   * a CLOUD ROUTING flag, which carries no key itself but redirects the CLI
#     off the subscription onto a billed backend
#     (CLAUDE_CODE_USE_BEDROCK, CLAUDE_CODE_USE_VERTEX, AWS_BEARER_TOKEN_BEDROCK,
#     GOOGLE_APPLICATION_CREDENTIALS).
# The routing flags are the dangerous half: nothing about them looks like a
# secret, so they survive review, and CLAUDE_CODE_USE_BEDROCK=1 alone is enough
# to move the whole orchestrator onto metered Bedrock billing.
BANNED_KEYS=(
  ANTHROPIC_API_KEY
  ANTHROPIC_AUTH_TOKEN
  OPENAI_API_KEY
  GEMINI_API_KEY
  GOOGLE_API_KEY
  GOOGLE_APPLICATION_CREDENTIALS
  CLAUDE_CODE_USE_BEDROCK
  CLAUDE_CODE_USE_VERTEX
  AWS_BEARER_TOKEN_BEDROCK
)

leaked=()
for key in "${BANNED_KEYS[@]}"; do
  [[ -n "${!key:-}" ]] && leaked+=("$key")
done
if ((${#leaked[@]} > 0)); then
  fail "${leaked[*]} set in the environment; this orchestrator runs on subscription auth only"
fi

# GOOGLE_CLOUD_PROJECT is inert unless Vertex routing is on, and CLAUDE_CODE_USE_VERTEX
# is already banned above. Warn rather than fail so a legitimate gcloud setup on
# the box does not block every launch.
if [[ -n "${GOOGLE_CLOUD_PROJECT:-}" ]]; then
  printf 'warning: GOOGLE_CLOUD_PROJECT is set (%s); harmless unless Vertex routing is enabled\n' \
    "$GOOGLE_CLOUD_PROJECT" >&2
fi

case "${1:-}" in
  claude|codex) PROVIDER="$1" ;;
  *) printf 'unsupported provider\n' >&2; exit 2 ;;
esac

# ── 2. Credential files on disk ─────────────────────────────────────────────
# A clean environment proves nothing on its own: `codex login` with the API-key
# option writes OPENAI_API_KEY straight into ~/.codex/auth.json, and from then on
# every codex invocation is metered with no environment variable to catch. This
# is the check whose absence made the environment scan above cosmetic.
CODEX_AUTH_FILE="${ORCH_CODEX_AUTH_FILE:-$HOME/.codex/auth.json}"
if [[ "$PROVIDER" == codex && -f "$CODEX_AUTH_FILE" ]]; then
  embedded_key_message="$CODEX_AUTH_FILE embeds an OPENAI_API_KEY; run 'codex logout && codex login' and choose ChatGPT login"
  # Resolve Bun without sourcing lib.sh: lib.sh assigns from `command -v bun`,
  # which aborts this script under `set -e` on a box that has no Bun at all —
  # turning a missing interpreter into a failed launch instead of a fallback.
  bun_bin="${BUN_BIN:-}"
  if [[ -z "$bun_bin" && -x "$HOME/.bun/bin/bun" ]]; then
    bun_bin="$HOME/.bun/bin/bun"
  elif [[ -z "$bun_bin" ]]; then
    bun_bin="$(command -v bun 2>/dev/null || true)"
  fi

  if [[ -n "$bun_bin" && -x "$bun_bin" ]]; then
    # Structural parse. Grep on JSON cannot tell a populated key from the literal
    # string "OPENAI_API_KEY" appearing anywhere else in the document.
    parse_status=0
    "$bun_bin" -e '
const path = process.argv[1];
let parsed;
try {
  parsed = JSON.parse(await Bun.file(path).text());
} catch {
  // Unreadable or malformed: cannot prove the absence of a key. Fail closed.
  process.exit(2);
}
const key = parsed?.OPENAI_API_KEY;
process.exit(typeof key === "string" && key.length > 0 ? 1 : 0);
' "$CODEX_AUTH_FILE" || parse_status=$?
    case "$parse_status" in
      0) ;;
      1) fail "$embedded_key_message" ;;
      *) fail "$CODEX_AUTH_FILE could not be parsed, so subscription auth cannot be proven" ;;
    esac
  elif grep -Eq '"OPENAI_API_KEY"[[:space:]]*:[[:space:]]*"[^"]+"' "$CODEX_AUTH_FILE"; then
    # No Bun on this box. The conservative textual check still catches a
    # populated key; it can only produce a false POSITIVE, never a false green.
    fail "$embedded_key_message"
  fi
fi

exit 0
