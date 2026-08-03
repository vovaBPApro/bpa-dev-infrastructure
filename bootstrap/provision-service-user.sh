#!/usr/bin/env bash
set -euo pipefail

die() { printf 'provision-service-user: %s\n' "$*" >&2; exit 2; }
config="${1:-instance/lane-service-user.conf}"
[[ "$EUID" -eq 0 ]] || die 'root is required to provision the service user'
[[ -f "$config" && -r "$config" ]] || die "config missing or unreadable: $config"
# shellcheck disable=SC1090
source "$config"
: "${LANE_SERVICE_USER:?missing LANE_SERVICE_USER}"
: "${LANE_SERVICE_HOME:?missing LANE_SERVICE_HOME}"
: "${LANE_REPOSITORY_ROOT:?missing LANE_REPOSITORY_ROOT}"
: "${LANE_WORKTREES_ROOT:?missing LANE_WORKTREES_ROOT}"

if ! getent passwd "$LANE_SERVICE_USER" >/dev/null; then
  useradd --create-home --home-dir "$LANE_SERVICE_HOME" --shell /bin/bash "$LANE_SERVICE_USER"
fi
actual_home="$(getent passwd "$LANE_SERVICE_USER" | cut -d: -f6)"
[[ "$actual_home" == "$LANE_SERVICE_HOME" ]] || die "service user home mismatch: $actual_home"
service_group="$(id -gn "$LANE_SERVICE_USER")"
install -d -m 0700 -o "$LANE_SERVICE_USER" -g "$service_group" "$LANE_SERVICE_HOME"
install -d -m 0750 -o "$LANE_SERVICE_USER" -g "$service_group" \
  "$LANE_REPOSITORY_ROOT" "$LANE_WORKTREES_ROOT"
loginctl enable-linger "$LANE_SERVICE_USER"
[[ "$(loginctl show-user "$LANE_SERVICE_USER" -p Linger --value)" == yes ]] ||
  die "linger did not become enabled for service user: $LANE_SERVICE_USER"

printf 'service user provisioned: %s\n' "$LANE_SERVICE_USER"
printf 'credentials required (interactive, mode 0600): %s/.codex/auth.json or %s/.claude/.credentials.json\n' \
  "$LANE_SERVICE_HOME" "$LANE_SERVICE_HOME"
