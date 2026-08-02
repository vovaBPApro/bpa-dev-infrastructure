#!/usr/bin/env bash
set -euo pipefail

donor=/root/legacy-donors/bpa-master
sha=d0a99b8439f2731654e23b5e7759961f4602d0d3
tmp=$(mktemp -d /tmp/v3-telegram-donor.XXXXXX)
trap 'rm -rf -- "$tmp"' EXIT

git -C "$donor" archive "$sha" | tar -x -C "$tmp"
(cd "$tmp/tools/claude-telegram-daemon" && bun install --frozen-lockfile >/dev/null && \
  bun test status-collector.test.ts orchestrator-runtime-status.test.ts)

mkdir "$tmp/vitest-runner"
printf '%s\n' '{"private":true,"dependencies":{"vitest":"2.1.8"}}' > "$tmp/vitest-runner/package.json"
(cd "$tmp/vitest-runner" && bun install >/dev/null)
ln -s "$tmp/vitest-runner/node_modules" "$tmp/packages/master-orchestrator/node_modules"
(cd "$tmp/packages/master-orchestrator" && \
  ./node_modules/.bin/vitest run src/__tests__/mailbox-ipc.test.ts src/__tests__/mailbox-replay.test.ts)
echo 'donor baseline: completed (not implementation parity)'

cd "$(git rev-parse --show-toplevel)"
bun test daemon/donor-contract-mapping.test.ts
echo 'R2 contract mapping: donor status/mailbox/replay expectations exercised against R2 implementation'
