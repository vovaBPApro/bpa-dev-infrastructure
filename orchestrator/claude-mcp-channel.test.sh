#!/usr/bin/env bash
# Regression lock: the claude launch argv must carry --mcp-config pointing at a
# generated, secret-free config that registers the daemon's legacy-SSE MCP
# endpoint. Without it the orchestrator has only the one-way Stop-hook relay and
# cannot call reply()/status_update() natively.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRATCH="$(mktemp -d)"
TMUX_SOCKET="claude-mcp-channel-$$"
cleanup() {
  tmux -L "$TMUX_SOCKET" kill-server 2>/dev/null || true
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

export BUN_BIN="${BUN_BIN:-bun}"

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
export ORCH_SESSION="claude-mcp-channel-test"
export ORCH_WORK_DIR="$SCRIPT_DIR/.."

# ── The load-bearing invariant ──────────────────────────────────────────────
# The daemon appends a reply-routing hint naming a concrete MCP tool to every
# inbound Telegram message. Claude resolves tools as mcp__<server-name>__<tool>,
# so the MCP server name the launcher registers MUST equal the name baked into
# that hint. If they drift, the orchestrator is told on every inbound to call a
# tool that does not exist and silently degrades to the one-way Stop-hook relay
# — landed-looking but inert. Derive the expected name from the daemon rather
# than hardcoding it, so either side moving fails here.
DAEMON_SRC="$SCRIPT_DIR/../daemon/server.ts"
mapfile -t hint_tools < <(grep -oE 'mcp__[A-Za-z0-9_-]+__reply' "$DAEMON_SRC" | sort -u)
if (( ${#hint_tools[@]} != 1 )); then
  printf 'daemon reply-hint tool name is absent or ambiguous: %s\n' "${hint_tools[*]:-<none>}" >&2
  exit 1
fi
hint_tool="${hint_tools[0]}"
expected_server="${hint_tool#mcp__}"
expected_server="${expected_server%__reply}"
# Pin the current value too, so a rename shows up as a deliberate two-sided edit.
[[ "$expected_server" == 'telegram-daemon' ]] || {
  printf 'daemon hint server name changed: %s\n' "$expected_server" >&2
  exit 1
}

# ── Default port ────────────────────────────────────────────────────────────
"$SCRIPT_DIR/launch.sh" start
mcp_path="$(sed -n '/^--mcp-config$/{n;p;q;}' "$ORCH_TEST_CLAUDE_ARGS")"
[[ "$mcp_path" == "$SCRATCH/runtime/claude-mcp-config.json" ]]
# The Stop-hook relay must survive alongside the MCP channel.
grep -Fxq -- '--settings' "$ORCH_TEST_CLAUDE_ARGS"
grep -Fxq -- '--dangerously-skip-permissions' "$ORCH_TEST_CLAUDE_ARGS"
"$BUN_BIN" -e '
const config = await Bun.file(process.argv[1]).json();
const expectedUrl = process.argv[2];
const expectedServer = process.argv[3];
const servers = config?.mcpServers;
const names = Object.keys(servers ?? {});
if (names.length !== 1 || names[0] !== expectedServer) {
  console.error(`expected exactly one server named ${expectedServer}`, config);
  process.exit(1);
}
const telegram = servers[expectedServer];
// Legacy SSE transport: daemon/server.ts serves GET /sse + POST /message.
if (telegram.type !== "sse" || telegram.url !== expectedUrl) {
  console.error({ actual: telegram, expectedUrl });
  process.exit(1);
}
// Portable + secret-free: loopback only, no auth material of any kind.
const serialized = JSON.stringify(config);
if (!/^http:\/\/127\.0\.0\.1:\d+\/sse$/.test(telegram.url)) {
  console.error("url must be loopback", telegram.url);
  process.exit(1);
}
if (/token|secret|authorization|headers|bearer|api[_-]?key/i.test(serialized)) {
  console.error("config must carry no credentials", serialized);
  process.exit(1);
}
' "$mcp_path" 'http://127.0.0.1:4822/sse' "$expected_server"
"$SCRIPT_DIR/launch.sh" stop

# ── Port override stays wired ───────────────────────────────────────────────
rm -f "$ORCH_TEST_CLAUDE_ARGS"
TELEGRAM_DAEMON_PORT=18482 "$SCRIPT_DIR/launch.sh" start
mcp_path="$(sed -n '/^--mcp-config$/{n;p;q;}' "$ORCH_TEST_CLAUDE_ARGS")"
"$BUN_BIN" -e '
const config = await Bun.file(process.argv[1]).json();
if (config?.mcpServers?.[process.argv[2]]?.url !== "http://127.0.0.1:18482/sse") {
  console.error(config);
  process.exit(1);
}
' "$mcp_path" "$expected_server"
"$SCRIPT_DIR/launch.sh" stop

# ── Untrusted work dir must fail loudly, not stall on the trust prompt ──────
rm -f "$ORCH_TEST_CLAUDE_ARGS"
printf '{"projects":{}}\n' > "$SCRATCH/untrusted-claude.json"
trust_out="$(CLAUDE_CONFIG_FILE="$SCRATCH/untrusted-claude.json" \
  "$SCRIPT_DIR/launch.sh" start 2>&1 || true)"
grep -q 'orchestrator-workdir-untrusted' <<<"$trust_out" || {
  printf 'expected untrusted-workdir failure, got: %s\n' "$trust_out" >&2
  exit 1
}
[[ ! -f "$ORCH_TEST_CLAUDE_ARGS" ]] || {
  printf 'claude must not be launched into a trust prompt\n' >&2
  exit 1
}
# Escape hatch stays open if the harness ever changes its config format.
CLAUDE_CONFIG_FILE="$SCRATCH/untrusted-claude.json" ORCH_SKIP_TRUST_CHECK=1 \
  "$SCRIPT_DIR/launch.sh" start >/dev/null
[[ -f "$ORCH_TEST_CLAUDE_ARGS" ]]
"$SCRIPT_DIR/launch.sh" stop

printf 'claude mcp channel regression: PASS\n'
