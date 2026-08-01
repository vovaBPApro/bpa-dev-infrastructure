#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACT="${METEORITE_CONTRACT:-$ROOT/meteorite/product.env.example}"
REPORT="${METEORITE_REPORT:-$ROOT/reports/meteorite-latest.md}"
product_sha=unresolved

fail() {
  local reason="$*"
  mkdir -p "$(dirname "$REPORT")"
  {
    printf '# Scheduled product meteorite result\n\n'
    printf -- '- tested-at: `%s`\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf -- '- product-sha: `%s`\n' "$product_sha"
    printf -- '- result: NO-GO\n'
    printf -- '- blocker: %s\n' "$reason"
    printf -- '- non-repository requirements: Docker engine; Git transport/read access for a private repository\n'
  } >"$REPORT"
  printf 'NO-GO %s\n' "$reason" >&2
  exit 1
}
require() { command -v "$1" >/dev/null 2>&1 || fail "non-repository requirement: executable $1"; }

[[ -f "$CONTRACT" ]] || fail "tracked contract missing: $CONTRACT"
# shellcheck disable=SC1090
source "$CONTRACT"
: "${PRODUCT_GIT_URL:?}" "${PRODUCT_GIT_REF:?}" "${PRODUCT_REBUILD_COMMAND:?}" \
  "${PRODUCT_ENV_EXAMPLE:?}" "${PRODUCT_REQUIRED_CONFIG:?}"
require git
require docker
docker info >/dev/null 2>&1 || fail "non-repository requirement: working Docker daemon"

work="$(mktemp -d)"
cleanup() { rm -rf -- "$work"; }
trap cleanup EXIT
repo="$work/product"
git clone --quiet --depth 1 --branch "$PRODUCT_GIT_REF" "$PRODUCT_GIT_URL" "$repo" \
  || fail "non-repository requirement: read access to PRODUCT_GIT_URL"
sha="$(git -C "$repo" rev-parse HEAD)"
product_sha="$sha"

[[ -f "$repo/$PRODUCT_ENV_EXAMPLE" ]] || fail "tracked configuration example absent: $PRODUCT_ENV_EXAMPLE"
for key in ${PRODUCT_REQUIRED_CONFIG//,/ }; do
  grep -Eq "^${key}=" "$repo/$PRODUCT_ENV_EXAMPLE" \
    || fail "required config $key is absent from tracked example $PRODUCT_ENV_EXAMPLE"
  grep -Rqs --exclude-dir=.git --exclude="$(basename "$PRODUCT_ENV_EXAMPLE")" "$key" "$repo" \
    || fail "declared config $key is not referenced by product source"
done
[[ -x "$repo/$PRODUCT_REBUILD_COMMAND" ]] \
  || fail "tracked executable rebuild command absent: $PRODUCT_REBUILD_COMMAND"

started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
log="$work/rebuild.log"
if ! (cd "$repo" && "./$PRODUCT_REBUILD_COMMAND") >"$log" 2>&1; then
  tail -n 80 "$log" >&2
  fail "fresh clone rebuild failed at $sha"
fi

mkdir -p "$(dirname "$REPORT")"
{
  printf '# Scheduled product meteorite result\n\n'
  printf -- '- tested-at: `%s`\n' "$started"
  printf -- '- product-sha: `%s`\n' "$sha"
  printf -- '- source: fresh clone of tracked `%s` at `%s`\n' "$PRODUCT_GIT_URL" "$PRODUCT_GIT_REF"
  printf -- '- configuration: tracked `%s`; required keys `%s` present and source-referenced\n' "$PRODUCT_ENV_EXAMPLE" "$PRODUCT_REQUIRED_CONFIG"
  printf -- '- rebuild: `%s` exited 0 with a disposable database and healthy product\n' "$PRODUCT_REBUILD_COMMAND"
  printf -- '- non-repository requirements: Docker engine; Git transport/read access for a private repository\n'
  printf -- '- result: clean\n'
} >"$REPORT"
printf 'clean product_sha=%s report=%s\n' "$sha" "$REPORT"
