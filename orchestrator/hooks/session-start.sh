#!/usr/bin/env bash
# Provider-neutral SessionStart load for the top orchestrator.
#
# ONE hook, both providers. Codex fires SessionStart with the same wire format
# as the Claude harness — same stdin envelope, same
# {"hookSpecificOutput":{"additionalContext":…}} reply — so the loader is shared
# rather than forked per vendor. `orchestrator/launch.sh` wires this exact file
# into both branches (claude: the settings JSON it already writes for the Stop
# relay; codex: --config hooks.SessionStart=…).
#
# It is TRACKED, and that is the point. The path this replaced
# (.claude/hooks/session-load.sh) existed in no commit and on no host, so the
# launcher's `[[ -x ]]` guard skipped it in silence and every claude-provider
# boot came up blind. A mechanism that exists only as a path some host might
# satisfy fails the meteorite test (Hard Floor 5, `reproducible-from-git`);
# session-hook-wiring.test.sh is the lock that keeps this file in git ls-files,
# executable, and referenced by both rendered command lines.
#
# What it loads, in order:
#   1. bun tools/instructions/session-load.ts — params, open ledger rows,
#      untriaged inbox rows, the standing index of binding docs;
#   2. bun tools/instructions/check.ts --strict — the corpus checker at the host
#      tier, so a red ledger is visible at boot rather than at the next landing.
#
# Neither step may fail quietly. Per `orchestrator-fallback` ("Skipping load
# entirely is a fail-closed NO-GO on the session, not a shortcut"), a non-zero
# step emits an unmissable NO-GO banner AS the standing context, carrying that
# document's deterministic manual-load sequence. The hook still exits 0: a
# non-zero hook exit risks the harness DISCARDING additionalContext, which would
# turn a loud failure back into the silent one this file exists to kill.
#
# Break-glass belongs to the launcher (ORCH_SKIP_SESSION_HOOK, journaled), not
# here — a hook that could be told to no-op by its own environment would be the
# fail-open guard again, one level down.
#
# Usage: session-start.sh   (stdin: harness hook envelope, ignored; stdout: JSON)

# Deliberately NOT `set -e`: every step's exit status is captured and turned
# into a verdict. `-e` would abort the hook on the first failing loader and
# emit nothing at all — silence being the one outcome this must never produce.
set -uo pipefail

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ORCH_DIR="$(cd "$HOOK_DIR/.." && pwd)"
REPO_DIR="${ORCH_HOOK_REPO_DIR:-$(cd "$ORCH_DIR/.." && pwd)}"

# Shared resolver (explicit BUN_BIN > ~/.bun/bin/bun > PATH). Sourcing is
# tolerant: lib.sh assigns from `command -v bun`, which fails when bun is not
# installed, and a missing runtime must reach the banner rather than abort here.
BUN_BIN=""
# shellcheck disable=SC1091
source "$ORCH_DIR/lib.sh" 2>/dev/null || true

# Drain the harness envelope. Nothing here needs its fields, but leaving it
# unread can hand the harness an EPIPE on a large payload.
cat >/dev/null 2>&1 || true

SESSION_LOADER="${ORCH_SESSION_LOADER:-$REPO_DIR/tools/instructions/session-load.ts}"
CORPUS_CHECKER="${ORCH_CORPUS_CHECKER:-$REPO_DIR/tools/instructions/check.ts}"

