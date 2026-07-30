#!/usr/bin/env bash
# Metered-billing lock for the launch preflight.
#
# The operator's standing rule is subscriptions only: API keys exist for real
# paying client work and must never reach an orchestrator launch. The failure
# mode is silent — no CLI errors on a stray key or a cloud-routing flag, it just
# starts billing per token — so the gate has to enumerate the whole surface and
# fail closed, naming what it found. Depth here is not tidiness; a single
# unchecked variable is an invoice.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFLIGHT="$SCRIPT_DIR/preflight-cli-auth.sh"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

# `env -i` on purpose. This lane runs inside the orchestrator's own process tree
# and inherits its entire environment; without scrubbing, a variable that happens
# to be set on this box would decide the result of every case below.
run_preflight() { # <var=value…> -- <args…>
  local -a assignments=()
  while (($#)) && [[ "$1" != -- ]]; do assignments+=("$1"); shift; done
  shift || true
  env -i PATH="$PATH" HOME="$SCRATCH/home" \
    ORCH_CODEX_AUTH_FILE="${ORCH_CODEX_AUTH_FILE:-$SCRATCH/absent-auth.json}" \
    "${assignments[@]}" bash "$PREFLIGHT" "$@"
}

mkdir -p "$SCRATCH/home"

# ── Baseline: a clean environment must pass, or every case below is vacuous ──
for provider in claude codex; do
  run_preflight -- "$provider" >/dev/null 2>&1 ||
    fail "a clean subscription environment was rejected for $provider"
done

# ── The banned surface ──────────────────────────────────────────────────────
# Two hazards, and the second is the one that got lost. A raw key at least LOOKS
# like a secret and gets caught by review. A cloud-routing flag does not: it
# carries no credential material at all, so CLAUDE_CODE_USE_BEDROCK=1 reads as a
# harmless toggle while silently moving the whole orchestrator onto metered
# Bedrock billing.
BANNED=(
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
for key in "${BANNED[@]}"; do
  for provider in claude codex; do
    output="$(run_preflight "$key=fixture-value" -- "$provider" 2>&1)" && status=0 || status=$?
    (( status == 1 )) ||
      fail "$key did not fail the preflight for $provider (exit $status): this launch would bill per token"
    # Naming the variable is the whole point: "auth failed" leaves the operator
    # hunting through an environment they cannot see from Telegram.
    grep -Fq "$key" <<<"$output" ||
      fail "the preflight refused $provider but never named $key"
  done
done

# An unsupported provider is a caller bug, distinct from an auth refusal, and the
# launcher branches on it.
run_preflight -- gemini >/dev/null 2>&1 && fail 'an unsupported provider was accepted'
run_preflight -- gemini >/dev/null 2>&1 || status=$?
(( status == 2 )) || fail "an unsupported provider returned $status instead of 2"
run_preflight -- >/dev/null 2>&1 || status=$?
(( status == 2 )) || fail "a missing provider argument returned $status instead of 2"

# ── Credentials on disk ─────────────────────────────────────────────────────
# A clean environment proves nothing on its own: `codex login` with the API-key
# option writes OPENAI_API_KEY straight into ~/.codex/auth.json, and every codex
# run after that is metered with no environment variable to catch. Checking only
# the environment made the whole gate cosmetic for this case.
AUTH_KEYED="$SCRATCH/auth-keyed.json"
printf '%s\n' '{"OPENAI_API_KEY":"sk-fixture-not-a-real-key","tokens":{}}' > "$AUTH_KEYED"
output="$(ORCH_CODEX_AUTH_FILE="$AUTH_KEYED" run_preflight -- codex 2>&1)" && status=0 || status=$?
(( status == 1 )) || fail "an OPENAI_API_KEY embedded in codex auth.json was accepted (exit $status)"
grep -Fq "$AUTH_KEYED" <<<"$output" || fail 'the refusal did not name the offending auth file'

# Subscription auth writes the same file WITHOUT a key. That must still launch.
AUTH_SUBSCRIPTION="$SCRATCH/auth-subscription.json"
printf '%s\n' '{"OPENAI_API_KEY":null,"tokens":{"access_token":"fixture"}}' > "$AUTH_SUBSCRIPTION"
ORCH_CODEX_AUTH_FILE="$AUTH_SUBSCRIPTION" run_preflight -- codex >/dev/null 2>&1 ||
  fail 'a subscription-mode codex auth.json was rejected'

# An empty string is not a key.
AUTH_EMPTY="$SCRATCH/auth-empty.json"
printf '%s\n' '{"OPENAI_API_KEY":"","tokens":{}}' > "$AUTH_EMPTY"
ORCH_CODEX_AUTH_FILE="$AUTH_EMPTY" run_preflight -- codex >/dev/null 2>&1 ||
  fail 'an empty OPENAI_API_KEY string was treated as a key'

# Unparseable means unproven, and unproven is a refusal. Green-from-partial-
# output is exactly how a metered launch would slip through.
AUTH_BROKEN="$SCRATCH/auth-broken.json"
printf '%s\n' '{"OPENAI_API_KEY": ' > "$AUTH_BROKEN"
ORCH_CODEX_AUTH_FILE="$AUTH_BROKEN" run_preflight -- codex >/dev/null 2>&1 &&
  fail 'a malformed codex auth.json was treated as proof of subscription auth'

# The codex credential file has no bearing on a claude launch.
ORCH_CODEX_AUTH_FILE="$AUTH_KEYED" run_preflight -- claude >/dev/null 2>&1 ||
  fail "a codex auth.json blocked a claude launch"

# GOOGLE_CLOUD_PROJECT is inert while Vertex routing is banned outright, so it
# warns rather than blocking a legitimate gcloud setup on the box.
output="$(run_preflight GOOGLE_CLOUD_PROJECT=fixture-project -- claude 2>&1)" ||
  fail 'GOOGLE_CLOUD_PROJECT alone blocked a launch'
grep -Fq GOOGLE_CLOUD_PROJECT <<<"$output" || fail 'GOOGLE_CLOUD_PROJECT was not even warned about'

printf 'preflight auth tests: PASS\n'
