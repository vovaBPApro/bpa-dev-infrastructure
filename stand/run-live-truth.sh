#!/usr/bin/env bash
set -euo pipefail

CONFIG_FILE="${STAND_TRUTH_CONFIG:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/instance/live-stands/agentic-bpa-truth.env}"
PRODUCT_ROOT="${1:?usage: stand/run-live-truth.sh PRODUCT_ROOT}"
[[ -f "$CONFIG_FILE" ]] || { echo "ERROR: missing stand truth config: $CONFIG_FILE" >&2; exit 1; }
[[ -f "$PRODUCT_ROOT/scripts/stand-truth.mjs" ]] || { echo "ERROR: stand truth lock missing from $PRODUCT_ROOT" >&2; exit 1; }
# shellcheck disable=SC1090
source "$CONFIG_FILE"

for name in STAND_URL STAND_REALM STAND_PERIOD STAND_ORGANIZATION STAND_DATABASE_NAME STAND_DATABASE_ROLE STAND_DATABASE_PEER_USER STAND_DATABASE_SOCKET; do
  [[ -n "${!name:-}" ]] || { echo "ERROR: missing $name" >&2; exit 1; }
done
[[ "$(id -un)" == "$STAND_DATABASE_PEER_USER" ]] || { echo "ERROR: peer runner must be $STAND_DATABASE_PEER_USER" >&2; exit 1; }

encoded_options="-c%20app.current_organization_id%3D${STAND_ORGANIZATION}"
STAND_DATABASE_URL="postgresql://${STAND_DATABASE_ROLE}@/${STAND_DATABASE_NAME}?host=${STAND_DATABASE_SOCKET}&options=${encoded_options}"
export STAND_URL STAND_REALM STAND_PERIOD STAND_ORGANIZATION STAND_DATABASE_URL

identity="$(psql -X -At "$STAND_DATABASE_URL" -c "SELECT current_user||'|'||rolsuper||'|'||rolbypassrls FROM pg_roles WHERE rolname=current_user")"
[[ "$identity" == "${STAND_DATABASE_ROLE}|false|false" ]] || { echo "ERROR: unsafe or unavailable stand database identity" >&2; exit 1; }

cd "$PRODUCT_ROOT"
exec node scripts/stand-truth.mjs
