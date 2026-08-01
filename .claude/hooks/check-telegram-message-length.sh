#!/usr/bin/env bash
# PreToolUse hook: block over-length Telegram messages to the operator.
#
# instructions/operator-feedback.md sets a default ceiling of 5 short lines per
# chat message to the operator, restated by him three times (2026-07-30,
# 2026-07-31, 2026-08-01) without it being followed. That makes it a mechanism
# gap, not a reminder gap (HR-302: "a mechanism prevents recurrence, a promise
# does not") — so this blocks the send instead of relying on the agent to
# self-apply the written rule.
#
# Emits the Claude Code hook JSON envelope for PreToolUse:
#   {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}
# On any parsing failure it prints nothing and exits 0, so a tooling hiccup
# never blocks a real message to the operator.
set -euo pipefail

input="$(cat)"
tool_name="$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null || true)"

case "$tool_name" in
  mcp__telegram-daemon__reply|mcp__telegram-daemon__complete|mcp__telegram-daemon__status_update) ;;
  *) exit 0 ;;
esac

text="$(printf '%s' "$input" | jq -r '.tool_input.text // empty' 2>/dev/null || true)"
[[ -z "$text" ]] && exit 0

lines="$(printf '%s' "$text" | awk 'END{print NR}')"
chars="$(printf '%s' "$text" | wc -m | tr -d ' ')"

max_lines=5
max_chars=600

if (( lines > max_lines || chars > max_chars )); then
  reason=$(printf 'BLOCKED: message is %d lines / %d chars — ceiling is %d lines / ~%d chars (instructions/operator-feedback.md, HR-302). Cut to the single most important point; offer depth ("Деталі є, скинути?") instead of sending it. Method, reasoning, and file:line evidence belong in the commit/report/workboard row, not chat.' \
    "$lines" "$chars" "$max_lines" "$max_chars")
  jq -n --arg reason "$reason" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$reason}}'
fi

exit 0
