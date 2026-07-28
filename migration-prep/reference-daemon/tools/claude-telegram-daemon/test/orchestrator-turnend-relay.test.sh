#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$HOME/.claude/scripts/orchestrator-turnend-relay.sh"

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

claude_payload='{"session_id":"claude-session","turn_id":"turn-1","cwd":"/tmp/project","last_assistant_message":"done"}'
codex_payload='{"type":"agent-turn-complete","thread-id":"codex-thread","turn-id":"turn-2","cwd":"/tmp/project","last-assistant-message":"done"}'

actual="$(printf '%s' "$claude_payload" | ORCH_RELAY_ECHO=1 "$SCRIPT")"
[[ "$actual" == *'"provider":"claude"'* ]]
[[ "$actual" == *'"session_id":"claude-session"'* ]]

actual="$(printf '%s' "$codex_payload" | ORCH_RELAY_ECHO=1 "$SCRIPT")"
[[ "$actual" == *'"provider":"codex"'* ]]
[[ "$actual" == *'"session_id":"codex-thread"'* ]]

actual="$(printf '%s' "$codex_payload" | "$SCRIPT")"
[[ "$actual" == 'ignored_unmarked' ]]

if printf 'not-json' | "$SCRIPT" >/dev/null 2>"$tmpdir/err"; then
  echo "expected malformed JSON to fail" >&2
  exit 1
fi
grep -q 'malformed JSON payload' "$tmpdir/err"

echo "relay shell tests passed"
