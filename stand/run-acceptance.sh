#!/usr/bin/env bash
set -euo pipefail

STAND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly STAND_DIR
REPO_DIR="$(cd "${STAND_DIR}/.." && pwd)"
readonly REPO_DIR
readonly COMPOSE_FILE="${STAND_DIR}/compose.yaml"
readonly ENV_FILE="${STAND_DIR}/env.example"
readonly SERVICE="daemon"
readonly AUTH_PATH="${ACCEPTANCE_AUTH_PATH:-/orchestrator/turn-end}"
readonly AUTH_TOKEN="fake-acceptance-auth-token"
readonly MEMORY_LIMIT_BYTES=268435456
readonly CPU_LIMIT_NANO=500000000

export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-contour-acceptance-$(date +%s)-$$}"
export HOST_PORT="${HOST_PORT:-18482}"

compose() {
  docker compose --project-directory "${STAND_DIR}" --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" "$@"
}

pass() {
  printf 'PASS %s\n' "$*"
}

fail() {
  printf 'FAIL %s\n' "$*" >&2
  exit 1
}

cleanup() {
  local status=$? residual_containers residual_volumes
  if compose down --volumes --remove-orphans; then
    residual_containers="$(docker ps --all --quiet --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}")"
    residual_volumes="$(docker volume ls --quiet --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}")"
    if [[ -n "${residual_containers}" || -n "${residual_volumes}" ]]; then
      printf 'FAIL teardown residual-containers=%s residual-volumes=%s\n' \
        "${residual_containers:-none}" "${residual_volumes:-none}" >&2
      status=1
    else
      pass "teardown project=${COMPOSE_PROJECT_NAME} containers=removed volumes=removed"
    fi
  else
    printf 'FAIL teardown project=%s\n' "${COMPOSE_PROJECT_NAME}" >&2
    status=1
  fi
  trap - EXIT
  exit "${status}"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

assert_host_port() {
  [[ "${HOST_PORT}" =~ ^[0-9]+$ ]] || fail "HOST_PORT must be numeric"
  (( HOST_PORT >= 1024 && HOST_PORT <= 65535 )) || fail "HOST_PORT must be 1024-65535"
  (( HOST_PORT < 3100 || HOST_PORT > 3102 )) || fail "HOST_PORT 3100-3102 is reserved"
  (( HOST_PORT < 8000 || HOST_PORT > 8100 )) || fail "HOST_PORT 8000-8100 is reserved"
}

container_id() {
  compose ps -q "${SERVICE}"
}

assert_runtime_limits() {
  local id memory cpu
  id="$(container_id)"
  [[ -n "${id}" ]] || fail "container id unavailable for resource inspection"
  memory="$(docker inspect --format '{{.HostConfig.Memory}}' "${id}")"
  cpu="$(docker inspect --format '{{.HostConfig.NanoCpus}}' "${id}")"
  [[ "${memory}" == "${MEMORY_LIMIT_BYTES}" ]] || fail "memory limit expected=${MEMORY_LIMIT_BYTES} actual=${memory}"
  [[ "${cpu}" == "${CPU_LIMIT_NANO}" ]] || fail "cpu limit expected=${CPU_LIMIT_NANO} actual=${cpu}"
  pass "resource-limits memory=${memory} cpu_nano=${cpu}"
}

daemon_supports_auth() {
  rg -q 'TELEGRAM_DAEMON_AUTH_TOKEN' "${REPO_DIR}/daemon/server.ts" \
    && rg -qi 'authorization|x[-_]auth|auth.*token|token.*auth' "${REPO_DIR}/daemon/server.ts"
}

assert_authenticated_route() {
  local unauth_status auth_status
  unauth_status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
    --request POST "http://127.0.0.1:${HOST_PORT}${AUTH_PATH}" \
    --header 'content-type: application/json' --data '{}')"
  [[ "${unauth_status}" == "401" || "${unauth_status}" == "403" ]] \
    || fail "unauthenticated route expected=401-or-403 actual=${unauth_status} path=${AUTH_PATH}"
  pass "authenticated-route unauthenticated_status=${unauth_status}"

  auth_status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
    --request POST "http://127.0.0.1:${HOST_PORT}${AUTH_PATH}" \
    --header 'content-type: application/json' \
    --header "authorization: Bearer ${AUTH_TOKEN}" --data '{}')"
  [[ "${auth_status}" != "401" && "${auth_status}" != "403" ]] \
    || fail "authenticated route remained unauthorized status=${auth_status} path=${AUTH_PATH}"
  pass "authenticated-route fake-token-status=${auth_status}"
}

assert_clean_start_fallback() {
  local id state
  id="$(container_id)"
  [[ -n "${id}" ]] || fail "clean-start fallback missing running container"
  state="$(docker inspect --format '{{.State.Status}} {{.State.Health.Status}}' "${id}")"
  [[ "${state}" == "running healthy" ]] || fail "clean-start fallback expected=running-healthy actual=${state}"
  pass "clean-start-fallback listening-and-healthy state=${state}"
}

assert_rollback_relaunch() {
  local before after id
  id="$(container_id)"
  [[ -n "${id}" ]] || fail "rollback container id unavailable before teardown"
  before="$(docker inspect --format '{{.Image}}' "${id}")"
  [[ -n "${before}" ]] || fail "rollback image id unavailable before teardown"
  compose down --volumes --remove-orphans
  compose up --no-build --detach --wait --wait-timeout 90
  id="$(container_id)"
  [[ -n "${id}" ]] || fail "rollback container id unavailable after relaunch"
  after="$(docker inspect --format '{{.Image}}' "${id}")"
  [[ "${after}" == "${before}" ]] || fail "rollback image mismatch before=${before} after=${after}"
  assert_clean_start_fallback
  pass "rollback-relaunch image=${after} health=verified"
}

main() {
  require_command docker
  require_command curl
  require_command rg
  assert_host_port
  [[ -f "${REPO_DIR}/daemon/server.ts" ]] || fail "daemon/server.ts is absent; the daemon lane has not landed"
  [[ -f "${REPO_DIR}/daemon/package.json" ]] || fail "daemon/package.json is absent; the daemon lane has not landed"
  docker info >/dev/null || fail "Docker daemon is unavailable to this user"
  compose config --quiet
  pass "compose-config project=${COMPOSE_PROJECT_NAME}"
  trap cleanup EXIT
  compose up --build --detach --wait --wait-timeout 90
  pass "health service=${SERVICE}"
  assert_runtime_limits
  if daemon_supports_auth; then
    assert_authenticated_route
  else
    assert_clean_start_fallback
  fi
  assert_rollback_relaunch
}

main "$@"
