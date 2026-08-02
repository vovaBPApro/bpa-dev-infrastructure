#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if command -v shellcheck >/dev/null 2>&1; then
  shellcheck "$SCRIPT_DIR"/*.sh
elif command -v docker >/dev/null 2>&1; then
  shellcheck_paths=()
  for shellcheck_file in "$SCRIPT_DIR"/*.sh; do shellcheck_paths+=("/work/${shellcheck_file##*/}"); done
  docker run --rm -v "$SCRIPT_DIR:/work:ro" koalaman/shellcheck:stable "${shellcheck_paths[@]}"
else
  printf 'FAIL: shellcheck or docker is required\n' >&2
  exit 127
fi

SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT
FIXTURE_REPO="$SCRATCH/repo"
RUNTIME="$SCRATCH/runtime"
OUTBOX="$SCRATCH/outbox/morning.txt"
WATERMARK="$RUNTIME/morning.watermark"
BIN="$SCRATCH/bin"
mkdir -p "$FIXTURE_REPO" "$RUNTIME" "$BIN"

git -C "$FIXTURE_REPO" init -q
git -C "$FIXTURE_REPO" config user.email test@example.invalid
git -C "$FIXTURE_REPO" config user.name test
printf 'one\n' > "$FIXTURE_REPO/one"
git -C "$FIXTURE_REPO" add one
git -C "$FIXTURE_REPO" commit -qm 'перший коміт'
FIRST="$(git -C "$FIXTURE_REPO" rev-parse HEAD)"
printf 'two\n' > "$FIXTURE_REPO/two"
git -C "$FIXTURE_REPO" add two
git -C "$FIXTURE_REPO" commit -qm 'другий коміт'
HEAD="$(git -C "$FIXTURE_REPO" rev-parse HEAD)"
printf '%s\n' "$FIRST" > "$WATERMARK"

cat > "$SCRATCH/bootstrap.sh" <<'EOF'
#!/usr/bin/env bash
printf 'PASS fixture-bootstrap\nSKIP token configured fixture\n'
EOF
cat > "$BIN/docker" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
cat > "$BIN/systemctl" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$SCRATCH/bootstrap.sh" "$BIN/docker" "$BIN/systemctl"
MISSION_CLI="$SCRIPT_DIR/../core/mission-cli.ts"
BUN_PATH="$(command -v bun)"
INFRA_STATE_DB="$RUNTIME/state.db" "$BUN_PATH" "$MISSION_CLI" mission create morning-fixture >/dev/null

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
assert() { "$@" || fail "$*"; }
assert_not() { if "$@"; then fail "unexpected success: $*"; fi; }
contains() { grep -Fq "$1" "$2"; }

run_morning() {
  PATH="$BIN:$PATH" ORCH_RUNTIME_DIR="$RUNTIME" MORNING_OUTBOX_FILE="$OUTBOX" MORNING_WATERMARK_FILE="$WATERMARK" \
    INFRA_STATE_DB="$RUNTIME/state.db" MORNING_REPO_ROOT="$FIXTURE_REPO" MORNING_BOOTSTRAP_SCRIPT="$SCRATCH/bootstrap.sh" MORNING_MISSION_CLI="$MISSION_CLI" \
    BUN_BIN="$BUN_PATH" "$SCRIPT_DIR/morning.sh" "$@"
}

assert run_morning
assert contains 'Що нового' "$OUTBOX"
assert contains 'Активні місії / лейни / lease-и' "$OUTBOX"
assert contains 'Готовність' "$OUTBOX"
assert contains 'Що потестити' "$OUTBOX"
assert contains 'другий коміт' "$OUTBOX"
assert contains 'SKIP — stand smoke (docker daemon unavailable)' "$OUTBOX"
assert contains 'PASS — system systemd (system manager available)' "$OUTBOX"
assert contains 'PASS — disk pressure (pct=' "$OUTBOX"
assert contains 'FAIL — watchdog missed-tick journal (UNKNOWN/UNMEASURED or corrupt:' "$OUTBOX"
[[ "$(<"$WATERMARK")" == "$HEAD" ]] || fail 'watermark did not advance'

rm -f "$OUTBOX"
DRY="$(run_morning --dry-run)"
[[ ! -e "$OUTBOX" ]] || fail 'dry-run wrote outbox'
printf '%s\n' "$DRY" | grep -Fq 'Ранковий звіт BPA' || fail 'dry-run did not print digest'

printf 'old complete message\n' > "$OUTBOX"
assert_not env MORNING_INJECT_FAILURE=before-mv PATH="$BIN:$PATH" ORCH_RUNTIME_DIR="$RUNTIME" MORNING_OUTBOX_FILE="$OUTBOX" MORNING_WATERMARK_FILE="$WATERMARK" \
  INFRA_STATE_DB="$RUNTIME/state.db" MORNING_REPO_ROOT="$FIXTURE_REPO" MORNING_BOOTSTRAP_SCRIPT="$SCRATCH/bootstrap.sh" MORNING_MISSION_CLI="$MISSION_CLI" \
  BUN_BIN="$BUN_PATH" "$SCRIPT_DIR/morning.sh"
[[ "$(<"$OUTBOX")" == 'old complete message' ]] || fail 'injected failure partially wrote outbox'

UNIT_DIR="$SCRATCH/units"
assert env PATH="$BIN:$PATH" ORCH_SYSTEMD_USER_DIR="$UNIT_DIR" "$SCRIPT_DIR/install-morning-timer.sh"
assert contains 'OnCalendar=*-*-* 07:40:00 Europe/Warsaw' "$UNIT_DIR/orch-morning-report.timer"
assert contains "ExecStart=$SCRIPT_DIR/morning.sh" "$UNIT_DIR/orch-morning-report.service"
printf 'morning tests: PASS\n'
