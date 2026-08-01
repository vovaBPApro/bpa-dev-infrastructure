#!/usr/bin/env bash
set -euo pipefail

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

single_output="$tmp/land.out"
if BUN_BIN=/bin/true "$root/gate/land.sh" --branch ag-one --report "$tmp/one.md" --repo "$tmp" >"$single_output" 2>&1; then
  echo "land.sh accepted caller-controlled BUN_BIN" >&2
  exit 1
fi
grep -Fq 'detail=caller-bun-override-refused' "$single_output"

batch_output="$tmp/land-batch.out"
if BUN_BIN=/bin/true "$root/gate/land-batch.sh" --branches ag-one,ag-two --reports "$tmp/one.md,$tmp/two.md" --repo "$tmp" >"$batch_output" 2>&1; then
  echo "land-batch.sh accepted caller-controlled BUN_BIN" >&2
  exit 1
fi
grep -Fq 'detail=caller-bun-override-refused' "$batch_output"

legacy_output="$tmp/legacy.out"
if "$root/orchestrator/fleet/land-branch.sh" anything --repo "$tmp" >"$legacy_output" 2>&1; then
  echo "legacy landing entrypoint unexpectedly succeeded" >&2
  exit 1
fi
grep -Fq 'REFUSED: legacy landing path is disabled; use gate/land.sh' "$legacy_output"

echo "landing entrypoint locks: pass"
