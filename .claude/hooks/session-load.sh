#!/usr/bin/env bash
# SessionStart hook (INSTRUCTIONS_CONSILIUM_FINAL.md §2.3): on every orchestrator
# session start/resume, load the standing context — instance/params.yaml, open
# decisions-ledger rows, and the orchestrator-audience binding-instruction index
# — and inject it as additionalContext so the load is harness-enforced, not a
# ritual the orchestrator has to remember.
#
# Emits the Claude Code hook JSON envelope:
#   {"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"..."}}
# On any failure it prints nothing and exits 0, so a tooling hiccup never blocks
# a session from starting (fail-open on delivery, never fail-closed on boot).
set -uo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

BUN_BIN="${BUN_BIN:-}"
if [[ -z "$BUN_BIN" ]]; then
  if [[ -x "$HOME/.bun/bin/bun" ]]; then BUN_BIN="$HOME/.bun/bin/bun"; else BUN_BIN="$(command -v bun || true)"; fi
fi
[[ -n "$BUN_BIN" ]] || exit 0

LOAD="$("$BUN_BIN" "$PROJECT_DIR/tools/instructions/session-load.ts" --repo "$PROJECT_DIR" 2>/dev/null)" || exit 0
[[ -n "$LOAD" ]] || exit 0

# JSON-encode the load text safely via bun (no jq dependency in this stack).
CONTEXT_JSON="$(printf '%s' "$LOAD" | "$BUN_BIN" -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(JSON.stringify(s)))')" || exit 0
[[ -n "$CONTEXT_JSON" ]] || exit 0

printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":%s}}\n' "$CONTEXT_JSON"
exit 0
