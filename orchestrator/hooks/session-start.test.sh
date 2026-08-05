#!/usr/bin/env bash
# Behaviour lock for the SessionStart hook itself.
#
# The wiring test proves the hook is tracked and referenced by both provider
# branches. This one proves the property that makes the wiring worth having: a
# load that fails does not degrade quietly. Per `orchestrator-fallback`,
# skipping the load is a fail-closed NO-GO on the session, so a non-zero loader
# must produce an unmissable banner IN the standing context — the one place the
# session is guaranteed to read — and still deliver that context.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
HOOK="$SCRIPT_DIR/session-start.sh"

SCRATCH="$(mktemp -d)"
cleanup() { rm -rf "$SCRATCH"; }
trap cleanup EXIT

failures=0
pass() { printf 'ok   %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1"; failures=$((failures + 1)); }

cat > "$SCRATCH/ok-load.ts" <<'EOF'
console.log('params: phase=sole-mission');
console.log('open row: "HR-2451" — quoted, \\ backslashed,');
console.log('and spread over lines');
process.exit(0);
EOF
cat > "$SCRATCH/ok-check.ts" <<'EOF'
console.log('[docs] OK');
process.exit(0);
EOF
cat > "$SCRATCH/fail-load.ts" <<'EOF'
console.error('ledger unreadable');
process.exit(3);
EOF
cat > "$SCRATCH/fail-check.ts" <<'EOF'
console.log('[ledger] FAIL 4 records');
process.exit(1);
EOF

# Run the hook with a chosen loader pair. Status captured separately from the
# output, never read through a pipe.
run_hook() { # run_hook <loader> <checker>
  HOOK_OUT="$(ORCH_HOOK_REPO_DIR="$REPO_DIR" \
    ORCH_SESSION_LOADER="$1" \
    ORCH_CORPUS_CHECKER="$2" \
    "$HOOK" </dev/null 2>"$SCRATCH/hook.err")"
  HOOK_RC=$?
  HOOK_ERR="$(cat "$SCRATCH/hook.err")"
  return 0
}

# Extract additionalContext, proving the payload is real JSON in the process.
context_of() {
  printf '%s' "$1" | bun -e '
const raw = await Bun.stdin.text();
const parsed = JSON.parse(raw);
const ctx = parsed?.hookSpecificOutput?.additionalContext;
if (typeof ctx !== "string") { process.exit(9); }
if (parsed.hookSpecificOutput.hookEventName !== "SessionStart") { process.exit(8); }
process.stdout.write(ctx);
'
}

# ── 1. Happy path ──────────────────────────────────────────────────────────
run_hook "$SCRATCH/ok-load.ts" "$SCRATCH/ok-check.ts"
(( HOOK_RC == 0 )) && pass "clean load exits 0" || fail "clean load exits 0 — rc=$HOOK_RC err=$HOOK_ERR"

ctx="$(context_of "$HOOK_OUT")"
ctx_rc=$?
if (( ctx_rc == 0 )); then
  pass "reply is valid SessionStart JSON with a string additionalContext"
else
  fail "reply is valid SessionStart JSON with a string additionalContext — rc=$ctx_rc out=$HOOK_OUT"
fi

[[ "$ctx" == *"phase=sole-mission"* ]] \
  && pass "loaded content reaches the standing context" \
  || fail "loaded content reaches the standing context — ctx=$ctx"

# Quotes, backslashes and newlines in the corpus must survive encoding intact —
# a hand-built JSON string would break out here.
[[ "$ctx" == *'"HR-2451" — quoted, \ backslashed,'* && "$ctx" == *"and spread over lines"* ]] \
  && pass "quotes, backslashes and newlines survive JSON encoding" \
  || fail "quotes, backslashes and newlines survive JSON encoding — ctx=$ctx"

[[ "$ctx" != *"NO-GO"* ]] \
  && pass "a clean load raises no banner" \
  || fail "a clean load raises no banner — ctx=$ctx"

[[ "$ctx" == *"check.ts --strict: clean"* ]] \
  && pass "the corpus check records its clean result" \
  || fail "the corpus check records its clean result — ctx=$ctx"

# ── 2. A failing session-load is an unmissable NO-GO, not a degradation ────
run_hook "$SCRATCH/fail-load.ts" "$SCRATCH/ok-check.ts"
ctx="$(context_of "$HOOK_OUT")"

[[ "$ctx" == *"NO-GO"* && "$ctx" == *"SESSION LOAD FAILED"* ]] \
  && pass "a failing loader banners NO-GO in the standing context" \
  || fail "a failing loader banners NO-GO in the standing context — ctx=$ctx"

[[ "$ctx" == *"exit: 3"* ]] \
  && pass "the banner names the exit status" \
  || fail "the banner names the exit status — ctx=$ctx"

[[ "$ctx" == *"ledger unreadable"* ]] \
  && pass "the banner carries the failing step's own output" \
  || fail "the banner carries the failing step's own output — ctx=$ctx"

[[ "$ctx" == *"orchestrator-fallback"* ]] \
  && pass "the banner carries the deterministic manual-load sequence" \
  || fail "the banner carries the deterministic manual-load sequence — ctx=$ctx"

# Exit 0 is deliberate: a non-zero hook exit risks the harness discarding
# additionalContext, which would turn the loud failure back into the silent one.
(( HOOK_RC == 0 )) \
  && pass "the hook still exits 0 so the banner is delivered" \
  || fail "the hook still exits 0 so the banner is delivered — rc=$HOOK_RC"

[[ "$HOOK_ERR" == *"NO-GO"* ]] \
  && pass "the failure is also on stderr for the pane transcript" \
  || fail "the failure is also on stderr for the pane transcript — err=$HOOK_ERR"

# ── 3. A failing corpus check is equally loud ──────────────────────────────
run_hook "$SCRATCH/ok-load.ts" "$SCRATCH/fail-check.ts"
ctx="$(context_of "$HOOK_OUT")"

[[ "$ctx" == *"NO-GO"* && "$ctx" == *"check.ts --strict"* ]] \
  && pass "a red corpus check banners NO-GO" \
  || fail "a red corpus check banners NO-GO — ctx=$ctx"

# The load that DID succeed must still be delivered alongside the banner.
[[ "$ctx" == *"phase=sole-mission"* ]] \
  && pass "a red check still delivers the successful load" \
  || fail "a red check still delivers the successful load — ctx=$ctx"

# ── 4. A missing tool is a banner, never silence ───────────────────────────
run_hook "$SCRATCH/absent-loader.ts" "$SCRATCH/ok-check.ts"
ctx="$(context_of "$HOOK_OUT")"

[[ "$ctx" == *"NO-GO"* && "$ctx" == *"absent-loader.ts"* ]] \
  && pass "a missing loader banners NO-GO and names the path" \
  || fail "a missing loader banners NO-GO and names the path — ctx=$ctx"

# ── 5. Both failing at once ────────────────────────────────────────────────
run_hook "$SCRATCH/fail-load.ts" "$SCRATCH/fail-check.ts"
ctx="$(context_of "$HOOK_OUT")"
banners="$(printf '%s' "$ctx" | grep -c "SESSION LOAD FAILED")"
(( banners == 2 )) \
  && pass "two failing steps produce two banners" \
  || fail "two failing steps produce two banners — got $banners"

printf '\n'
if (( failures > 0 )); then
  printf '%s: %d assertion(s) FAILED\n' "$(basename "$0")" "$failures"
  exit 1
fi
printf '%s: all assertions passed\n' "$(basename "$0")"
