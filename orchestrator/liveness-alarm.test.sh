#!/usr/bin/env bash
# LIVE proof that a dead or wedged orchestrator actually reaches the operator.
#
# Not a unit test of evaluateStall: this boots a REAL daemon/server.ts process,
# points its Bot API at a local stub, gives it a real scratch state DB seeded by
# the real core/mission-cli.ts, and asserts on the message bytes the daemon
# tried to send. If the mission input, the tick, the alert dedupe, the message
# builder or the send call regress, this suite goes red.
#
# The defect it locks: the daemon read its mission from
# ~/.claude/orchestrator-missions.json, a file NOTHING in this repository ever
# wrote. `evaluateStall` therefore returned `idle` on every tick and the
# dead-orchestrator alarm could not fire, in either direction, ever. Both halves
# of that contract looked healthy in isolation.
#
# Safety: the daemon is aimed at 127.0.0.1 via TELEGRAM_API_ROOT with a fake
# token, so no call can reach api.telegram.org even if the chat id were wrong,
# and the suite fails if any captured message is addressed to a chat other than
# its own fixture chat.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUN_BIN="${BUN_BIN:-$(command -v bun)}"
SCRATCH="$(mktemp -d)"

# The one chat this suite is ever allowed to address. The operator's real chat
# must never appear in the capture log.
FIXTURE_CHAT_ID=424242
FORBIDDEN_CHAT_ID=83769716

DAEMON_PID=""
STUB_PID=""
cleanup() {
  if [[ -n "$DAEMON_PID" ]]; then kill "$DAEMON_PID" 2>/dev/null || true; fi
  if [[ -n "$STUB_PID" ]]; then kill "$STUB_PID" 2>/dev/null || true; fi
  wait 2>/dev/null || true
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
pass() { printf 'PASS %s\n' "$*"; }

# ── Live-state isolation ────────────────────────────────────────────────────
# This suite runs inside the operator's orchestrator process tree and inherits
# its environment. Every ORCH_*/INFRA_*/TELEGRAM_* pointer below resolves to a
# LIVE file if left unset: ORCH_STATE_DB is the operator's lease database,
# ORCH_INSTANCE_LOCK_FILE the singleton lock whose deletion unbinds the chat,
# ORCH_HEARTBEAT_FILE the file a forged write would use to tell the watchdog a
# dead orchestrator is alive. Nothing here is trusted from the ambient env.
while IFS='=' read -r key _; do
  case "$key" in
    ORCH_*|INFRA_*|TELEGRAM_*|NUDGE_*|MORNING_*|FULL_SUITE_*|FLEET_*) unset "$key" ;;
  esac
done < <(env)

mkdir -p \
  "$SCRATCH/bin" \
  "$SCRATCH/home/.claude" \
  "$SCRATCH/state/daemon/runtime" \
  "$SCRATCH/install/orchestrator" \
  "$SCRATCH/install/runtime"

# ── tmux shim: a session exists only while the flag file does ───────────────
PANE_FILE="$SCRATCH/pane.txt"
SESSION_FLAG="$SCRATCH/tmux-alive"
cat > "$SCRATCH/bin/tmux" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  has-session) [[ -e "${TEST_SESSION_FLAG:?}" ]] ;;
  capture-pane) cat "${TEST_PANE_FILE:?}" 2>/dev/null || true ;;
  *) exit 0 ;;
esac
EOF
chmod +x "$SCRATCH/bin/tmux"
printf 'orchestrator booting\n' > "$PANE_FILE"

# ── Bot API stub: records every sendMessage, answers grammY's polling ───────
CAPTURE="$SCRATCH/sent.jsonl"
: > "$CAPTURE"
PORT_FILE="$SCRATCH/stub.port"
cat > "$SCRATCH/api-stub.ts" <<'EOF'
const capture = process.env.STUB_CAPTURE!;
const portFile = process.env.STUB_PORT_FILE!;
const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(req) {
    const method = new URL(req.url).pathname.split('/').pop() ?? '';
    const body = req.method === 'POST' ? await req.text() : '';
    if (method === 'getMe') {
      return Response.json({
        ok: true,
        result: { id: 1, is_bot: true, first_name: 'stub', username: 'stub_bot' },
      });
    }
    if (method === 'getUpdates') {
      await Bun.sleep(200);
      return Response.json({ ok: true, result: [] });
    }
    if (method === 'sendMessage') {
      await Bun.write(
        capture,
        (await Bun.file(capture).text().catch(() => '')) + body + '\n',
      );
      let chat_id: unknown = 0;
      let text = '';
      try {
        const parsed = JSON.parse(body);
        chat_id = parsed.chat_id;
        text = parsed.text ?? '';
      } catch {}
      return Response.json({
        ok: true,
        result: {
          message_id: Math.floor(Math.random() * 1e6),
          date: Math.floor(Date.now() / 1000),
          chat: { id: Number(chat_id), type: 'private' },
          text,
        },
      });
    }
    return Response.json({ ok: true, result: true });
  },
});
await Bun.write(portFile, String(server.port));
EOF

