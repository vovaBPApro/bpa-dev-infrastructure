#!/usr/bin/env bash
# Claude invokes this Stop hook with session/transcript metadata on stdin. Add
# the final assistant text, then delegate normalization and delivery to the
# provider-neutral turn-end relay used by Codex.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib.sh"
TURNEND_RELAY="${ORCH_TURNEND_RELAY:-$SCRIPT_DIR/orchestrator-turnend-relay.sh}"

payload="$(
  # shellcheck disable=SC2016
  "$BUN_BIN" -e '
const raw = await new Response(Bun.stdin.stream()).text();
let stop;
try {
  stop = JSON.parse(raw);
} catch {
  throw new Error("malformed Stop hook payload");
}
if (
  !stop ||
  stop.hook_event_name !== "Stop" ||
  stop.stop_hook_active === true ||
  typeof stop.session_id !== "string" ||
  typeof stop.transcript_path !== "string"
) {
  process.exit(0);
}

const transcript = Bun.file(stop.transcript_path);
if (!(await transcript.exists())) {
  throw new Error(`transcript not found: ${stop.transcript_path}`);
}

const STOP_RELAY_WAIT_MS = Number(process.env.STOP_RELAY_WAIT_MS ?? 2000);
const STOP_RELAY_POLL_MS = Number(process.env.STOP_RELAY_POLL_MS ?? 100);
const deadline = Date.now() + STOP_RELAY_WAIT_MS;
let last;
do {
  last = null;
  for (const line of (await Bun.file(stop.transcript_path).text()).split("\n")) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      record?.type !== "assistant" ||
      record?.message?.role !== "assistant" ||
      !Array.isArray(record.message.content) ||
      record.sessionId !== stop.session_id ||
      record.isSidechain === true
    ) {
      continue;
    }
    const text = record.message.content
      .filter(
        (block) =>
          block?.type === "text" && typeof block.text === "string",
      )
      .map((block) => block.text)
      .join("");
    if (text && typeof record.uuid === "string") {
      last = { turn_id: record.uuid, assistant_text: text };
    }
  }
  if (last || Date.now() >= deadline) break;
  await Bun.sleep(STOP_RELAY_POLL_MS);
} while (true);

if (!last) process.exit(0);

process.stdout.write(
  JSON.stringify({
    session_id: stop.session_id,
    turn_id: last.turn_id,
    last_assistant_message: last.assistant_text,
    cwd: typeof stop.cwd === "string" ? stop.cwd : "",
    transcript_path: stop.transcript_path,
    hook_event_name: "Stop",
    stop_hook_active: false,
  }),
);
'
)"

[[ -n "$payload" ]] || exit 0
exec "$TURNEND_RELAY" "$payload"
