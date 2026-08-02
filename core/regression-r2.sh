#!/bin/sh
set -eu

# Rerunnable red/green lock:
#   core/regression-r2.sh 10d6c269f9928288f220716571345050cc5f284b  # fails
#   core/regression-r2.sh HEAD                                      # passes
target=${1:-HEAD}
root=$(git rev-parse --show-toplevel)
tmp=$(mktemp -d /tmp/v3-state-r2.XXXXXX)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
git archive "$target" | tar -x -C "$tmp"
cp "$root/core/state.test.ts" "$tmp/core/state.test.ts"
cp "$root/core/mission-cli.test.ts" "$tmp/core/mission-cli.test.ts"
(cd "$tmp" && bun test core/state.test.ts core/mission-cli.test.ts)
