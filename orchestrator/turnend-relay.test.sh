#!/usr/bin/env bash
# Regression lock: a Codex `notify` turn-end payload must survive the REAL relay
# path and arrive at the daemon as the exact normalized turn-end record.
#
# The previous version of this test locked nothing. It put a stub `bun` on
# BUN_BIN, so daemon/relay.ts never ran, and its fixture carried neither
# `thread-id` nor `turn-id` — a shape `parseCodexNotifyPayload` rejects. Both
# the relay contract and the payload shape could have regressed under a green
# run. This version runs the real relay entry over a payload captured verbatim
# from a live `codex-cli 0.144.3` turn (`client: codex_exec`), and fails if
# either side of the contract moves.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib.sh"
REAL_BUN="$BUN_BIN"

# Passthrough shim: the real bun really executes the real daemon/relay.ts. It
# only adds ORCH_RELAY_ECHO=1 (so the normalized record is printed instead of
# POSTed to a running daemon) and captures the stdout the relay script discards.
cat > "$SCRATCH/bun-capture" <<'EOF'
#!/usr/bin/env bash
ORCH_RELAY_ECHO=1 "${ORCH_TEST_REAL_BUN:?}" "$@" > "${ORCH_TEST_NORMALIZED:?}"
EOF
chmod +x "$SCRATCH/bun-capture"

# Captured live on this box: codex-cli 0.144.3, `codex exec` with
# `-c notify=["…"]`, model gpt-5.6-sol. Keep it shaped like the original.
PAYLOAD='{"type":"agent-turn-complete","thread-id":"019fb3b4-9a94-7481-96a6-971fcaa066da","turn-id":"019fb3b4-9ae8-7b01-aad2-800650aa6a73","cwd":"/work/repo","client":"codex_exec","input-messages":["Say the word ok and nothing else."],"last-assistant-message":"ok"}'

export ORCH_TEST_REAL_BUN="$REAL_BUN"
export ORCH_TEST_NORMALIZED="$SCRATCH/normalized.json"
export BUN_BIN="$SCRATCH/bun-capture"
export ORCH_RUNTIME_DIR="$SCRATCH/runtime"
# ORCH_HEARTBEAT_FILE wins over ORCH_RUNTIME_DIR inside the hook, and a coder
# lane inherits the orchestrator's environment. Left unset, this suite writes a
# fresh timestamp into whatever heartbeat the ambient environment names — which
# would tell the watchdog that a dead orchestrator is alive. Measured against a
# decoy: it was overwritten before this line existed.
export ORCH_HEARTBEAT_FILE="$SCRATCH/runtime/orchestrator.heartbeat"
# Delivery must stay inside this test: an inherited relay URL would POST a
# fabricated turn to whatever daemon is listening, and an inherited relay entry
# would run a different program than the one under test.
unset ORCH_RELAY_URL ORCH_RELAY_ENTRY

"$SCRIPT_DIR/orchestrator-turnend-relay.sh" "$PAYLOAD"

# ── The normalized record the daemon ingests ────────────────────────────────
"$REAL_BUN" -e '
const actual = JSON.parse(await Bun.file(process.env.ORCH_TEST_NORMALIZED).text());
const expected = {
  provider: "codex",
  session_id: "019fb3b4-9a94-7481-96a6-971fcaa066da",
  turn_id: "019fb3b4-9ae8-7b01-aad2-800650aa6a73",
  assistant_text: "ok",
  cwd: "/work/repo",
  source: "codex_notify",
};
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  console.error({ actual, expected });
  process.exit(1);
}
'

# ── The TUI emits the same shape with a different `client` ─────────────────
# Captured live from the interactive TUI: client is "codex-tui", not
# "codex_exec". The launcher runs the TUI, so a parser that started keying on
# `client` would break exactly the path production uses.
TUI_PAYLOAD='{"type":"agent-turn-complete","thread-id":"019fb3bc-838b-7431-9c5f-77f0347dbffc","turn-id":"019fb3bc-96d6-7023-987f-ea5dcb4d8a4b","cwd":"/work/repo","client":"codex-tui","input-messages":["hi"],"last-assistant-message":"ok"}'
"$SCRIPT_DIR/orchestrator-turnend-relay.sh" "$TUI_PAYLOAD"
"$REAL_BUN" -e '
const actual = JSON.parse(await Bun.file(process.env.ORCH_TEST_NORMALIZED).text());
if (actual.provider !== "codex" || actual.source !== "codex_notify" ||
    actual.session_id !== "019fb3bc-838b-7431-9c5f-77f0347dbffc" ||
    actual.turn_id !== "019fb3bc-96d6-7023-987f-ea5dcb4d8a4b" ||
    actual.assistant_text !== "ok") {
  console.error(actual);
  process.exit(1);
}
'

