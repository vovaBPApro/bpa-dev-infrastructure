#!/usr/bin/env bash
set -euo pipefail

STAND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly STAND_DIR
readonly COMPOSE_FILE="${STAND_DIR}/compose.yaml"
readonly ENV_FILE="${STAND_DIR}/env.example"
readonly WORKSPACE_ROOT="${STAND_DIR}/workspaces"
readonly SERVICE="daemon"
declare -a MATRIX_NAMES=()
MATRIX_STATUS=0

fail() {
  printf 'FAIL %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "missing-required-command command=$1"
}

validate_name() {
  [[ "$1" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || fail "invalid-name name=$1"
}

project_for() {
  printf 'stand-%s\n' "$1"
}

workspace_for() {
  printf '%s/%s\n' "${WORKSPACE_ROOT}" "$1"
}

compose() {
  local project=$1
  shift
  COMPOSE_PROJECT_NAME="${project}" HOST_PORT=0 docker compose \
    --project-directory "${STAND_DIR}" --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" "$@"
}

container_for_project() {
  local project=$1 id
  id="$(docker ps --quiet --filter "label=com.docker.compose.project=${project}" --filter "label=com.docker.compose.service=${SERVICE}")"
  [[ -n "${id}" ]] || fail "container-missing project=${project}"
  [[ "$(printf '%s\n' "${id}" | wc -l | tr -d ' ')" == 1 ]] || fail "container-count project=${project} ids=${id}"
  printf '%s\n' "${id}"
}

port_for_container() {
  docker inspect --format '{{(index (index .NetworkSettings.Ports "4822/tcp") 0).HostPort}}' "$1"
}

network_for_container() {
  docker inspect --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{end}}' "$1"
}

health_for_container() {
  docker inspect --format '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$1"
}

assert_allowed_port() {
  local port=$1
  [[ "${port}" =~ ^[0-9]+$ ]] || fail "port-not-numeric port=${port}"
  (( port >= 1024 && port <= 65535 )) || fail "port-out-of-range port=${port}"
  (( port < 3100 || port > 3102 )) || fail "port-reserved port=${port} range=3100-3102"
  (( port < 8000 || port > 8100 )) || fail "port-reserved port=${port} range=8000-8100"
}

assert_unique() {
  local label=$1
  shift
  local values
  values="$(printf '%s\n' "$@")"
  [[ "$(printf '%s\n' "${values}" | sort | uniq | wc -l | tr -d ' ')" == "$#" ]] \
    || fail "collision kind=${label} values=$(printf '%s' "${values}" | tr '\n' ',')"
  printf 'PASS collision-check kind=%s source=docker-inspect values=%s\n' \
    "${label}" "$(printf '%s' "${values}" | tr '\n' ',')"
}

up() {
  local name=$1 project workspace id port health
  validate_name "${name}"
  project="$(project_for "${name}")"
  workspace="$(workspace_for "${name}")"
  mkdir -p "${workspace}"
  printf '%s\n' "${project}" > "${workspace}/project"
  compose "${project}" up --build --detach --wait --wait-timeout 90
  id="$(container_for_project "${project}")"
  port="$(port_for_container "${id}")"
  health="$(health_for_container "${id}")"
  assert_allowed_port "${port}"
  [[ "${health}" == 'running/healthy' ]] || fail "unhealthy project=${project} health=${health}"
  printf 'STAND name=%s port=%s project=%s\n' "${name}" "${port}" "${project}"
}

down() {
  local name=$1 project workspace ids networks volumes
  validate_name "${name}"
  project="$(project_for "${name}")"
  workspace="$(workspace_for "${name}")"
  compose "${project}" down --volumes --remove-orphans
  ids="$(docker ps --all --quiet --filter "label=com.docker.compose.project=${project}")"
  networks="$(docker network ls --quiet --filter "label=com.docker.compose.project=${project}")"
  volumes="$(docker volume ls --quiet --filter "label=com.docker.compose.project=${project}")"
  [[ -z "${ids}${networks}${volumes}" ]] || fail "teardown-residual project=${project} containers=${ids:-none} networks=${networks:-none} volumes=${volumes:-none}"
  rm -rf -- "${workspace}"
  printf 'PASS teardown name=%s project=%s workspace=removed\n' "${name}" "${project}"
}

ls_stands() {
  local projects project id candidate
  projects=''
  while IFS= read -r candidate; do
    [[ "${candidate}" == stand-* ]] || continue
    projects+="${candidate}"$'\n'
  done < <(docker ps --format '{{.Label "com.docker.compose.project"}}')
  projects="$(printf '%s' "${projects}" | sort -u)"
  if [[ -z "${projects}" ]]; then
    printf 'STANDS none\n'
    return
  fi
  while IFS= read -r project; do
    id="$(container_for_project "${project}")"
    printf 'STAND project=%s port=%s health=%s network=%s\n' "${project}" \
      "$(port_for_container "${id}")" "$(health_for_container "${id}")" "$(network_for_container "${id}")"
  done <<< "${projects}"
}

stand_leftovers() {
  local containers networks
  containers="$(docker ps --all --format '{{.Names}}' --filter 'name=stand-')"
  networks="$(docker network ls --format '{{.Name}}' --filter 'name=stand-')"
  [[ -z "${containers}${networks}" ]] || fail "leftover-check containers=${containers:-none} networks=${networks:-none}"
  printf 'PASS leftover-check containers=0 networks=0 prefix=stand-\n'
}

run_matrix() {
  local count=$1 name project id port network health
  local -a projects=() ports=() networks=()
  [[ "${count}" =~ ^[1-9][0-9]*$ ]] || fail "invalid-count count=${count}"
  require_command docker
  require_command bun
  docker info >/dev/null || fail 'docker-daemon-unavailable'
  stand_leftovers
  for ((index = 1; index <= count; index++)); do
    MATRIX_NAMES+=("lane-${index}")
  done
  MATRIX_NAMES+=(integration)
  cleanup_matrix() {
    local cleanup_status=0 cleanup_name
    for cleanup_name in "${MATRIX_NAMES[@]}"; do
      down "${cleanup_name}" || cleanup_status=1
    done
    stand_leftovers || cleanup_status=1
    trap - EXIT
    exit $(( MATRIX_STATUS != 0 || cleanup_status != 0 ? 1 : 0 ))
  }
  trap cleanup_matrix EXIT
  for name in "${MATRIX_NAMES[@]}"; do
    up "${name}" &
  done
  while IFS= read -r job; do
    wait "${job}" || MATRIX_STATUS=1
  done < <(jobs -p)
  (( MATRIX_STATUS == 0 )) || fail 'parallel-up-failed'
  for name in "${MATRIX_NAMES[@]}"; do
    project="$(project_for "${name}")"
    id="$(container_for_project "${project}")"
    port="$(port_for_container "${id}")"
    network="$(network_for_container "${id}")"
    health="$(health_for_container "${id}")"
    [[ "${health}" == 'running/healthy' ]] || fail "unhealthy project=${project} health=${health}"
    assert_allowed_port "${port}"
    projects+=("${project}")
    ports+=("${port}")
    networks+=("${network}")
    printf 'PASS live name=%s project=%s port=%s network=%s health=%s source=docker-inspect\n' \
      "${name}" "${project}" "${port}" "${network}" "${health}"
  done
  assert_unique project "${projects[@]}"
  assert_unique port "${ports[@]}"
  assert_unique network "${networks[@]}"
  for name in "${MATRIX_NAMES[@]}"; do
    project="$(project_for "${name}")"
    printf 'PASS acceptance-start name=%s project=%s\n' "${name}" "${project}"
    COMPOSE_PROJECT_NAME="${project}" HOST_PORT="$(port_for_container "$(container_for_project "${project}")")" \
      "${STAND_DIR}/run-acceptance.sh"
    printf 'PASS acceptance-complete name=%s project=%s\n' "${name}" "${project}"
  done
  printf 'PASS matrix-run count=%s integration=1\n' "${count}"
}

main() {
  [[ $# -ge 1 ]] || fail 'usage: matrix.sh <up|down|ls|run> [argument]'
  case "$1" in
    up) [[ $# == 2 ]] || fail 'usage: matrix.sh up <name>'; up "$2" ;;
    down) [[ $# == 2 ]] || fail 'usage: matrix.sh down <name>'; down "$2" ;;
    ls) [[ $# == 1 ]] || fail 'usage: matrix.sh ls'; ls_stands ;;
    run) [[ $# == 2 ]] || fail 'usage: matrix.sh run <count>'; run_matrix "$2" ;;
    *) fail "unknown-command command=$1" ;;
  esac
}

main "$@"
