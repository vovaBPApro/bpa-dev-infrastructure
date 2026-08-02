#!/usr/bin/env bash
# Metered-billing lock for the launch preflight.
#
# The operator's standing rule is subscriptions only: API keys exist for real
# paying client work and must never reach an orchestrator launch. The failure
# mode is silent — no CLI errors on a stray key or a cloud-routing flag, it just
# starts billing per token — so the gate has to enumerate the whole surface and
# fail closed, naming what it found.
#
# BLOCKER-4 half: the gate must PROVE subscription login, not merely fail to
# find a key. Absent, unreadable, malformed, or unknown-schema credential files
# — and a missing trusted parser — are all refusals for BOTH providers. The old
# contract treated "no codex auth.json" as a passing baseline and did no Claude
# check at all, which meant a logged-out box "passed" preflight and the CLI
# then picked whatever auth it could find. And whatever the verdict, the gate's
# output must never contain credential material.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFLIGHT="$SCRIPT_DIR/preflight-cli-auth.sh"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

# Fixture secrets. These strings must NEVER appear in any preflight output.
CODEX_TOKEN='fixture-codex-access-token-3f9a'
CODEX_KEY='sk-fixture-not-a-real-key-77aa'
CLAUDE_TOKEN='fixture-claude-oauth-access-token-b81c'
ALL_OUTPUT="$SCRATCH/all-output.log"
: > "$ALL_OUTPUT"

# Affirmative subscription fixtures, shaped like the real CLI credential files.
AUTH_SUBSCRIPTION="$SCRATCH/auth-subscription.json"
printf '{"OPENAI_API_KEY":null,"tokens":{"access_token":"%s","account_id":"fixture"},"last_refresh":"2026-07-30"}\n' \
  "$CODEX_TOKEN" > "$AUTH_SUBSCRIPTION"
CLAUDE_SUBSCRIPTION="$SCRATCH/claude-credentials.json"
printf '{"claudeAiOauth":{"accessToken":"%s","refreshToken":"fixture-refresh","expiresAt":4102444800000,"scopes":["user:inference"],"subscriptionType":"max"}}\n' \
  "$CLAUDE_TOKEN" > "$CLAUDE_SUBSCRIPTION"

