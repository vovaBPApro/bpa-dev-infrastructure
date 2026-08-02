#!/bin/sh
set -eu
target=${1:-d016f05adc4fb0212344f1e77a8240fcd343544e}
locks=${LOCK_SHA:-HEAD}
tmp=$(mktemp -d /tmp/v3-dispatch-red.XXXXXX)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
git archive "$target" | tar -x -C "$tmp"
for file in core/schema.ts orchestrator/dispatcher.test.ts orchestrator/dispatch-wrapper.ts tests/fixtures/noop-worker.ts tests/fixtures/gated-worker.ts tests/fixtures/forged-worker.ts tests/fixtures/never-exit-worker.ts; do
  mkdir -p "$tmp/$(dirname "$file")"
  git show "$locks:$file" > "$tmp/$file"
done
git_dir=$(git rev-parse --absolute-git-dir)
git_tree=$(git rev-parse --show-toplevel)
(cd "$tmp" && GIT_DIR="$git_dir" GIT_WORK_TREE="$git_tree" bun test orchestrator/dispatcher.test.ts)
