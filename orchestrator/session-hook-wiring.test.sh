#!/usr/bin/env bash
# Drift lock for the orchestrator SessionStart hook.
#
# The defect this exists to keep dead (audit finding F4): launch.sh declared the
# standing-context hook at $REPO_DIR/.claude/hooks/session-load.sh — a file in
# no commit and on no host — wired it to the codex branch only, and guarded it
# with `[[ -x ]]`, whose false branch wired nothing and printed nothing. The
# live provider is claude, whose branch declared no SessionStart hook at all, so
# every boot came up with no standing context and reported success. 28 inbox
# rows were reachable only through that path.
#
# Each assertion below is written to go RED on a specific regression:
#   - deleting or untracking orchestrator/hooks/session-start.sh
#   - dropping its executable bit (in git or on disk)
#   - unwiring EITHER provider branch
#   - loosening the session-hook guard back to a fail-open `[[ -x ]]` test
#   - letting the hook go down with a refused Stop/turn-end relay
#   - letting the break-glass be taken silently or without a reason
#
# The two relay guards were fail-open on purpose and temporarily. V3-5.6 landed
# the tracked relays and closed both; section 4 now holds the property that
# outlives that bargain — the hook and the relay stand or fall INDEPENDENTLY —
# and orchestrator/heartbeat-writer.test.sh owns the relays themselves.
#
# A mechanism that exists only as a path some host might satisfy is not
# reproducible from git (Hard Floor 5). "Tracked, executable, and referenced by
# both rendered command lines" is that floor made decidable.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LAUNCH="$SCRIPT_DIR/launch.sh"
HOOK_RELATIVE="orchestrator/hooks/session-start.sh"
HOOK_PATH="$REPO_DIR/$HOOK_RELATIVE"

SCRATCH="$(mktemp -d)"
cleanup() { rm -rf "$SCRATCH"; }
trap cleanup EXIT