# Emit the SessionStart reply. The context is encoded by bun so no quote,
# newline, or backslash in the corpus can break out of the JSON string. Without
# bun there is nothing to encode WITH, so the fallback is a fully literal
# banner that interpolates nothing.
emit_context() {
  local text="$1" encoded rc payload
  if [[ -n "$BUN_BIN" ]]; then
    # Staged through a file rather than a pipe: the encoder's own exit status is
    # the one that decides whether the reply is usable, and a pipeline hands
    # back only its LAST element's status. Reading it here without a pipe is the
    # same discipline the loaders below use.
    payload="$(mktemp "${TMPDIR:-/tmp}/session-start-context.XXXXXX")"
    printf '%s' "$text" > "$payload"
    encoded="$("$BUN_BIN" -e '
const text = await Bun.stdin.text();
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: text,
  },
}) + "\n");
' < "$payload")"
    rc=$?
    rm -f "$payload"
    if (( rc == 0 )) && [[ -n "$encoded" ]]; then
      printf '%s\n' "$encoded"
      return 0
    fi
  fi
  printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"!!! NO-GO — ORCHESTRATOR SESSION LOAD FAILED !!!\nThe SessionStart hook could not run its loaders (bun unavailable or the encoder failed), so NO standing context was loaded. Treat the load as not done. Before any dispatch, follow instructions/orchestrator-fallback.md: read CLAUDE.md, instance/params.yaml, every instance/decisions/*.md whose state is pending, and every binding doc with audience orchestrator or all. Record the exact files loaded in the mission rollup."}}'
  return 0
}

banner() {
  local step="$1" rc="$2" detail="$3"
  cat <<BANNER
################################################################################
!!! NO-GO — ORCHESTRATOR SESSION LOAD FAILED !!!
step: $step
exit: $rc
################################################################################

The standing context below is INCOMPLETE. Per instructions/orchestrator-fallback.md
this is a fail-closed NO-GO on the session, not a shortcut: do not dispatch until
the load is done. Deterministic recovery — do not stop on a missing tool:

  1. run: bun tools/instructions/session-load.ts --repo $REPO_DIR
  2. if that is missing or exits non-zero, manually read, before any dispatch:
     CLAUDE.md, instance/params.yaml, every instance/decisions/*.md whose
     state is pending, and every binding doc with audience orchestrator or all.
  3. record the exact files loaded in the mission rollup.

Failing step output:
$detail

################################################################################
BANNER
}

# Run one loader, capturing output and status. No pipe: a bare pipeline reports
# only its LAST command's status, and reading \$? after `| tail` is exactly how
# a killed producer gets laundered into a pass (`verification-and-locks`).
run_step() {
  local label="$1" tool="$2"
  shift 2
  local out rc
  if [[ -z "$BUN_BIN" ]]; then
    STEP_OUT="bun runtime not found (BUN_BIN unset, ~/.bun/bin/bun absent, bun not on PATH)"
    return 127
  fi
  if [[ ! -f "$tool" ]]; then
    STEP_OUT="$label tool missing: $tool"
    return 66
  fi
  out="$("$BUN_BIN" "$tool" "$@" 2>&1)"
  rc=$?
  STEP_OUT="$out"
  return "$rc"
}

context=""
failures=""

STEP_OUT=""
run_step "session-load" "$SESSION_LOADER" --repo "$REPO_DIR"
load_rc=$?
load_out="$STEP_OUT"

STEP_OUT=""
run_step "corpus-check" "$CORPUS_CHECKER" --repo "$REPO_DIR" --strict
check_rc=$?
check_out="$STEP_OUT"

if (( load_rc != 0 )); then
  failures+="$(banner "bun tools/instructions/session-load.ts" "$load_rc" "$load_out")"$'\n\n'
fi
if (( check_rc != 0 )); then
  failures+="$(banner "bun tools/instructions/check.ts --strict" "$check_rc" "$check_out")"$'\n\n'
fi

if [[ -n "$failures" ]]; then
  context+="$failures"
  # Also to stderr: the pane transcript and the launcher log are where a human
  # looks when the session comes up wrong, and additionalContext is not visible
  # there.
  printf '%s' "$failures" >&2
fi

if (( load_rc == 0 )); then
  context+="$load_out"$'\n'
fi
if (( check_rc == 0 )); then
  context+=$'\n'"[corpus-check] bun tools/instructions/check.ts --strict: clean"$'\n'
fi

emit_context "$context"
exit 0
