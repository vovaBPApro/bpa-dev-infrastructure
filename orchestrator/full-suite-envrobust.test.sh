#!/usr/bin/env bash
# Regression lock: ambient Bun CLI options cannot alter full-suite semantics.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
contains() { grep -Fq -- "$1" "$2" || fail "missing: $1"; }

GREEN_ROOT="$SCRATCH/green-repo"
GREEN_RUNTIME="$SCRATCH/green-runtime"
mkdir -p "$GREEN_ROOT"
printf '%s\n' \
  'import { expect, test } from "bun:test";' \
  'test("ambient-safe green fixture", () => expect(1).toBe(1));' > "$GREEN_ROOT/green.test.ts"

env BUN_OPTIONS=--only-failures ORCH_CONFIG_FILE="$SCRATCH/no-runtime.env" \
  ORCH_INSTALL_ROOT="$GREEN_ROOT" ORCH_RUNTIME_DIR="$GREEN_RUNTIME" \
  FULL_SUITE_LOG="$GREEN_RUNTIME/full-suite.log" \
  "$SCRIPT_DIR/full-suite.sh" || fail 'green fixture became red under ambient BUN_OPTIONS'
contains 'suite=green.test.ts rc=0' "$GREEN_RUNTIME/full-suite.log"

RED_ROOT="$SCRATCH/red-repo"
RED_RUNTIME="$SCRATCH/red-runtime"
mkdir -p "$RED_ROOT"
printf '%s\n' \
  'import { expect, test } from "bun:test";' \
  'test("ambient-safe red fixture", () => expect(1).toBe(2));' > "$RED_ROOT/red.test.ts"

if env BUN_OPTIONS=--test-name-pattern=does-not-match ORCH_CONFIG_FILE="$SCRATCH/no-runtime.env" \
  ORCH_INSTALL_ROOT="$RED_ROOT" ORCH_RUNTIME_DIR="$RED_RUNTIME" \
  FULL_SUITE_LOG="$RED_RUNTIME/full-suite.log" \
  "$SCRIPT_DIR/full-suite.sh"; then
  fail 'ambient BUN_OPTIONS hid the red TypeScript fixture'
fi
contains 'ambient-safe red fixture' "$RED_RUNTIME/full-suite.log"
contains 'suite=red.test.ts rc=' "$RED_RUNTIME/full-suite.log"
contains 'failed=red.test.ts' "$RED_RUNTIME/full-suite.log"

printf 'full-suite env robustness tests: PASS\n'
