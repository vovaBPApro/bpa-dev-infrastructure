#!/usr/bin/env bash
set -euo pipefail

repo=$(git rev-parse --show-toplevel)
old_sha=93737b2d3d470390de2c94a8c37b8d6e245feae8
tmp=$(mktemp -d /tmp/v3-telegram-red-before.XXXXXX)
trap 'rm -rf -- "$tmp"' EXIT

git -C "$repo" archive "$old_sha" daemon | tar -x -C "$tmp"
cp "$repo/daemon/adapters/telegram.test.ts" "$tmp/daemon/adapters/telegram.test.ts"
cp "$repo/daemon/outbox.test.ts" "$tmp/daemon/outbox.test.ts"

if (cd "$tmp" && bun test daemon/adapters/telegram.test.ts daemon/outbox.test.ts); then
  echo "false green: regression locks passed against $old_sha" >&2
  exit 1
fi

cd "$repo"
bun test daemon/adapters/telegram.test.ts daemon/outbox.test.ts
