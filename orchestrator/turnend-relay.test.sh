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
unset ORCH_RELAY_URL

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

# ── A non-turn-end event must not be normalized into a fake turn ────────────
WRONG_TYPE='{"type":"agent-turn-started","thread-id":"t","turn-id":"u","last-assistant-message":"x"}'
if "$SCRIPT_DIR/orchestrator-turnend-relay.sh" "$WRONG_TYPE" 2>/dev/null; then
  printf 'non-turn-end codex payload was accepted by the relay\n' >&2
  exit 1
fi

printf 'turn-end relay regression: PASS\n'
