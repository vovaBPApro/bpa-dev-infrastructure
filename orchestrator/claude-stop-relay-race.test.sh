#!/usr/bin/env bash
# Regression lock: Claude may flush the final assistant transcript record just
# after invoking the Stop hook, so the relay must wait briefly and retry.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRATCH="$(mktemp -d)"
cleanup() {
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

export BUN_BIN="${BUN_BIN:-bun}"
export STOP_RELAY_WAIT_MS=400
export STOP_RELAY_POLL_MS=20
export ORCH_TEST_CAPTURE="$SCRATCH/captured.json"
export ORCH_TURNEND_RELAY="$SCRATCH/relay-stub.sh"

cat > "$ORCH_TURNEND_RELAY" <<'EOF'
#!/usr/bin/env bash
printf '%s' "${1:?relay payload required}" > "${ORCH_TEST_CAPTURE:?}"
EOF
chmod +x "$ORCH_TURNEND_RELAY"

stop_payload() {
  printf '{"session_id":"session-race","transcript_path":"%s","hook_event_name":"Stop","stop_hook_active":false,"cwd":"/work"}' "$1"
}

assert_capture() {
  local expected_turn="$1"
  local expected_text="$2"
  "$BUN_BIN" -e '
const actual = JSON.parse(await Bun.file(process.env.ORCH_TEST_CAPTURE).text());
const expected = {
  session_id: "session-race",
  turn_id: process.argv[1],
  last_assistant_message: process.argv[2],
  cwd: "/work",
  transcript_path: process.argv[3],
  hook_event_name: "Stop",
  stop_hook_active: false,
};
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  console.error({ actual, expected });
  process.exit(1);
}
' "$expected_turn" "$expected_text" "$TRANSCRIPT"
}

TRANSCRIPT="$SCRATCH/race.jsonl"
printf '%s\n' '{"type":"user","uuid":"user-1","message":{"role":"user","content":"question"}}' > "$TRANSCRIPT"
rm -f "$ORCH_TEST_CAPTURE"
(
  sleep 0.08
  printf '%s\n' '{"type":"assistant","uuid":"turn-race","sessionId":"session-race","message":{"role":"assistant","content":[{"type":"text","text":"flushed after Stop"}]}}' >> "$TRANSCRIPT"
) &
writer_pid=$!
started_ms="$("$BUN_BIN" -e 'console.log(Date.now())')"
stop_payload "$TRANSCRIPT" | "$SCRIPT_DIR/orchestrator-claude-stop-relay.sh"
finished_ms="$("$BUN_BIN" -e 'console.log(Date.now())')"
wait "$writer_pid"
[[ $((finished_ms - started_ms)) -ge 60 ]]
assert_capture "turn-race" "flushed after Stop"
printf 'race-delayed: PASS waited_ms=%s\n' "$((finished_ms - started_ms))"

TRANSCRIPT="$SCRATCH/present.jsonl"
printf '%s\n' '{"type":"assistant","uuid":"turn-present","sessionId":"session-race","message":{"role":"assistant","content":[{"type":"text","text":"already present"}]}}' > "$TRANSCRIPT"
rm -f "$ORCH_TEST_CAPTURE"
started_ms="$("$BUN_BIN" -e 'console.log(Date.now())')"
stop_payload "$TRANSCRIPT" | "$SCRIPT_DIR/orchestrator-claude-stop-relay.sh"
finished_ms="$("$BUN_BIN" -e 'console.log(Date.now())')"
[[ $((finished_ms - started_ms)) -lt "$STOP_RELAY_WAIT_MS" ]]
assert_capture "turn-present" "already present"
printf 'already-present: PASS elapsed_ms=%s\n' "$((finished_ms - started_ms))"

TRANSCRIPT="$SCRATCH/absent.jsonl"
printf '%s\n' '{"type":"user","uuid":"user-2","message":{"role":"user","content":"interrupted"}}' > "$TRANSCRIPT"
rm -f "$ORCH_TEST_CAPTURE"
stderr="$SCRATCH/absent.stderr"
stop_payload "$TRANSCRIPT" | "$SCRIPT_DIR/orchestrator-claude-stop-relay.sh" 2> "$stderr"
[[ ! -e "$ORCH_TEST_CAPTURE" ]]
[[ ! -s "$stderr" ]]
printf 'never-appears: PASS exit=0 relay=none stderr=empty\n'
