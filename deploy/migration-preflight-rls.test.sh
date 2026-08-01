#!/usr/bin/env bash
# Exact regression fixture for the startup tenant-isolation assertion. The
# production repository supplies its own MIGRATION_PREFLIGHT_COMMAND.
set -euo pipefail
: "${PREFLIGHT_POSTGRES_CONTAINER:?}" "${MIGRATION_FILES:?}"

database="migration_preflight_${RANDOM}_$$"
cleanup() {
  docker exec "$PREFLIGHT_POSTGRES_CONTAINER" dropdb --if-exists --force -h 127.0.0.1 -U postgres "$database" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# PostgreSQL TEMPLATE is the disposable copy boundary in this regression: the
# live_schema database is never migrated or inspected by the candidate app.
docker exec "$PREFLIGHT_POSTGRES_CONTAINER" createdb -h 127.0.0.1 -U postgres -T live_schema "$database"
while IFS= read -r migration; do
  [[ -z "$migration" ]] || docker exec -i "$PREFLIGHT_POSTGRES_CONTAINER" psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -U postgres -d "$database" <"$migration"
done <<<"$MIGRATION_FILES"

docker exec -i "$PREFLIGHT_POSTGRES_CONTAINER" psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -U postgres -d "$database" <<'SQL'
DO $$
DECLARE failure text;
BEGIN
  SELECT string_agg(c.relname || ': ' || concat_ws(', ',
      CASE WHEN a.attname IS NULL THEN 'missing organization_id' END,
      CASE WHEN NOT c.relrowsecurity THEN 'RLS disabled' END,
      CASE WHEN NOT c.relforcerowsecurity THEN 'RLS not forced' END), E'\n')
    INTO failure
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attribute a ON a.attrelid = c.oid
      AND a.attname = 'organization_id' AND NOT a.attisdropped
   WHERE n.nspname = 'public' AND c.relkind = 'r'
     AND c.relname NOT LIKE 'auth_%'
     AND (a.attname IS NULL OR NOT c.relrowsecurity OR NOT c.relforcerowsecurity);
  IF failure IS NOT NULL THEN
    RAISE EXCEPTION 'startup tenant-isolation assertion failed: %', failure;
  END IF;
END $$;
SQL
