#!/usr/bin/env bash
# Regression lock: MCP detach/unavailable/invalid are failing health signals,
# and the installed watchdog consumes that signal into its durable nudge path.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK="$SCRIPT_DIR/health-checks/telegram-daemon-mcp.sh"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
expect_failure() {
  local output rc=0
  output="$(TELEGRAM_DAEMON_HEALTH_URL="$1" TELEGRAM_DAEMON_HEALTH_TIMEOUT_SECONDS=1 "$CHECK" 2>&1)" || rc=$?
  [[ "$rc" -ne 0 ]] || fail "$2 returned success"
  [[ "$output" == *"$3"* ]] || fail "$2 omitted verdict: $output"
}

printf '{"mcp_detached":true,"mcp_detached_duration_seconds":12}\n' > "$SCRATCH/detached.json"
printf '{"mcp_detached":false,"connected":true}\n' > "$SCRATCH/connected.json"
printf '{"mcp_detached":false,"connected":false}\n' > "$SCRATCH/contradictory.json"
printf '{"mcp_detached":false}\n' > "$SCRATCH/missing-connected.json"
printf '{"status":"ok"}\n' > "$SCRATCH/invalid.json"

expect_failure "file://$SCRATCH/detached.json" detached 'mcp_detached:true for 12s'
expect_failure "file://$SCRATCH/contradictory.json" contradictory 'MCP connectivity not proven'
expect_failure "file://$SCRATCH/missing-connected.json" missing-connected 'MCP connectivity not proven'
expect_failure "file://$SCRATCH/invalid.json" invalid 'invalid health response'
expect_failure 'http://127.0.0.1:1' unavailable 'health endpoint unavailable'
TELEGRAM_DAEMON_HEALTH_URL="file://$SCRATCH/connected.json" "$CHECK" |
  grep -Fq 'OK telegram-daemon-mcp: MCP connected' || fail 'connected health did not pass'

mkdir -p "$SCRATCH/bin" "$SCRATCH/runtime"
cat > "$SCRATCH/bin/tmux" <<'SHIM'
#!/usr/bin/env bash
case "$1" in
  has-session) exit 0 ;;
  list-panes) ps -o ppid= -p "$PPID" | tr -d ' ' ;;
  list-windows) date +%s ;;
esac
SHIM
cat > "$SCRATCH/bin/df" <<'SHIM'
#!/usr/bin/env bash
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\nfixture 100 10 90 10%% /\n'
SHIM
chmod +x "$SCRATCH/bin/tmux" "$SCRATCH/bin/df"
date +%s > "$SCRATCH/runtime/orchestrator.heartbeat"

PATH="$SCRATCH/bin:$PATH" ORCH_CONFIG_FILE="$SCRATCH/no-config" \
  ORCH_STATE_DB="$SCRATCH/no-state.db" ORCH_RUNTIME_DIR="$SCRATCH/runtime" \
  ORCH_WATCHDOG_LOG="$SCRATCH/runtime/watchdog.log" \
  ORCH_DONE_SENTINEL="$SCRATCH/no-done" ORCH_INSTALL_ROOT="$SCRATCH" \
  ORCH_DAEMON_HEALTH_URL="file://$SCRATCH/detached.json" \
  NUDGE_OUTBOX_FILE="$SCRATCH/runtime/nudges.outbox" \
  FLEET_NUDGE_REPEAT_MS=0 "$SCRIPT_DIR/watchdog.sh"

grep -Fq 'NUDGE daemon-mcp-unhealthy' "$SCRATCH/runtime/nudges.outbox" ||
  fail 'watchdog did not route failed MCP health into durable nudge outbox'
grep -Fq 'mcp_detached:true for 12s' "$SCRATCH/runtime/nudges.outbox" ||
  fail 'watchdog nudge lost the detach verdict'

printf 'telegram daemon MCP health/wiring regression: PASS\n'
