#!/usr/bin/env bash
# Regression lock W-31: tmux must never fall back into the daemon cgroup when
# systemd cannot create the independent transient scope.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT
mkdir -p "$SCRATCH/bin"

cat > "$SCRATCH/bin/systemd-run" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' 'fixture: transient scopes unavailable' >&2
exit 1
EOF
cat > "$SCRATCH/bin/tmux" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == has-session ]]; then exit 1; fi
printf '%s\n' "$*" >> "${TMUX_CALLS:?}"
EOF
cat > "$SCRATCH/bin/codex" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat > "$SCRATCH/preflight.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$SCRATCH/bin/"* "$SCRATCH/preflight.sh"

output="$SCRATCH/output"
set +e
env PATH="$SCRATCH/bin:$PATH" TMUX_CALLS="$SCRATCH/tmux.calls" \
  ORCH_CONFIG_FILE="$SCRATCH/absent.env" ORCH_RUNTIME_DIR="$SCRATCH/runtime" \
  ORCH_STATE_DB="$SCRATCH/absent.db" ORCH_INSTANCE_LOCK_FILE="$SCRATCH/instance.lock" \
  ORCH_SINGLETON_LOCK_FILE="$SCRATCH/singleton.lock" ORCH_PROVIDER=codex \
  ORCH_AUTH_PREFLIGHT="$SCRATCH/preflight.sh" ORCH_SKIP_TRUST_CHECK=1 \
  "$SCRIPT_DIR/launch.sh" start >"$output" 2>&1
status=$?
set -e

(( status != 0 )) || { printf 'FAIL: launch succeeded without a transient scope\n' >&2; exit 1; }
grep -q '^ERROR orchestrator-scope-launch-failed ' "$output" || {
  cat "$output" >&2
  printf 'FAIL: missing loud scope failure\n' >&2
  exit 1
}
[[ ! -e "$SCRATCH/tmux.calls" ]] || {
  printf 'FAIL: launcher silently invoked tmux in the daemon cgroup\n' >&2
  exit 1
}
printf 'session cgroup survival tests: PASS\n'
