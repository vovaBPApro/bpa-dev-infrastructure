#!/usr/bin/env bash
set -euo pipefail

# Real regression lock for the lane/production PostgreSQL network boundary.
# The application stays in the host network namespace and must retain its
# localhost path. A lane unit is denied loopback but may still manage its own
# database through Docker's Unix socket and docker exec.

APP_SERVICE=${APP_SERVICE:-agentic-bpa.service}
PRODUCTION_DB_HOST=${PRODUCTION_DB_HOST:-127.0.0.1}
PRODUCTION_DB_PORT=${PRODUCTION_DB_PORT:-5432}
IMAGE=${LANE_POSTGRES_IMAGE:-postgres:16-alpine}
container="lane-db-boundary-$RANDOM-$$"
scratch="$(mktemp -d)"

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  rm -rf "$scratch"
}
trap cleanup EXIT

command -v systemd-run >/dev/null
command -v nc >/dev/null
command -v docker >/dev/null
systemctl is-active --quiet "$APP_SERVICE"

app_pid="$(systemctl show --property=MainPID --value "$APP_SERVICE")"
[[ "$app_pid" =~ ^[1-9][0-9]*$ ]]
nsenter --target "$app_pid" --net nc -z -w2 "$PRODUCTION_DB_HOST" "$PRODUCTION_DB_PORT"
printf 'application production PostgreSQL reach: PASS\n'

if systemd-run --quiet --wait --pipe --collect \
  --property=IPAddressDeny=localhost \
  nc -z -w2 "$PRODUCTION_DB_HOST" "$PRODUCTION_DB_PORT"; then
  printf 'lane reached production PostgreSQL over localhost\n' >&2
  exit 1
fi
printf 'lane production PostgreSQL reach: BLOCKED\n'

cat >"$scratch/001.sql" <<'SQL'
CREATE TABLE lane_boundary_items (id integer PRIMARY KEY, value text NOT NULL);
INSERT INTO lane_boundary_items VALUES (1, 'seeded-from-git');
SQL

docker run -d --name "$container" \
  --label bpa.dev.owner=db-network-boundary-test \
  --network none \
  -e POSTGRES_PASSWORD=lane-test-only \
  -e POSTGRES_DB=lane_test \
  "$IMAGE" >/dev/null

ready_count=0
for _ in $(seq 1 30); do
  if docker exec "$container" psql -At -U postgres -d lane_test -c 'SELECT 1' >/dev/null 2>&1; then
    ready_count=$((ready_count + 1))
    [[ "$ready_count" -eq 3 ]] && break
  else
    ready_count=0
  fi
  sleep 1
done
[[ "$ready_count" -eq 3 ]]
docker exec -i "$container" psql -v ON_ERROR_STOP=1 -U postgres -d lane_test <"$scratch/001.sql" >/dev/null
value="$(docker exec "$container" psql -At -U postgres -d lane_test -c 'SELECT value FROM lane_boundary_items WHERE id = 1')"
[[ "$value" == seeded-from-git ]]
docker rm -f "$container" >/dev/null
if docker ps -a --format '{{.Names}}' | grep -Fxq "$container"; then
  printf 'disposable PostgreSQL container remained after teardown\n' >&2
  exit 1
fi
printf 'lane disposable PostgreSQL migrate/seed/query/teardown: PASS\n'
