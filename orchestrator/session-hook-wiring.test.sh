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
#   - letting the hook go down with the absent Stop/turn-end relay
#   - dropping the V3-5.6 citation from either deliberately fail-open relay guard
#   - letting the break-glass be taken silently or without a reason
#
# The two relay guards are fail-open on purpose and temporarily; section 4
# explains the bargain and section 6 keeps its expiry date attached.
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

# ── 4. The relay guards stay fail-open, on purpose and temporarily ──────────
# The two relays are the same defect class as the hook and both are absent from
# every commit and every host — but the turn-end relay also owns the heartbeat
# write, so refusing on them would stop the live orchestrator, the operator's
# only channel here, and repairing them means authoring a contract this lane
# does not own. V3-5.6 does. Until then the guards remain fail-open, and these
# assertions pin BOTH halves of that bargain: the launch still renders, and the
# session hook does not go down with the relay.
render claude ORCH_CLAUDE_STOP_RELAY="$SCRATCH/does-not-exist.sh"
if (( RENDER_RC == 0 )) && [[ "$RENDER_OUT" == *"exec claude"* ]]; then
  pass "a missing Stop relay does not refuse the claude launch (V3-5.6 closes this)"
else
  fail "a missing Stop relay does not refuse the claude launch — rc=$RENDER_RC err=$RENDER_ERR"
fi

# The live host's actual condition: relay absent, hook present. The standing
# context must still arrive — that is the whole point of separating the two.
if [[ -f "$settings_file" ]] && grep -q "SessionStart" "$settings_file" \
  && grep -qF "$HOOK_PATH" "$settings_file" && ! grep -q '"Stop"' "$settings_file"; then
  pass "the hook is still wired when the Stop relay is absent"
else
  fail "the hook is still wired when the Stop relay is absent — $(cat "$settings_file" 2>/dev/null)"
fi

render codex ORCH_TURNEND_RELAY="$SCRATCH/does-not-exist.sh"
if (( RENDER_RC == 0 )) && [[ "$RENDER_OUT" == *"exec codex"* ]] \
  && [[ "$RENDER_OUT" != *"--config notify="* ]] \
  && [[ "$RENDER_OUT" == *"$HOOK_PATH"* ]]; then
  pass "a missing turn-end relay does not refuse codex, and the hook survives it"
else
  fail "a missing turn-end relay does not refuse codex, and the hook survives it — rc=$RENDER_RC out=$RENDER_OUT err=$RENDER_ERR"
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

# ── 6. The session hook never returns to a fail-open guard ─────────────────
# The source-level half of the lock: the rendered-command assertions above prove
# behaviour, this proves the dead path was not merely bypassed. Fail-open is
# permitted at EXACTLY the two relay guards and nowhere else, and only while each
# one carries the citation that makes its removal someone's job.
# Anchored on `esac`, not on a closing `}`: build_command embeds a bun -e script
# whose JS puts a `}` in column 0, which ends a `/^}/` range early and would have
# hidden the whole codex branch from this check.
body="$(awk '/^build_command\(\)/,/^  esac$/' "$LAUNCH")"

open_guards="$(printf '%s\n' "$body" | grep -c '\[\[ -x' || true)"
[[ "$open_guards" == "2" ]]
check "build_command has exactly the two relay fail-open guards" $? \
  "found $open_guards — a third would be an unnamed silent skip"

# Each fail-open guard must be preceded by its citation. Checked as "every
# `[[ -x` line has a V3-5.6 mention in the 15 lines above it", so deleting the
# comment turns this red without depending on exact line numbers.
uncited=0
while IFS=: read -r lineno _; do
  [[ -n "$lineno" ]] || continue
  start=$(( lineno > 15 ? lineno - 15 : 1 ))
  context="$(printf '%s\n' "$body" | sed -n "${start},${lineno}p")"
  if ! grep -q 'V3-5\.6' <<<"$context" \
    || ! grep -q '2026-08-05-the-heartbeat-has-had-no-writer-since-yesterday' <<<"$context"; then
    uncited=$((uncited + 1))
  fi
done < <(printf '%s\n' "$body" | grep -n '\[\[ -x' || true)
(( uncited == 0 ))
check "every fail-open guard cites V3-5.6 and the incident file" $? \
  "$uncited guard(s) carry no citation — the marker is exactly what this repository keeps losing"

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