# ── Liveness: a delivered turn refreshes the watchdog heartbeat ─────────────
[[ -s "$SCRATCH/runtime/orchestrator.heartbeat" ]]
grep -Eq '^[0-9]+$' "$SCRATCH/runtime/orchestrator.heartbeat"

# ── A regressed payload shape must be loud, not silently accepted ───────────
# This is the exact fixture the old test called "PASS": no thread-id, no
# turn-id. reliability.ts rejects it, so the relay must exit non-zero.
BAD_PAYLOAD='{"type":"agent-turn-complete","last-assistant-message":"relay check"}'
: > "$ORCH_TEST_NORMALIZED"
if "$SCRIPT_DIR/orchestrator-turnend-relay.sh" "$BAD_PAYLOAD" 2>"$SCRATCH/bad.err"; then
  printf 'unshaped codex payload was accepted by the relay\n' >&2
  exit 1
fi
grep -q 'unsupported hook payload' "$SCRATCH/bad.err"

# Each correlation id is individually load-bearing: the daemon keys a turn by
# both, so a half-identified turn must be rejected, not ingested as a partial.
for partial in \
  '{"type":"agent-turn-complete","thread-id":"019fb3b4-9a94-7481-96a6-971fcaa066da","last-assistant-message":"ok"}' \
  '{"type":"agent-turn-complete","turn-id":"019fb3b4-9ae8-7b01-aad2-800650aa6a73","last-assistant-message":"ok"}'
do
  if "$SCRIPT_DIR/orchestrator-turnend-relay.sh" "$partial" 2>/dev/null; then
    printf 'half-identified codex payload was accepted by the relay: %s\n' "$partial" >&2
    exit 1
  fi
done

# ── Failed delivery must not fake a dead orchestrator ──────────────────────
# The turn really ended, so the heartbeat is owed regardless of whether the sink
# accepted the payload. This ordering was inverted once: ORCH_RELAY_URL pointed
# at the daemon's /notify, which answers a Codex notify payload with HTTP 400;
# `curl --fail` under `set -e` aborted the script before the heartbeat write and
# the watchdog read the silence as a dead orchestrator.
STALE_RUNTIME="$SCRATCH/stale"
mkdir -p "$STALE_RUNTIME"
printf '1\n' > "$STALE_RUNTIME/orchestrator.heartbeat"
if ORCH_RUNTIME_DIR="$STALE_RUNTIME" \
  ORCH_HEARTBEAT_FILE="$STALE_RUNTIME/orchestrator.heartbeat" \
  ORCH_RELAY_URL='http://127.0.0.1:1/notify' \
  "$SCRIPT_DIR/orchestrator-turnend-relay.sh" "$PAYLOAD" 2>/dev/null; then
  printf 'a rejected delivery must still surface as a non-zero exit\n' >&2
  exit 1
fi
beat="$(cat "$STALE_RUNTIME/orchestrator.heartbeat")"
[[ "$beat" =~ ^[0-9]+$ ]] || { printf 'heartbeat not numeric: %s\n' "$beat" >&2; exit 1; }
if (( beat <= 1 )); then
  printf 'delivery failure suppressed the heartbeat write (watchdog liveness killed)\n' >&2
  exit 1
fi

# ── A non-turn-end event must not be normalized into a fake turn ────────────
WRONG_TYPE='{"type":"agent-turn-started","thread-id":"t","turn-id":"u","last-assistant-message":"x"}'
if "$SCRIPT_DIR/orchestrator-turnend-relay.sh" "$WRONG_TYPE" 2>/dev/null; then
  printf 'non-turn-end codex payload was accepted by the relay\n' >&2
  exit 1
fi

printf 'turn-end relay regression: PASS\n'
