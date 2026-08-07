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
# The gate PROVES subscription login; it does not merely fail to find a key.
# "No credential file" used to pass, which is exactly backwards: an absent or
# unreadable credential store proves nothing, and unproven is a refusal. The
# proof is the provider CLI's own non-secret credential record on disk:
#   * codex:  ~/.codex/auth.json written by `codex login` — subscription login
#     stores a tokens object (access_token/id_token) and NO populated
#     OPENAI_API_KEY; the API-key login path stores OPENAI_API_KEY instead.
#   * claude: ~/.claude/.credentials.json written by the CLI's /login —
#     subscription OAuth stores a claudeAiOauth object. A current access token
#     is immediately usable; an expired access token remains usable when the
#     record carries a non-empty, unexpired refresh credential that the CLI can
#     exchange automatically on startup. API-key auth writes no such object.
# Both files are read STRUCTURALLY, with Bun as the trusted parser. Grep on
# JSON cannot tell a populated key from the literal string appearing elsewhere
# in the document, so if Bun is unavailable the gate refuses rather than
# guessing — a missing parser must never become a silent pass. Nothing from
# either file is ever printed: the check scripts communicate by exit code only,
# and refusal messages carry paths and variable NAMES, never values.
#
# Usage: preflight-cli-auth.sh <claude|codex>
# Exit:  0 subscription auth affirmatively proven
#        1 refused: a metered-billing signal was found, or subscription auth
#          could not be proven (missing/unreadable/unknown-schema credentials,
#          expired login, no trusted parser)
#        2 unsupported provider argument
#
# ── THE REFUSAL CONTRACT ────────────────────────────────────────────────────
# Every refusal names ITSELF, on its own stable line, before its prose:
#
#   AUTH-PREFLIGHT refused=<class>
#
# with `class` drawn from a closed set:
#
#   metered-billing-signal   a provider key or a cloud-routing flag is present
#   subscription-store-missing  there is NO credential store at all
#   subscription-unproven    a store exists and does not prove subscription auth
#                            (unreadable, malformed, unknown schema, logged out,
#                            or no trusted parser to read it with)
#   subscription-expired     a complete login record whose refresh credential
#                            has also expired
#   unsupported-provider     the argument names no provider this gate knows
#
# `subscription-store-missing` is deliberately its own class rather than a shade
# of `subscription-unproven`, and the difference is not cosmetic: the first is
# the permanent, structural condition of every freshly rebuilt host, and the
# second is a machine whose credential store is BROKEN. A reader that conflates
# them treats a corrupt credential file as if it were a clean rebuild.
#
# The prose that follows is for a human reading a launch log. The token is for a
# machine that has to decide WHICH refusal happened, and the two are not
# interchangeable: a metered-billing signal and an absent credential store both
# exit 1, so the exit status cannot tell them apart, and any reader that tells
# them apart by matching the prose has made a second copy of these sentences
# somewhere else — which is how the landing gate's stage list came to disagree
# with the runner's. The token has exactly one home and this is it.
#
# The first such reader is the meteorite's `orchestrator-live` stage. A rebuilt,
# credential-free host CANNOT cross this gate — the credential store is written
# by a human answering /login, so Hard Floor 5 deliberately keeps it out of git
# — and the difference between "no credential store here" (a boundary a rebuild
# proof may declare and stop at) and "a metered-billing signal is set" (a
# misconfiguration that must fail the proof) is exactly the distinction this
# token carries.
#
# Nothing in the token is derived from credential material: it names a class of
# refusal and nothing else, which is the same rule the prose already follows.
set -euo pipefail

refused() { printf 'AUTH-PREFLIGHT refused=%s\n' "$1" >&2; }
fail() { refused metered-billing-signal; printf 'refusing API-key auth: %s\n' "$*" >&2; exit 1; }
refuse() { refused subscription-unproven; printf 'refusing unproven subscription auth: %s\n' "$*" >&2; exit 1; }
# Same refusal, same prose, distinct class: there is no credential store here.
refuse_missing() { refused subscription-store-missing; printf 'refusing unproven subscription auth: %s\n' "$*" >&2; exit 1; }

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
  *) refused unsupported-provider; printf 'unsupported provider\n' >&2; exit 2 ;;
esac

# ── 2. Trusted parser ───────────────────────────────────────────────────────
# Resolve Bun without sourcing lib.sh: lib.sh assigns from `command -v bun`,
# which aborts this script under `set -e` on a box that has no Bun at all.
# No Bun means the credential files cannot be verified structurally, and an
# unverifiable credential store is a refusal, not a pass: the old textual
# fallback returned success for a malformed file it could not read.
bun_bin="${BUN_BIN:-}"
if [[ -z "$bun_bin" && -x "$HOME/.bun/bin/bun" ]]; then
  bun_bin="$HOME/.bun/bin/bun"
elif [[ -z "$bun_bin" ]]; then
  bun_bin="$(command -v bun 2>/dev/null || true)"
