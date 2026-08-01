#!/usr/bin/env bash
set -euo pipefail

CONFIG_FILE="${STAND_VERIFY_CONFIG:-/etc/bpa-dev-infrastructure/stand-verifier.env}"
[[ -f "$CONFIG_FILE" ]] || { echo "ERROR: missing stand verifier config: $CONFIG_FILE" >&2; exit 1; }
# shellcheck disable=SC1090
source "$CONFIG_FILE"

for name in VERIFY_DATABASE VERIFY_ROLE VERIFY_SCHEMA VERIFY_OWNER_ROLE VERIFY_WRITE_ROLE VERIFY_PEER_USER; do
  value="${!name:-}"
  [[ "$value" =~ ^[a-z_][a-z0-9_-]*$ ]] || { echo "ERROR: invalid or missing $name" >&2; exit 1; }
done

PSQL_BIN="${PSQL_BIN:-/usr/bin/psql}"
if ((EUID == 0)); then
  ADMIN_PSQL=(sudo -u postgres -- "$PSQL_BIN")
elif [[ "$(id -un)" == postgres ]]; then
  ADMIN_PSQL=("$PSQL_BIN")
else
  echo "ERROR: stand verifier bootstrap requires root or postgres" >&2
  exit 1
fi
HBA_FILE="${PG_HBA_FILE:-$("${ADMIN_PSQL[@]}" -X -Atqc 'show hba_file' postgres)}"
IDENT_FILE="${PG_IDENT_FILE:-$("${ADMIN_PSQL[@]}" -X -Atqc 'show ident_file' postgres)}"
MAP_NAME="bpa_stand_verify"
HBA_LINE="local ${VERIFY_DATABASE} ${VERIFY_ROLE} peer map=${MAP_NAME}"
IDENT_LINE="${MAP_NAME} ${VERIFY_PEER_USER} ${VERIFY_ROLE}"

if ! grep -Fxq "$HBA_LINE" "$HBA_FILE"; then
  hba_tmp="$(mktemp "${HBA_FILE}.XXXXXX")"
  awk -v managed="$HBA_LINE" '
    !inserted && $1 == "local" && $2 == "all" && $3 == "all" { print managed; inserted=1 }
    { print }
    END { if (!inserted) exit 42 }
  ' "$HBA_FILE" > "$hba_tmp" || { rm -f "$hba_tmp"; echo "ERROR: generic local peer rule missing" >&2; exit 1; }
  install -o postgres -g postgres -m 640 "$hba_tmp" "$HBA_FILE"
  rm -f "$hba_tmp"
fi
grep -Fxq "$IDENT_LINE" "$IDENT_FILE" || printf '%s\n' "$IDENT_LINE" >> "$IDENT_FILE"

"${ADMIN_PSQL[@]}" -X -v ON_ERROR_STOP=1 -d "$VERIFY_DATABASE" \
  -v verify_database="$VERIFY_DATABASE" -v verify_role="$VERIFY_ROLE" \
  -v verify_schema="$VERIFY_SCHEMA" -v owner_role="$VERIFY_OWNER_ROLE" -v write_role="$VERIFY_WRITE_ROLE" \
  -f - < "$(dirname "$0")/stand-verifier.sql"
"${ADMIN_PSQL[@]}" -X -v ON_ERROR_STOP=1 -d postgres -c 'SELECT pg_reload_conf()' >/dev/null

assert_false() {
  local label="$1" sql="$2" actual
  actual="$("${ADMIN_PSQL[@]}" -X -At -d "$VERIFY_DATABASE" -c "$sql")"
  [[ "$actual" == f ]] || { echo "ERROR: verifier denial failed: $label" >&2; exit 1; }
}

assert_false superuser "SELECT rolsuper FROM pg_roles WHERE rolname='$VERIFY_ROLE'"
assert_false bypassrls "SELECT rolbypassrls FROM pg_roles WHERE rolname='$VERIFY_ROLE'"
assert_false createdb "SELECT rolcreatedb FROM pg_roles WHERE rolname='$VERIFY_ROLE'"
assert_false createrole "SELECT rolcreaterole FROM pg_roles WHERE rolname='$VERIFY_ROLE'"
assert_false schema-create "SELECT has_schema_privilege('$VERIFY_ROLE','$VERIFY_SCHEMA','CREATE')"
assert_false database-create "SELECT has_database_privilege('$VERIFY_ROLE','$VERIFY_DATABASE','CREATE')"
assert_false database-temp "SELECT has_database_privilege('$VERIFY_ROLE','$VERIFY_DATABASE','TEMP')"

echo "STAND VERIFIER OK role=$VERIFY_ROLE peer=$VERIFY_PEER_USER database=$VERIFY_DATABASE select-only=true bypassrls=false"
