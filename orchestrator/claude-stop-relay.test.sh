#!/usr/bin/env bash
# Regression lock: Claude's Stop hook must extract the final assistant text and
# pass it through the shared turn-end relay normalization/POST path.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRATCH="$(mktemp -d)"
TMUX_SOCKET="claude-stop-relay-$$"
cleanup() {
  tmux -L "$TMUX_SOCKET" kill-server 2>/dev/null || true
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

TRANSCRIPT="$SCRATCH/transcript.jsonl"
cat > "$TRANSCRIPT" <<'EOF'
{"type":"user","uuid":"user-1","message":{"role":"user","content":"question"}}
{"type":"assistant","uuid":"turn-old","sessionId":"session-test","message":{"role":"assistant","content":[{"type":"text","text":"older answer"}]}}
{"type":"assistant","uuid":"turn-final","sessionId":"session-test","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hidden"},{"type":"text","text":"known final "},{"type":"text","text":"assistant message"}]}}
{"type":"assistant","uuid":"turn-foreign","sessionId":"session-other","message":{"role":"assistant","content":[{"type":"text","text":"foreign session answer"}]}}
{"type":"assistant","uuid":"turn-sessionless","message":{"role":"assistant","content":[{"type":"text","text":"sessionless answer"}]}}
EOF

cat > "$SCRATCH/relay-stub.sh" <<'EOF'
#!/usr/bin/env bash
printf '%s' "${1:?relay payload required}" |
  ORCH_RELAY_ECHO=1 "${BUN_BIN:?}" "${ORCH_REAL_RELAY_ENTRY:?}" \
  > "${ORCH_TEST_NORMALIZED:?}"
EOF
chmod +x "$SCRATCH/relay-stub.sh"

payload="$(
  printf '{"session_id":"session-test","transcript_path":"%s","hook_event_name":"Stop","stop_hook_active":false,"cwd":"/work"}' \
    "$TRANSCRIPT"
)"
export BUN_BIN="${BUN_BIN:-bun}"
export ORCH_TURNEND_RELAY="$SCRATCH/relay-stub.sh"
export ORCH_REAL_RELAY_ENTRY="$SCRIPT_DIR/../daemon/relay.ts"
export ORCH_TEST_NORMALIZED="$SCRATCH/normalized.json"

printf '%s' "$payload" | "$SCRIPT_DIR/orchestrator-claude-stop-relay.sh"

"$BUN_BIN" -e '
const actual = JSON.parse(await Bun.file(process.env.ORCH_TEST_NORMALIZED).text());
const expected = {
  provider: "claude",
  session_id: "session-test",
  turn_id: "turn-final",
  assistant_text: "known final assistant message",
  cwd: "/work",
  transcript_path: process.argv[1],
  source: "claude_stop_hook",
};
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  console.error({ actual, expected });
  process.exit(1);
}
' "$TRANSCRIPT"

mkdir -p "$SCRATCH/bin" "$SCRATCH/runtime"
cat > "$SCRATCH/bin/tmux" <<'EOF'
#!/usr/bin/env bash
exec /usr/bin/tmux -L "${ORCH_TEST_TMUX_SOCKET:?}" "$@"
EOF
cat > "$SCRATCH/bin/claude" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" > "${ORCH_TEST_CLAUDE_ARGS:?}"
exec sleep 1000
EOF
cat > "$SCRATCH/preflight.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$SCRATCH/bin/tmux" "$SCRATCH/bin/claude" "$SCRATCH/preflight.sh"

export PATH="$SCRATCH/bin:$PATH"
export ORCH_TEST_TMUX_SOCKET="$TMUX_SOCKET"
export ORCH_TEST_CLAUDE_ARGS="$SCRATCH/claude-args"
export ORCH_CONFIG_FILE="$SCRATCH/no-runtime.env"
export ORCH_RUNTIME_DIR="$SCRATCH/runtime"
export ORCH_SINGLETON_LOCK_FILE="$SCRATCH/orchestrator.singleton.lock"
export ORCH_STATE_DB="$SCRATCH/absent-state.db"
export ORCH_AUTH_PREFLIGHT="$SCRATCH/preflight.sh"
export ORCH_PROVIDER=claude
export ORCH_SESSION="claude-stop-relay-test"
export ORCH_WORK_DIR="$SCRIPT_DIR/.."

"$SCRIPT_DIR/launch.sh" start
grep -Fxq -- '--dangerously-skip-permissions' "$ORCH_TEST_CLAUDE_ARGS"
settings_path="$(sed -n '/^--settings$/{n;p;q;}' "$ORCH_TEST_CLAUDE_ARGS")"
[[ "$settings_path" == "$SCRATCH/runtime/claude-relay-settings.json" ]]
"$BUN_BIN" -e '
const settings = await Bun.file(process.argv[1]).json();
const hooks = settings?.hooks?.Stop?.[0]?.hooks;
if (
  !Array.isArray(hooks) ||
  hooks.length !== 1 ||
  hooks[0]?.type !== "command" ||
  !String(hooks[0]?.command).endsWith("/orchestrator-claude-stop-relay.sh") ||
  settings.hooks.SessionStart !== undefined
) {
  console.error(settings);
  process.exit(1);
}
' "$settings_path"
"$SCRIPT_DIR/launch.sh" stop

printf 'claude stop relay regression: PASS\n'
