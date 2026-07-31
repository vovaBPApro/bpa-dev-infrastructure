#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
CHECK="$ROOT/bootstrap/check-deployed-drift.sh"
DEPLOY="$ROOT/bootstrap/deploy-host-mechanism.sh"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
repo="$TMP/repo"
mkdir -p "$repo/bootstrap" "$repo/bin" "$repo/deployed"
cp "$CHECK" "$DEPLOY" "$repo/bootstrap/"
printf 'parser v1\n' >"$repo/bin/mechanism"
printf 'schema v1\n' >"$repo/schema"
printf 'bin/mechanism\t%s/deployed/mechanism\tschema\n' "$repo" >"$repo/manifest.tsv"
git -C "$repo" init -q -b main
git -C "$repo" config user.email test@example.invalid
git -C "$repo" config user.name test
git -C "$repo" add . && git -C "$repo" commit -qm baseline
cp "$repo/bin/mechanism" "$repo/deployed/mechanism"

env DEPLOY_DRIFT_NOTIFY_URL= DEPLOY_DRIFT_REPO_ROOT="$repo" DEPLOY_DRIFT_MANIFEST="$repo/manifest.tsv" "$repo/bootstrap/check-deployed-drift.sh" >/dev/null

# Required red proof: a deliberately divergent deployed copy must alarm.
printf 'divergent host copy\n' >"$repo/deployed/mechanism"
if env DEPLOY_DRIFT_NOTIFY_URL= DEPLOY_DRIFT_REPO_ROOT="$repo" DEPLOY_DRIFT_MANIFEST="$repo/manifest.tsv" "$repo/bootstrap/check-deployed-drift.sh" >"$TMP/out" 2>"$TMP/err"; then
  echo 'FAIL: divergent deployed copy was accepted' >&2; exit 1
fi
grep -q 'DEPLOY-DRIFT ALARM: deployed mechanism differs' "$TMP/err"
cp "$repo/bin/mechanism" "$repo/deployed/mechanism"
env DEPLOY_DRIFT_NOTIFY_URL= DEPLOY_DRIFT_REPO_ROOT="$repo" DEPLOY_DRIFT_MANIFEST="$repo/manifest.tsv" "$repo/bootstrap/check-deployed-drift.sh" >/dev/null

# An unlanded companion blocks deployment even when the mechanism itself is unchanged.
printf 'schema v2, unlanded\n' >"$repo/schema"
if env DEPLOY_DRIFT_REPO_ROOT="$repo" DEPLOY_DRIFT_MANIFEST="$repo/manifest.tsv" "$repo/bootstrap/deploy-host-mechanism.sh" bin/mechanism >"$TMP/out" 2>"$TMP/err"; then
  echo 'FAIL: deployment with an unlanded companion was accepted' >&2; exit 1
fi
grep -q 'refusing deployment; companion tracked change is absent' "$TMP/err"
git -C "$repo" restore schema

printf 'deployed drift red/restore and unlanded companion locks: PASS\n'
