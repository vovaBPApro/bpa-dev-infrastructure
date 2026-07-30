#!/usr/bin/env bash
# Regression lock: the Codex notify hook must reach the daemon relay even when
# ORCH_RELAY_URL is not explicitly configured.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

cat > "$SCRATCH/bun" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$1" > "${ORCH_TEST_ARGS:?}"
cat > "${ORCH_TEST_STDIN:?}"
EOF
chmod +x "$SCRATCH/bun"
: > "$SCRATCH/relay.ts"

payload='{"type":"agent-turn-complete","last-assistant-message":"relay check"}'
export BUN_BIN="$SCRATCH/bun"
export ORCH_RELAY_ENTRY="$SCRATCH/relay.ts"
export ORCH_TEST_ARGS="$SCRATCH/args"
export ORCH_TEST_STDIN="$SCRATCH/stdin"
unset ORCH_RELAY_URL

"$SCRIPT_DIR/orchestrator-turnend-relay.sh" "$payload"

[[ "$(cat "$ORCH_TEST_ARGS")" == "$SCRATCH/relay.ts" ]]
[[ "$(cat "$ORCH_TEST_STDIN")" == "$payload" ]]
printf 'turn-end relay regression: PASS\n'
