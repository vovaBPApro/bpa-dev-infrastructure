#!/usr/bin/env bash
set -u
set -o pipefail

root=$(CDPATH='' cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

git init -q "$tmp/repo"
git -C "$tmp/repo" config user.name Test
git -C "$tmp/repo" config user.email test@example.invalid
printf 'base\n' > "$tmp/repo/base.txt"
git -C "$tmp/repo" add base.txt
git -C "$tmp/repo" commit -qm base
git -C "$tmp/repo" branch -M main
git -C "$tmp/repo" checkout -qb ag-secret

google_key="$(printf '%s' AI za)$(printf 'A%.0s' {1..35})"
slack_token="$(printf '%s' xo xb)-$(printf '1%.0s' {1..12})-$(printf 'a%.0s' {1..24})"
printf '%s\n' "$google_key" > "$tmp/repo/secret-google-api-key"
printf '%s\n' "$slack_token" > "$tmp/repo/secret-slack-token"
git -C "$tmp/repo" add secret-google-api-key secret-slack-token
git -C "$tmp/repo" commit -qm fixtures

export LAND_DEFAULT_BRANCH=main
# shellcheck source=gate/land-lib.sh
source "$root/gate/land-lib.sh"
if land_secret_scan "$tmp/repo" ag-secret; then
  echo "FAIL secret scan accepted Google and Slack token shapes"
  exit 1
fi
echo "PASS secret scan rejects Google and Slack token shapes"