fi
if [[ -z "$bun_bin" || ! -x "$bun_bin" ]]; then
  refuse "Bun is unavailable, so credential files cannot be verified; install Bun or set BUN_BIN"
fi

# ── 3. Affirmative credential evidence on disk ──────────────────────────────
# A clean environment proves nothing on its own: `codex login` with the API-key
# option writes OPENAI_API_KEY straight into ~/.codex/auth.json, and from then on
# every codex invocation is metered with no environment variable to catch.
# Check scripts exit: 0 proven, 1 metered key embedded, 2 unreadable/malformed,
# 3 unknown schema / logged out. They print NOTHING — token material must never
# reach a log or a terminal.
if [[ "$PROVIDER" == codex ]]; then
  CODEX_AUTH_FILE="${ORCH_CODEX_AUTH_FILE:-$HOME/.codex/auth.json}"
  [[ -f "$CODEX_AUTH_FILE" ]] ||
    refuse_missing "$CODEX_AUTH_FILE is missing; run 'codex login' and choose ChatGPT (subscription) login"
  verdict=0
  "$bun_bin" -e '
const path = process.argv[1];
let parsed;
try {
  parsed = JSON.parse(await Bun.file(path).text());
} catch {
  process.exit(2);
}
if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) process.exit(3);
const key = parsed.OPENAI_API_KEY;
if (typeof key === "string" && key.length > 0) process.exit(1);
const tokens = parsed.tokens;
const proven =
  tokens !== null &&
  typeof tokens === "object" &&
  !Array.isArray(tokens) &&
  ["access_token", "id_token"].some(
    (name) => typeof tokens[name] === "string" && tokens[name].length > 0,
  );
process.exit(proven ? 0 : 3);
' "$CODEX_AUTH_FILE" || verdict=$?
  case "$verdict" in
    0) ;;
    1) fail "$CODEX_AUTH_FILE embeds an OPENAI_API_KEY; run 'codex logout && codex login' and choose ChatGPT login" ;;
    2) refuse "$CODEX_AUTH_FILE is unreadable or not valid JSON, so subscription auth cannot be proven" ;;
    3) refuse "$CODEX_AUTH_FILE carries no ChatGPT login tokens (unknown schema or logged out); run 'codex login'" ;;
    *) refuse "$CODEX_AUTH_FILE verification failed unexpectedly (exit $verdict)" ;;
  esac
fi

if [[ "$PROVIDER" == claude ]]; then
  CLAUDE_CRED_FILE="${ORCH_CLAUDE_CRED_FILE:-$HOME/.claude/.credentials.json}"
  [[ -f "$CLAUDE_CRED_FILE" ]] ||
    refuse_missing "$CLAUDE_CRED_FILE is missing; run claude once and /login with the subscription account"
  verdict=0
  "$bun_bin" -e '
const path = process.argv[1];
let parsed;
try {
  parsed = JSON.parse(await Bun.file(path).text());
} catch {
  process.exit(2);
}
if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) process.exit(3);
const oauth = parsed.claudeAiOauth;
const hasAccess =
  oauth !== null &&
  typeof oauth === "object" &&
  !Array.isArray(oauth) &&
  typeof oauth.accessToken === "string" &&
  oauth.accessToken.length > 0;
if (!hasAccess) process.exit(3);
if (
  typeof oauth.expiresAt !== "number" ||
  !Number.isFinite(oauth.expiresAt)
) process.exit(3);
if (oauth.expiresAt > Date.now()) process.exit(0);

// An expired access token is not an expired login. Claude CLI refreshes it on
// startup when the persisted OAuth record still has a live refresh credential.
// Only trust the refresh path when every field needed to establish it is
// present and structurally valid; otherwise fail closed as unknown/logged out.
if (
  typeof oauth.refreshToken !== "string" ||
  oauth.refreshToken.length === 0 ||
  typeof oauth.refreshTokenExpiresAt !== "number" ||
  !Number.isFinite(oauth.refreshTokenExpiresAt)
) process.exit(3);
process.exit(oauth.refreshTokenExpiresAt > Date.now() ? 0 : 4);
' "$CLAUDE_CRED_FILE" || verdict=$?
  case "$verdict" in
    0) ;;
    2) refuse "$CLAUDE_CRED_FILE is unreadable or not valid JSON, so subscription auth cannot be proven" ;;
    3) refuse "$CLAUDE_CRED_FILE carries no complete subscription OAuth record (unknown schema or logged out); run claude /login" ;;
    4)
      refused subscription-expired
      printf "ERROR claude-auth-expired credential=%s; launch aborted before tmux; run 'claude' interactively and re-authenticate\n" \
        "$CLAUDE_CRED_FILE" >&2
      exit 1
      ;;
    *) refuse "$CLAUDE_CRED_FILE verification failed unexpectedly (exit $verdict)" ;;
  esac
fi

exit 0