STUB_CAPTURE="$CAPTURE" STUB_PORT_FILE="$PORT_FILE" \
  "$BUN_BIN" "$SCRATCH/api-stub.ts" >"$SCRATCH/stub.log" 2>&1 &
STUB_PID=$!
for _ in $(seq 1 200); do [[ -s "$PORT_FILE" ]] && break; sleep 0.05; done
[[ -s "$PORT_FILE" ]] || fail "Bot API stub did not start: $(cat "$SCRATCH/stub.log")"
API_PORT="$(cat "$PORT_FILE")"

# ── Scratch mission state, written by the REAL writer ───────────────────────
STATE_DB="$SCRATCH/install/runtime/state.db"
mission_cli() { INFRA_STATE_DB="$STATE_DB" "$BUN_BIN" "$REPO_DIR/core/mission-cli.ts" "$@"; }

# ── Bound orchestrator session, as /start_claude leaves it ──────────────────
BINDING_FILE="$SCRATCH/state/daemon/runtime/orchestrator-binding.json"
write_binding() {
  cat > "$BINDING_FILE" <<EOF
{"provider":"claude","session_id":"sess-liveness","bound_chat_id":"$FIXTURE_CHAT_ID",
 "tmux_session":"liveness-fixture","bound_at":"2026-07-30T00:00:00.000Z",
 "updated_at":"2026-07-30T00:00:00.000Z","state_version":1}
EOF
}
write_binding

DAEMON_PORT=$(( 20000 + RANDOM % 20000 ))
start_daemon() {
  : > "$CAPTURE"
  env -i \
    PATH="$SCRATCH/bin:/usr/local/bin:/usr/bin:/bin" \
    HOME="$SCRATCH/home" \
    TEST_SESSION_FLAG="$SESSION_FLAG" \
    TEST_PANE_FILE="$PANE_FILE" \
    TELEGRAM_API_ROOT="http://127.0.0.1:$API_PORT" \
    TELEGRAM_BOT_TOKEN="123456:liveness-fixture-token" \
    TELEGRAM_STATE_DIR="$SCRATCH/state" \
    TELEGRAM_DAEMON_PORT="$DAEMON_PORT" \
    TELEGRAM_CHAT_ID="$FIXTURE_CHAT_ID" \
    TELEGRAM_BOUND_CHAT_ID="$FIXTURE_CHAT_ID" \
    ORCH_INSTALL_ROOT="$SCRATCH/install" \
    ORCH_SESSION="liveness-fixture" \
    INFRA_STATE_DB="$STATE_DB" \
    ORCH_STALL_WATCHDOG_TICK_MS=250 \
    ORCH_STALL_THRESHOLD_MS="${1:-900000}" \
    OUTBOX_POLL_MS=600000 \
    "$BUN_BIN" "$REPO_DIR/daemon/server.ts" >"$SCRATCH/daemon.log" 2>&1 &
  DAEMON_PID=$!
  for _ in $(seq 1 200); do
    curl -sf "http://127.0.0.1:$DAEMON_PORT/health" >/dev/null 2>&1 && return 0
    sleep 0.05
  done
  fail "daemon did not come up: $(tail -5 "$SCRATCH/daemon.log")"
}
stop_daemon() {
  if [[ -n "$DAEMON_PID" ]]; then kill "$DAEMON_PID" 2>/dev/null || true; fi
  wait "$DAEMON_PID" 2>/dev/null || true
  DAEMON_PID=""
}

# Wait until a message matching $1 is captured; $2 = seconds budget.
await_alert() {
  local pattern="$1" budget="${2:-15}" deadline
  deadline=$(( $(date +%s) + budget ))
  while (( $(date +%s) < deadline )); do
    if grep -q "$pattern" "$CAPTURE" 2>/dev/null; then return 0; fi
    sleep 0.2
  done
  return 1
}

alert_text() {
  grep -o '"text":"[^"]*"' "$CAPTURE" | sed 's/^"text":"//; s/"$//' | grep -m1 'orchestrator '
}

assert_no_forbidden_chat() {
  if grep -q "$FORBIDDEN_CHAT_ID" "$CAPTURE"; then
    fail "a message was addressed to the operator's real chat"
  fi
  if grep -q '"chat_id"' "$CAPTURE" && \
     grep -o '"chat_id":"\?[0-9]*' "$CAPTURE" | grep -qv "$FIXTURE_CHAT_ID"; then
    fail "a message was addressed to an unexpected chat: $(cat "$CAPTURE")"
  fi
}

