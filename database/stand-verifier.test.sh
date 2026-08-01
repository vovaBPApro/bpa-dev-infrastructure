#!/usr/bin/env bash
set -euo pipefail

CONFIG_FILE="${STAND_VERIFY_CONFIG:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/instance/live-stands/agentic-bpa-verifier.env}"
# shellcheck disable=SC1090
source "$CONFIG_FILE"
SOCKET="${STAND_DATABASE_SOCKET:-/var/run/postgresql}"
URL="postgresql://${VERIFY_ROLE}@/${VERIFY_DATABASE}?host=${SOCKET}"

identity="$(psql -X -At "$URL" -c "SELECT rolsuper||'|'||rolcreatedb||'|'||rolcreaterole||'|'||rolbypassrls FROM pg_roles WHERE rolname=current_user")"
[[ "$identity" == 'false|false|false|false' ]]
[[ "$(psql -X -At "$URL" -c "SELECT count(*) > 0 FROM pg_tables WHERE schemaname='$VERIFY_SCHEMA' AND rowsecurity")" == t ]]
[[ "$(psql -X -At "$URL" -c "SELECT count(*) FROM information_schema.role_table_grants WHERE grantee='$VERIFY_ROLE' AND privilege_type <> 'SELECT'")" == 0 ]]
psql -X -At "$URL" -c 'SELECT count(*) FROM imported_transactions' >/dev/null

expect_denied() {
  local label="$1" sql="$2" output
  if output="$(psql -X -v ON_ERROR_STOP=1 "$URL" -c "$sql" 2>&1)"; then
    echo "ERROR: verifier unexpectedly allowed $label" >&2
    exit 1
  fi
  grep -Eqi 'permission denied|must be owner' <<< "$output" || { echo "ERROR: $label failed for the wrong reason" >&2; exit 1; }
  printf 'DENIED %s\n' "$label"
}

expect_denied insert 'INSERT INTO imported_transactions DEFAULT VALUES'
expect_denied update 'UPDATE imported_transactions SET id=id WHERE false'
expect_denied delete 'DELETE FROM imported_transactions WHERE false'
expect_denied create 'CREATE TABLE stand_verifier_must_not_create(id integer)'
expect_denied alter 'ALTER TABLE imported_transactions ADD COLUMN stand_verifier_must_not_alter integer'
expect_denied drop 'DROP TABLE imported_transactions'
echo 'STAND VERIFIER DENIAL PASS select=true write=false create=false drop=false alter=false rls=true'
