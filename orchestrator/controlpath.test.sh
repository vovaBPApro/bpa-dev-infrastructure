#!/usr/bin/env bash
# Regression locks for the installed systemd control path.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SCRATCH="$(mktemp -d)"
TEST_HOME="$SCRATCH/home"
REAL_BUN="$(command -v bun)"

cleanup() {
  rm -rf "$SCRATCH"
}
trap cleanup EXIT
mkdir -p "$TEST_HOME/.bun/bin" "$SCRATCH/runtime"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

# Dead compatibility names must not be read by production control-path code.
if grep -RInE 'ORCHESTRATOR_SESSION|CLAUDE_TMUX_SESSION|launch-orchestrator' \
  "$REPO_DIR/bootstrap/env.template" "$REPO_DIR/daemon" "$REPO_DIR/orchestrator" \
  --include='*.ts' --include='*.sh' --include='*.template' --exclude='*.test.*'; then
  fail 'dead session configuration name or legacy launcher remains'
fi

# Simulate user-systemd: PATH has no /usr/local/bin where Bun is installed.
# The wrapper proves watchdog used HOME/.bun/bin/bun to run the state branch.
cat > "$TEST_HOME/.bun/bin/bun" <<EOF
#!/usr/bin/env bash
printf 'used\n' >> "\${BUN_MARKER:?}"
exec "$REAL_BUN" "\$@"
EOF
chmod +x "$TEST_HOME/.bun/bin/bun"
touch "$SCRATCH/missing.db"
printf 'owner=fixture\ntoken=1\n' > "$SCRATCH/runtime/orchestrator.lease"
env -i PATH=/usr/bin:/bin HOME="$TEST_HOME" BUN_MARKER="$SCRATCH/bun-used" \
  ORCH_CONFIG_FILE="$SCRATCH/no-config" ORCH_SESSION=fixture \
  ORCH_STATE_DB="$SCRATCH/missing.db" ORCH_RUNTIME_DIR="$SCRATCH/runtime" \
  ORCH_WATCHDOG_LOG="$SCRATCH/runtime/watchdog.log" ORCH_LEASE_FILE="$SCRATCH/runtime/orchestrator.lease" \
  ORCH_DONE_SENTINEL="$SCRATCH/no-done-sentinel" ORCH_DAEMON_HEALTH_URL="" \
  "$SCRIPT_DIR/watchdog.sh"
[[ -s "$SCRATCH/bun-used" ]] || fail 'watchdog did not execute Bun through resolved BUN_BIN'

printf 'controlpath tests: PASS\n'
