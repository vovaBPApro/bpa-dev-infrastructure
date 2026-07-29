#!/usr/bin/env bash
# Lane-dispatch entry point (INSTRUCTIONS_CONSILIUM_FINAL.md §2.3).
#
# The repo has no lane launcher yet (launch.sh hosts the interactive
# orchestrator, not per-lane prompts). This is the minimal, checked front door
# for launching a lane from a rendered prompt file: it REFUSES any prompt that
# lacks the compose.ts pack marker, so a hand-assembled prompt can never reach a
# lane. The actual launch is intentionally out of scope here — the guarantee this
# script adds is "no marker, no dispatch". Wire a real launcher in after the
# `dispatch-check.ts` gate.
#
# Break-glass: DISPATCH_OVERRIDE=<reason> is honored by dispatch-check.ts (see
# that file); every override is logged to orchestrator/runtime/ops-journal.log
# (gitignored runtime path).
#
# Usage: dispatch-lane.sh <prompt-file> [-- <launcher> [launcher-args...]]
#   With no `-- <launcher>`, the script validates the prompt and exits 0 (a
#   pure gate). With `-- <launcher> ...`, on a passing check it execs the
#   launcher with the prompt path as its first argument.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib.sh"

DISPATCH_CHECK="$REPO_DIR/tools/instructions/dispatch-check.ts"

usage() {
  printf '%s\n' 'Usage: dispatch-lane.sh <prompt-file> [-- <launcher> [args...]]'
}

case "${1:-}" in
  -h|--help|help) usage; exit 0 ;;
  "") usage >&2; exit 2 ;;
esac

PROMPT_FILE="$1"; shift

# Split off an optional `-- launcher args...` tail.
LAUNCHER=()
if [[ "${1:-}" == "--" ]]; then
  shift
  LAUNCHER=("$@")
fi

# The marker gate. dispatch-check.ts exits 3 on refusal, 2 on usage/IO error,
# 0 on OK (marker present OR logged break-glass override). Any non-zero aborts
# the dispatch — fail-closed.
"$BUN_BIN" "$DISPATCH_CHECK" "$PROMPT_FILE" --repo "$REPO_DIR"

if [[ ${#LAUNCHER[@]} -eq 0 ]]; then
  printf 'dispatch-lane: prompt validated, no launcher given (gate-only): %s\n' "$PROMPT_FILE"
  exit 0
fi

exec "${LAUNCHER[@]}" "$PROMPT_FILE"
