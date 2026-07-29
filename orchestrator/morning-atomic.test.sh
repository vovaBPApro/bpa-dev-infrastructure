#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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
git -C "$FIXTURE_REPO" commit -qm 'first'
FIRST="$(git -C "$FIXTURE_REPO" rev-parse HEAD)"
printf 'two\n' > "$FIXTURE_REPO/two"
git -C "$FIXTURE_REPO" add two
git -C "$FIXTURE_REPO" commit -qm 'second'
HEAD_SHA="$(git -C "$FIXTURE_REPO" rev-parse HEAD)"
printf '%s\n' "$FIRST" > "$WATERMARK"

cat > "$SCRATCH/bootstrap.sh" <<'EOF'
#!/usr/bin/env bash
printf 'PASS fixture-bootstrap\n'
EOF
cat > "$BIN/docker" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
cat > "$BIN/systemctl" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
cat > "$BIN/mv" <<'EOF'
#!/usr/bin/env bash
/bin/mv "$@"
if [[ "${MORNING_CRASH_AFTER_OUTBOX_RENAME:-}" == 1 && "${*: -1}" == "$MORNING_OUTBOX_FILE" ]]; then
  printf 'injected crash after outbox rename\n' >&2
  exit 97
fi
EOF
chmod +x "$SCRATCH/bootstrap.sh" "$BIN/docker" "$BIN/systemctl" "$BIN/mv"

MISSION_CLI="$SCRIPT_DIR/../core/mission-cli.ts"
BUN_PATH="$(command -v bun)"
INFRA_STATE_DB="$RUNTIME/state.db" "$BUN_PATH" "$MISSION_CLI" mission create morning-atomic-fixture >/dev/null

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
run_morning() {
  PATH="$BIN:$PATH" ORCH_RUNTIME_DIR="$RUNTIME" MORNING_OUTBOX_FILE="$OUTBOX" MORNING_WATERMARK_FILE="$WATERMARK" \
    INFRA_STATE_DB="$RUNTIME/state.db" MORNING_REPO_ROOT="$FIXTURE_REPO" MORNING_BOOTSTRAP_SCRIPT="$SCRATCH/bootstrap.sh" \
    MORNING_MISSION_CLI="$MISSION_CLI" BUN_BIN="$BUN_PATH" "$SCRIPT_DIR/morning.sh"
}

if MORNING_CRASH_AFTER_OUTBOX_RENAME=1 run_morning; then
  fail 'post-publication crash injection unexpectedly succeeded'
fi
[[ "$(<"$WATERMARK")" == "$FIRST" ]] || fail 'crash left neither the complete old watermark nor the expected transaction state'
grep -Fq "BPA-MORNING-DIGEST-ID: $HEAD_SHA" "$OUTBOX" || fail 'published digest has no stable HEAD ID'

# Simulate successful daemon delivery and acknowledgement by consuming the file.
FIRST_DELIVERY="$SCRATCH/first-delivery"
cp "$OUTBOX" "$FIRST_DELIVERY"
: > "$OUTBOX"

run_morning
[[ "$(<"$WATERMARK")" == "$HEAD_SHA" ]] || fail 'recovery did not atomically advance the watermark'
[[ ! -s "$OUTBOX" ]] || fail 'same HEAD digest was published a second time after recovery'
grep -Fq 'second' "$FIRST_DELIVERY" || fail 'first delivery did not contain the new commit'
printf 'morning atomic recovery tests: PASS\n'