failures=0
pass() { printf 'ok   %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1"; failures=$((failures + 1)); }
check() { # check <name> <condition-status> [detail]
  if (( $2 == 0 )); then pass "$1"; else fail "$1${3:+ — $3}"; fi
}

mkdir -p "$SCRATCH/runtime" "$SCRATCH/bin"
: > "$SCRATCH/no-runtime.env"

# Stand-in relays. The launcher must REFUSE without them, so the happy-path
# assertions need something executable at those paths; the refusal assertions
# point at a path that does not exist.
for relay in stop-relay turnend-relay; do
  printf '#!/usr/bin/env bash\nexit 0\n' > "$SCRATCH/bin/$relay.sh"
  chmod +x "$SCRATCH/bin/$relay.sh"
done

# Render the command line `start` would exec, without starting anything.
# Captured with command substitution and a separate status read — never through
# a pipe, because a bare pipeline reports only its last command's status.
render() { # render <provider> [env assignments...]
  local provider="$1"
  shift
  RENDER_OUT="$(env \
    ORCH_CONFIG_FILE="$SCRATCH/no-runtime.env" \
    ORCH_RUNTIME_DIR="$SCRATCH/runtime" \
    ORCH_OPS_JOURNAL="$SCRATCH/runtime/ops-journal.log" \
    ORCH_PROVIDER="$provider" \
    ORCH_CLAUDE_STOP_RELAY="$SCRATCH/bin/stop-relay.sh" \
    ORCH_TURNEND_RELAY="$SCRATCH/bin/turnend-relay.sh" \
    "$@" \
    bash "$LAUNCH" render-command 2>"$SCRATCH/render.err")"
  RENDER_RC=$?
  RENDER_ERR="$(cat "$SCRATCH/render.err")"
  return 0
}

# ── 1. The hook is tracked, and tracked as executable ───────────────────────
git -C "$REPO_DIR" ls-files --error-unmatch "$HOOK_RELATIVE" >/dev/null 2>&1
check "hook is tracked in git ls-files" $? "$HOOK_RELATIVE is not in the index"

mode="$(git -C "$REPO_DIR" ls-files --stage "$HOOK_RELATIVE" 2>/dev/null | awk '{print $1}')"
[[ "$mode" == "100755" ]]
check "hook carries git mode 100755" $? "mode is '${mode:-<absent>}'"

[[ -x "$HOOK_PATH" ]]
check "hook is executable on disk" $? "$HOOK_PATH"

# ── 2. Both provider branches reference the hook ────────────────────────────
# Codex declares it on the command line; claude declares it inside the settings
# JSON that build_command materializes, so each branch is asserted where that
# branch actually carries it.
render codex
if (( RENDER_RC == 0 )) && [[ "$RENDER_OUT" == *"$HOOK_PATH"* ]]; then
  pass "codex branch references the hook on its command line"
else
  fail "codex branch references the hook on its command line — rc=$RENDER_RC out=$RENDER_OUT err=$RENDER_ERR"
fi

[[ "$RENDER_OUT" == *"--dangerously-bypass-hook-trust"* ]]
check "codex branch keeps --dangerously-bypass-hook-trust" $? \
  "without it codex drops the hook and a detached pane cannot answer the trust prompt"

render claude
settings_file="$SCRATCH/runtime/claude-relay-settings.json"
if (( RENDER_RC == 0 )) && [[ "$RENDER_OUT" == *"--settings"* ]] && [[ -f "$settings_file" ]]; then
  pass "claude branch renders --settings"
else
  fail "claude branch renders --settings — rc=$RENDER_RC out=$RENDER_OUT err=$RENDER_ERR"
fi

if [[ -f "$settings_file" ]] && grep -q "SessionStart" "$settings_file" \
  && grep -qF "$HOOK_PATH" "$settings_file"; then
  pass "claude settings JSON wires SessionStart to the hook"
else
  fail "claude settings JSON wires SessionStart to the hook — $(cat "$settings_file" 2>/dev/null)"
fi

if [[ -f "$settings_file" ]] && grep -q '"Stop"' "$settings_file"; then
  pass "claude settings JSON still carries the Stop relay"
else
  fail "claude settings JSON still carries the Stop relay"
fi

# Both branches must name the SAME file — one hook, two branches, no fork.
render codex
codex_render="$RENDER_OUT"
render claude
if [[ "$codex_render" == *"$HOOK_PATH"* ]] && grep -qF "$HOOK_PATH" "$settings_file"; then
  pass "both branches wire one and the same hook file"
else
  fail "both branches wire one and the same hook file"
fi

# ── 3. Fail-closed: a missing hook refuses the launch, per provider ─────────
for provider in claude codex; do
  render "$provider" ORCH_SESSION_HOOK="$SCRATCH/does-not-exist.sh"
  if (( RENDER_RC != 0 )) && [[ "$RENDER_ERR" == *"session-hook-unavailable"* ]]; then
    pass "$provider refuses when the hook is missing"
  else
    fail "$provider refuses when the hook is missing — rc=$RENDER_RC err=$RENDER_ERR"
  fi
done

# Present but not executable is equally fail-closed: `[[ -x ]]` conflated the
# two and skipped both.
printf '#!/usr/bin/env bash\nexit 0\n' > "$SCRATCH/not-executable.sh"
chmod -x "$SCRATCH/not-executable.sh"
render claude ORCH_SESSION_HOOK="$SCRATCH/not-executable.sh"
if (( RENDER_RC != 0 )) && [[ "$RENDER_ERR" == *"reason=not executable"* ]]; then
  pass "a non-executable hook refuses and says why"
else
  fail "a non-executable hook refuses and says why — rc=$RENDER_RC err=$RENDER_ERR"
fi

# ── 4. The hook and the relay are independent mechanisms ───────────────────
# Both relay guards were fail-open while the relays existed in no commit; the
# bargain those assertions pinned expired when V3-5.6 landed them as tracked
# files, and both guards now refuse (proved in heartbeat-writer.test.sh). What
# survives, and is asserted here, is the property that made the separation
# right in the first place: neither mechanism may take the other down.
#
# The break-glass is the case where they genuinely diverge — the hook is
# skipped while the relay stands — so it is the honest way to assert the
# independence now that a missing relay refuses outright.
: > "$SCRATCH/runtime/ops-journal.log"
render claude ORCH_SKIP_SESSION_HOOK="V3-5.6 independence check"
if (( RENDER_RC == 0 )) && [[ "$RENDER_OUT" == *"exec claude"* ]] \
  && [[ -f "$settings_file" ]] && grep -q '"Stop"' "$settings_file" \
  && ! grep -q "SessionStart" "$settings_file"; then
  pass "a skipped hook leaves the Stop relay wired and the launch renders"
else
  fail "a skipped hook leaves the Stop relay wired and the launch renders — rc=$RENDER_RC err=$RENDER_ERR $(cat "$settings_file" 2>/dev/null)"
fi

render codex ORCH_SKIP_SESSION_HOOK="V3-5.6 independence check"
if (( RENDER_RC == 0 )) && [[ "$RENDER_OUT" == *"exec codex"* ]] \
  && [[ "$RENDER_OUT" == *"--config notify="* ]] \
  && [[ "$RENDER_OUT" != *"$HOOK_PATH"* ]]; then
  pass "a skipped hook leaves the codex turn-end relay wired"
else
  fail "a skipped hook leaves the codex turn-end relay wired — rc=$RENDER_RC out=$RENDER_OUT err=$RENDER_ERR"
fi

# The converse direction: a refused relay must name the RELAY, never be
# reported as a hook failure. Conflating the two is how a repair gets pointed
# at the wrong mechanism.
render claude ORCH_CLAUDE_STOP_RELAY="$SCRATCH/does-not-exist.sh"
if (( RENDER_RC != 0 )) && [[ "$RENDER_ERR" == *"claude-stop-relay-unavailable"* ]] \
  && [[ "$RENDER_ERR" != *"session-hook-unavailable"* ]]; then
  pass "a missing Stop relay refuses as a RELAY failure, not a hook failure"
else
  fail "a missing Stop relay refuses as a RELAY failure, not a hook failure — rc=$RENDER_RC err=$RENDER_ERR"
fi

# ── 5. Break-glass is explicit, loud, journaled, and never empty ────────────
: > "$SCRATCH/runtime/ops-journal.log"
render claude ORCH_SESSION_HOOK="$SCRATCH/does-not-exist.sh" \
  ORCH_SKIP_SESSION_HOOK="repairing the session-hook tooling"
if (( RENDER_RC == 0 )); then
  pass "break-glass lets a tooling-repair lane launch"
else
  fail "break-glass lets a tooling-repair lane launch — rc=$RENDER_RC err=$RENDER_ERR"
fi

[[ "$RENDER_ERR" == *"orchestrator-session-hook-skipped"* ]]
check "break-glass warns loudly on stderr" $? "err=$RENDER_ERR"

if grep -q "ORCH_SKIP_SESSION_HOOK" "$SCRATCH/runtime/ops-journal.log" \
  && grep -q "repairing the session-hook tooling" "$SCRATCH/runtime/ops-journal.log"; then
  pass "break-glass is journaled with its reason"
else
  fail "break-glass is journaled with its reason — $(cat "$SCRATCH/runtime/ops-journal.log")"
fi

# A skipped hook must leave NO SessionStart wired — a break-glass that silently
# kept a stale wiring would be worse than the fail-open guard it replaced.
if ! grep -q "SessionStart" "$settings_file"; then
  pass "break-glass leaves no SessionStart wiring behind"
else
  fail "break-glass leaves no SessionStart wiring behind — $(cat "$settings_file")"
fi

render claude ORCH_SKIP_SESSION_HOOK=""
if (( RENDER_RC != 0 )) && [[ "$RENDER_ERR" == *"override-empty"* ]]; then
  pass "an empty break-glass is refused"
else
  fail "an empty break-glass is refused — rc=$RENDER_RC err=$RENDER_ERR"
fi

# `=1` is the documented spelling and must work.
: > "$SCRATCH/runtime/ops-journal.log"
render codex ORCH_SESSION_HOOK="$SCRATCH/does-not-exist.sh" ORCH_SKIP_SESSION_HOOK=1
if (( RENDER_RC == 0 )) && grep -q "ORCH_SKIP_SESSION_HOOK" "$SCRATCH/runtime/ops-journal.log"; then
  pass "ORCH_SKIP_SESSION_HOOK=1 works and is journaled"
else
  fail "ORCH_SKIP_SESSION_HOOK=1 works and is journaled — rc=$RENDER_RC err=$RENDER_ERR"
fi

# ── 6. No mechanism in build_command returns to a fail-open guard ──────────
# The source-level half of the lock: the rendered-command assertions above prove
# behaviour, this proves the dead path was not merely bypassed. Fail-open used
# to be permitted at exactly the two relay guards; V3-5.6 closed them, so the
# permitted count is now ZERO and any reappearance is an unnamed silent skip.
# Anchored on `esac`, not on a closing `}`: build_command embeds a bun -e script
# whose JS puts a `}` in column 0, which ends a `/^}/` range early and would have
# hidden the whole codex branch from this check.
body="$(awk '/^build_command\(\)/,/^  esac$/' "$LAUNCH")"

# Comments are stripped first: the citations kept at each repaired guard QUOTE
# the `[[ -x ]]` shape they replaced, and a checker that cannot tell a quoted
# defect from a live one would force the repair to erase its own history.
code="$(printf '%s\n' "$body" | grep -v '^[[:space:]]*#' || true)"
open_guards="$(printf '%s\n' "$code" | grep -c '\[\[ -x' || true)"
[[ "$open_guards" == "0" ]]
check "build_command has no fail-open [[ -x ]] guard left" $? \
  "found $open_guards — every mechanism there routes through require_mechanism"

# The session hook itself resolves through require_mechanism, never through a
# bare -x test that could skip it in silence again.
resolver="$(awk '/^resolve_session_hook\(\)/,/^}/' "$LAUNCH")"
if grep -q 'require_mechanism session-hook' <<<"$resolver" \
  && ! grep -q '\[\[ -x' <<<"$resolver"; then
  pass "the session hook resolves fail-closed, with no [[ -x ]] escape"
else
  fail "the session hook resolves fail-closed, with no [[ -x ]] escape"
fi

printf '\n'
if (( failures > 0 )); then
  printf '%s: %d assertion(s) FAILED\n' "$(basename "$0")" "$failures"
  exit 1
fi
printf '%s: all assertions passed\n' "$(basename "$0")"
