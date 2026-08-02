#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT
git clone --quiet --no-local "$ROOT" "$SCRATCH/repo"
test "$(git -C "$SCRATCH/repo" rev-parse HEAD)" = "$(git -C "$ROOT" rev-parse HEAD)"
cd "$SCRATCH/repo"
rg -q 'tick-journal-cli.ts.*reconcile|TICK_JOURNAL_CLI.*reconcile' orchestrator/watchdog.sh
rg -q 'tick-journal-cli.ts' orchestrator/morning.sh
bun test core/state.test.ts core/tick-journal-runtime.test.ts
test -z "$(git status --short)"
printf 'tick journal clean-clone reconstruction: PASS\n'