# ══ Case 1: orchestrator DIED with an active mission ════════════════════════
MISSION_ID="$(mission_cli mission create 'HR-101 re-arm the dead-orchestrator alarm' | sed 's/^MISSION id=//; s/ .*//')"
mission_cli mission transition "$MISSION_ID" running >/dev/null
rm -f "$SESSION_FLAG"                      # tmux session is gone
start_daemon
await_alert 'orchestrator died' 20 || fail "no death alert (case 1). captured: $(cat "$CAPTURE"); daemon: $(tail -20 "$SCRATCH/daemon.log")"
CASE1_TEXT="$(alert_text)"
grep -q 'HR-101 re-arm the dead-orchestrator alarm' "$CAPTURE" \
  || fail "death alert did not name the mission (case 1): $CASE1_TEXT"
grep -q '(running)' "$CAPTURE" || fail "death alert did not carry the mission state: $CASE1_TEXT"
assert_no_forbidden_chat
# The alert must fire once, not once per tick: several ticks have passed.
SENDS="$(grep -c 'orchestrator died' "$CAPTURE")"
[[ "$SENDS" == "1" ]] || fail "death alert repeated $SENDS times; dedupe is broken"
stop_daemon
pass "case 1 — dead orchestrator with an active mission alerts exactly once"
printf '  alert: %s\n' "$CASE1_TEXT"

# ══ Case 2: orchestrator DIED with NO mission recorded ══════════════════════
# Fail-closed: the mission ledger being empty must not silence a dead session.
# This is the case the operator actually hit — no mission was ever recorded on
# this host, in either store.
mission_cli mission transition "$MISSION_ID" failed >/dev/null
rm -f "$SESSION_FLAG"
start_daemon
await_alert 'orchestrator died' 20 || fail "no death alert with an empty mission ledger (case 2) — the alarm is still fail-open. captured: $(cat "$CAPTURE")"
CASE2_TEXT="$(alert_text)"
grep -q 'no active mission recorded' "$CAPTURE" \
  || fail "case 2 alert did not admit the mission ledger was empty: $CASE2_TEXT"
assert_no_forbidden_chat
stop_daemon
pass "case 2 — dead orchestrator with no mission still alerts (fail-closed)"
printf '  alert: %s\n' "$CASE2_TEXT"

# ══ Case 3: orchestrator WEDGED — alive but making no progress ══════════════
WEDGE_ID="$(mission_cli mission create 'land the lane batch' | sed 's/^MISSION id=//; s/ .*//')"
mission_cli mission transition "$WEDGE_ID" running >/dev/null
: > "$SESSION_FLAG"                        # tmux session is alive
printf 'thinking...\n' > "$PANE_FILE"      # one pane change, then frozen
start_daemon 1500
await_alert 'orchestrator stalled' 30 || fail "no stall alert for a wedged orchestrator (case 3). captured: $(cat "$CAPTURE"); daemon: $(tail -20 "$SCRATCH/daemon.log")"
CASE3_TEXT="$(alert_text)"
grep -q 'land the lane batch' "$CAPTURE" || fail "stall alert did not name the mission: $CASE3_TEXT"
assert_no_forbidden_chat
stop_daemon
pass "case 3 — wedged orchestrator (alive, no progress) alerts as stalled"
printf '  alert: %s\n' "$CASE3_TEXT"

# ══ Case 4: healthy orchestrator stays silent ═══════════════════════════════
# The alarm is only worth having if it does not cry wolf. Pane keeps changing,
# so progress is fresh on every tick.
: > "$SESSION_FLAG"
start_daemon 1500
for i in $(seq 1 20); do printf 'working step %s\n' "$i" > "$PANE_FILE"; sleep 0.2; done
if grep -q 'orchestrator died\|orchestrator stalled' "$CAPTURE"; then
  fail "false alarm on a healthy orchestrator: $(cat "$CAPTURE")"
fi
stop_daemon
pass "case 4 — a healthy, progressing orchestrator produces no alert"

# ══ Case 5: the disarmed contract stays disarmed ════════════════════════════
# The retired input, proven inert: writing the old JSON ledger must NOT be able
# to arm the alarm, or the repo has quietly grown a second mission store again.
mission_cli mission transition "$WEDGE_ID" failed >/dev/null
cat > "$SCRATCH/home/.claude/orchestrator-missions.json" <<'EOF'
{"active":{"desc":"legacy ledger mission","created_at":"2026-07-30T00:00:00.000Z","status":"active"}}
EOF
rm -f "$SESSION_FLAG"
start_daemon
await_alert 'orchestrator died' 20 || fail "case 5 setup: expected the fail-closed death alert"
if grep -q 'legacy ledger mission' "$CAPTURE"; then
  fail "orchestrator-missions.json is still a live input — the second mission store is back"
fi
assert_no_forbidden_chat
stop_daemon
pass "case 5 — the retired orchestrator-missions.json is inert"

printf '\nALL PASS %s\n' "$(basename "${BASH_SOURCE[0]}")"
