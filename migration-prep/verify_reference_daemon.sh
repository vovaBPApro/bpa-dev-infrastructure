#!/usr/bin/env bash
set -euo pipefail

# Read-only provenance check. No files in the target repository are changed.
expected='4cdf3c70c6ec9d28608d7921b4dd4dd31ce340aa'
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

git clone --quiet --depth 1 --branch main \
  git@github.com:vovaBPApro/telegram-dev-daemon.git "$tmp/ref"
actual="$(git -C "$tmp/ref" rev-parse HEAD)"
test "$actual" = "$expected"

required=(
  AGENTS.md
  CLAUDE.md
  docs/orchestrator_policy.md
  docs/roles.md
  docs/review_policy.md
  templates/daemon/server.ts
  templates/daemon/server.test.ts
  templates/daemon/relay.ts
  templates/daemon/relay.test.ts
  templates/daemon/reliability.ts
  templates/daemon/package.json
  templates/daemon/bun.lock
  tools/claude-telegram-daemon/package.json
  tools/claude-telegram-daemon/bun.lock
  tools/claude-telegram-daemon/orchestrator-watchdog.sh
)
for path in "${required[@]}"; do
  git -C "$tmp/ref" ls-tree -r --name-only HEAD | grep -Fx "$path" >/dev/null
done

printf 'reference daemon verified: %s (%s paths)\n' "$actual" "${#required[@]}"
