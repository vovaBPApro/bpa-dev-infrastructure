#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
container="db-access-$RANDOM-$$"
cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run -d --name "$container" -e POSTGRES_PASSWORD=test -p 127.0.0.1::5432 postgres:16-alpine >/dev/null
for _ in $(seq 1 30); do
  port=$(docker port "$container" 5432/tcp | sed 's/.*://')
  admin_url="postgresql://postgres:test@127.0.0.1:$port/postgres"
  psql "$admin_url" -c 'select 1' >/dev/null 2>&1 && break || true
  sleep 1
done
psql "$admin_url" -v ON_ERROR_STOP=1 -c 'CREATE DATABASE agentic' >/dev/null
app_url="postgresql://postgres:test@127.0.0.1:$port/agentic"
if DATABASE_URL="$app_url" bun "$ROOT/database/check-access.ts" 2>"$ROOT/database/.test-error"; then
  echo 'ERROR: absent declaration state passed' >&2; exit 1
fi
grep -Fq 'DB-GRANT ALARM:' "$ROOT/database/.test-error"
echo 'FAIL-BEFORE undeclared role/grants/ownership were silent: PASS'
DATABASE_URL="$app_url" bun "$ROOT/database/check-access.ts" --apply
DATABASE_URL="$app_url" bun "$ROOT/database/check-access.ts"
psql "$app_url" -v ON_ERROR_STOP=1 -c 'REVOKE CREATE ON SCHEMA public FROM agentic' >/dev/null
if DATABASE_URL="$app_url" bun "$ROOT/database/check-access.ts" 2>"$ROOT/database/.test-error"; then
  echo 'ERROR: removed CREATE passed' >&2; exit 1
fi
grep -Fq 'schema public role=agentic missing=CREATE' "$ROOT/database/.test-error"
echo 'FAIL-BEFORE removed CREATE was discovered by outage: scheduled drift lock PASS'
rm -f "$ROOT/database/.test-error"