# `env -i` on purpose. This lane runs inside the orchestrator's own process tree
# and inherits its entire environment; without scrubbing, a variable that happens
# to be set on this box would decide the result of every case below. Credential
# files default to the GOOD fixtures so each case isolates exactly one defect;
# every byte of output is also appended to ALL_OUTPUT for the secret-leak sweep.
run_preflight() { # <var=value…> -- <args…>
  local -a assignments=()
  while (($#)) && [[ "$1" != -- ]]; do assignments+=("$1"); shift; done
  shift || true
  local out status=0
  out="$(env -i PATH="${PREFLIGHT_PATH:-$PATH}" HOME="$SCRATCH/home" \
    ORCH_CODEX_AUTH_FILE="${ORCH_CODEX_AUTH_FILE:-$AUTH_SUBSCRIPTION}" \
    ORCH_CLAUDE_CRED_FILE="${ORCH_CLAUDE_CRED_FILE:-$CLAUDE_SUBSCRIPTION}" \
    "${assignments[@]}" bash "$PREFLIGHT" "$@" 2>&1)" || status=$?
  printf '%s\n' "$out" >> "$ALL_OUTPUT"
  printf '%s\n' "$out"
  return "$status"
}

mkdir -p "$SCRATCH/home"

# ── Baseline: REAL login evidence passes, or every case below is vacuous ────
for provider in claude codex; do
  run_preflight -- "$provider" >/dev/null ||
    fail "affirmative subscription evidence was rejected for $provider"
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
    output="$(run_preflight "$key=fixture-value" -- "$provider")" && status=0 || status=$?
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

# ── Credentials on disk: metered key embedded ───────────────────────────────
# A clean environment proves nothing on its own: `codex login` with the API-key
# option writes OPENAI_API_KEY straight into ~/.codex/auth.json, and every codex
# run after that is metered with no environment variable to catch.
AUTH_KEYED="$SCRATCH/auth-keyed.json"
printf '{"OPENAI_API_KEY":"%s","tokens":{"access_token":"%s"}}\n' "$CODEX_KEY" "$CODEX_TOKEN" > "$AUTH_KEYED"
output="$(ORCH_CODEX_AUTH_FILE="$AUTH_KEYED" run_preflight -- codex)" && status=0 || status=$?
(( status == 1 )) || fail "an OPENAI_API_KEY embedded in codex auth.json was accepted (exit $status)"
grep -Fq "$AUTH_KEYED" <<<"$output" || fail 'the refusal did not name the offending auth file'

# An empty string is not a key; with real login tokens beside it, launch works.
AUTH_EMPTY_KEY="$SCRATCH/auth-empty-key.json"
printf '{"OPENAI_API_KEY":"","tokens":{"access_token":"%s"}}\n' "$CODEX_TOKEN" > "$AUTH_EMPTY_KEY"
ORCH_CODEX_AUTH_FILE="$AUTH_EMPTY_KEY" run_preflight -- codex >/dev/null ||
  fail 'an empty OPENAI_API_KEY string was treated as a key'

# The codex credential file has no bearing on a claude launch.
ORCH_CODEX_AUTH_FILE="$AUTH_KEYED" run_preflight -- claude >/dev/null ||
  fail 'a codex auth.json blocked a claude launch'

# ── BLOCKER-4 lock: unproven is a refusal, for BOTH providers ───────────────
refuses() { # <description> <expected-path-in-message> <var=value…> -- <provider>
  local description="$1" named="$2"; shift 2
  local output status=0
  output="$(run_preflight "$@")" || status=$?
  (( status == 1 )) || fail "$description returned $status instead of refusing with 1"
  grep -Fq "$named" <<<"$output" || fail "$description refusal did not name $named"
}

# missing: the old baseline. An absent credential file means logged out, and
# logged out must not launch — the CLI would fall back to whatever it finds.
refuses 'codex with NO auth.json' "$SCRATCH/absent.json" \
  ORCH_CODEX_AUTH_FILE="$SCRATCH/absent.json" -- codex
refuses 'claude with NO credentials file' "$SCRATCH/absent-claude.json" \
  ORCH_CLAUDE_CRED_FILE="$SCRATCH/absent-claude.json" -- claude

# unreadable: a path that exists but cannot be read as a file proves nothing.
mkdir -p "$SCRATCH/dir-not-file.json" "$SCRATCH/dir-not-file-claude.json"
refuses 'codex with an unreadable auth store' "$SCRATCH/dir-not-file.json" \
  ORCH_CODEX_AUTH_FILE="$SCRATCH/dir-not-file.json" -- codex
refuses 'claude with an unreadable credential store' "$SCRATCH/dir-not-file-claude.json" \
  ORCH_CLAUDE_CRED_FILE="$SCRATCH/dir-not-file-claude.json" -- claude

# malformed: unparseable means unproven. Green-from-partial-output is exactly
# how a metered launch would slip through.
AUTH_BROKEN="$SCRATCH/auth-broken.json"
printf '%s\n' '{"OPENAI_API_KEY": ' > "$AUTH_BROKEN"
refuses 'codex with malformed JSON' "$AUTH_BROKEN" \
  ORCH_CODEX_AUTH_FILE="$AUTH_BROKEN" -- codex
CLAUDE_BROKEN="$SCRATCH/claude-broken.json"
printf '%s\n' '{"claudeAiOauth"' > "$CLAUDE_BROKEN"
refuses 'claude with malformed JSON' "$CLAUDE_BROKEN" \
  ORCH_CLAUDE_CRED_FILE="$CLAUDE_BROKEN" -- claude

# unknown schema: valid JSON, no affirmative login evidence. This includes the
# old "subscription" fixture that carried an empty tokens object — absence of a
# key was never proof of a subscription.
AUTH_NO_EVIDENCE="$SCRATCH/auth-no-evidence.json"
printf '%s\n' '{"OPENAI_API_KEY":null,"tokens":{}}' > "$AUTH_NO_EVIDENCE"
refuses 'codex with no login tokens' "$AUTH_NO_EVIDENCE" \
  ORCH_CODEX_AUTH_FILE="$AUTH_NO_EVIDENCE" -- codex
AUTH_WRONG_SHAPE="$SCRATCH/auth-wrong-shape.json"
printf '%s\n' '["not","an","object"]' > "$AUTH_WRONG_SHAPE"
refuses 'codex with an unknown schema' "$AUTH_WRONG_SHAPE" \
  ORCH_CODEX_AUTH_FILE="$AUTH_WRONG_SHAPE" -- codex
CLAUDE_NO_EVIDENCE="$SCRATCH/claude-no-evidence.json"
printf '%s\n' '{"claudeAiOauth":{"accessToken":""}}' > "$CLAUDE_NO_EVIDENCE"
refuses 'claude with an empty oauth record' "$CLAUDE_NO_EVIDENCE" \
  ORCH_CLAUDE_CRED_FILE="$CLAUDE_NO_EVIDENCE" -- claude
CLAUDE_WRONG_SHAPE="$SCRATCH/claude-wrong-shape.json"
printf '%s\n' '{"somethingElse":true}' > "$CLAUDE_WRONG_SHAPE"
refuses 'claude with an unknown schema' "$CLAUDE_WRONG_SHAPE" \
  ORCH_CLAUDE_CRED_FILE="$CLAUDE_WRONG_SHAPE" -- claude

# Expired OAuth was the live Telegram failure behind the silent empty Claude
# pane. Refuse before tmux is created and give the operator one actionable,
# credential-free recovery command; launchProvider forwards this stderr to the
# bound Telegram chat.
CLAUDE_EXPIRED="$SCRATCH/claude-expired.json"
printf '{"claudeAiOauth":{"accessToken":"%s","refreshToken":"fixture-refresh","expiresAt":1,"subscriptionType":"max"}}\n' \
  "$CLAUDE_TOKEN" > "$CLAUDE_EXPIRED"
output="$(ORCH_CLAUDE_CRED_FILE="$CLAUDE_EXPIRED" run_preflight -- claude)" && status=0 || status=$?
(( status == 1 )) || fail "expired Claude OAuth returned $status instead of refusing"
grep -Fq 'ERROR claude-auth-expired' <<<"$output" ||
  fail 'expired Claude OAuth was not classified loudly for Telegram'
grep -Fq "run 'claude' interactively and re-authenticate" <<<"$output" ||
  fail 'expired Claude OAuth refusal did not give the operator a re-login action'

# no trusted parser: with Bun unreachable the files cannot be verified
# structurally, and unverifiable must refuse — even over a WELL-FORMED
# subscription file, and certainly over a malformed one. The old fallback
# returned success here.
NO_BUN_PATH="/usr/bin:/bin"
for fixture in "$AUTH_SUBSCRIPTION" "$AUTH_BROKEN"; do
  status=0
  PREFLIGHT_PATH="$NO_BUN_PATH" run_preflight BUN_BIN="$SCRATCH/no-such-bun" -- codex >/dev/null || status=$?
  (( status == 1 )) || fail "codex passed with no trusted parser over $(basename "$fixture") (exit $status)"
done
status=0
PREFLIGHT_PATH="$NO_BUN_PATH" run_preflight BUN_BIN="$SCRATCH/no-such-bun" -- claude >/dev/null || status=$?
(( status == 1 )) || fail "claude passed with no trusted parser (exit $status)"

# GOOGLE_CLOUD_PROJECT is inert while Vertex routing is banned outright, so it
# warns rather than blocking a legitimate gcloud setup on the box.
output="$(run_preflight GOOGLE_CLOUD_PROJECT=fixture-project -- claude)" ||
  fail 'GOOGLE_CLOUD_PROJECT alone blocked a launch'
grep -Fq GOOGLE_CLOUD_PROJECT <<<"$output" || fail 'GOOGLE_CLOUD_PROJECT was not even warned about'

# ── No credential material in any output, ever ──────────────────────────────
# Every run above appended its combined stdout+stderr to ALL_OUTPUT. None of
# the fixture secrets may appear there: the gate reasons about credentials but
# must never repeat them.
for secret in "$CODEX_TOKEN" "$CODEX_KEY" "$CLAUDE_TOKEN"; do
  if grep -Fq "$secret" "$ALL_OUTPUT"; then
    fail "preflight output leaked fixture credential material: $secret"
  fi
done

printf 'preflight auth tests: PASS\n'
