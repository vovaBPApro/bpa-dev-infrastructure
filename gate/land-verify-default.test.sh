#!/usr/bin/env bash
set -euo pipefail

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
bare="$fixture/origin.git"
repo="$fixture/repo"
git init --bare --initial-branch=main "$bare" >/dev/null
git clone "$bare" "$repo" >/dev/null
git -C "$repo" config user.email verify@example.test
git -C "$repo" config user.name Verify
printf 'base\n' > "$repo/base"
git -C "$repo" add base
git -C "$repo" commit -m base >/dev/null
git -C "$repo" push -u origin main >/dev/null
git -C "$repo" checkout -b ag-verify >/dev/null
printf 'lane\n' > "$repo/lane"
git -C "$repo" add lane
git -C "$repo" commit -m lane >/dev/null
lane_sha=$(git -C "$repo" rev-parse HEAD)
git -C "$repo" checkout main >/dev/null
printf 'commit: %s lane\nverify: false\nresult: clean\nsecret-scan: clean\nremaining: none\n' "$lane_sha" > "$fixture/report"
before=$(git -C "$repo" rev-parse main)
if "$root/gate/land.sh" --branch ag-verify --report "$fixture/report" --repo "$repo" --no-push >"$fixture/out" 2>&1; then
  echo "failing verification unexpectedly landed" >&2
  exit 1
fi
test "$(git -C "$repo" rev-parse main)" = "$before"
git -C "$repo" rev-parse --verify ag-verify >/dev/null
if grep -Fq 'LAND verdict=landed' "$fixture/out"; then exit 1; fi
echo "land mandatory verification lock: pass"
