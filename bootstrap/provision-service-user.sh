#!/usr/bin/env bash
set -euo pipefail

# Bootstrap must work under systemd/cron, whose PATH need not contain sbin.
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

die() { printf 'provision-service-user: %s\n' "$*" >&2; exit 2; }
need() {
  local resolved
  resolved="$(command -v "$1" 2>/dev/null)" || die "missing required binary: $1"
  [[ -x "$resolved" ]] || die "required binary is not executable: $1 ($resolved)"
  printf -v "$2" '%s' "$resolved"
}

config="${1:-instance/lane-service-user.conf}"
[[ "$EUID" -eq 0 ]] || die 'root is required to provision the service user'
[[ -f "$config" && -r "$config" ]] || die "config missing or unreadable: $config"
# shellcheck disable=SC1090
source "$config"
: "${LANE_SERVICE_USER:?missing LANE_SERVICE_USER}"
: "${LANE_SERVICE_HOME:?missing LANE_SERVICE_HOME}"
: "${LANE_REPOSITORY_ROOT:?missing LANE_REPOSITORY_ROOT}"
: "${LANE_WORKTREES_ROOT:?missing LANE_WORKTREES_ROOT}"
[[ "$LANE_SERVICE_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] || die 'invalid LANE_SERVICE_USER'
for path in "$LANE_SERVICE_HOME" "$LANE_REPOSITORY_ROOT" "$LANE_WORKTREES_ROOT"; do
  [[ "$path" == /* && "$path" != / ]] || die "unsafe managed path: $path"
done

need getent GETENT
need useradd USERADD
need id ID
need install INSTALL
need loginctl LOGINCTL

state_root="${LANE_PROVISION_STATE_ROOT:-/var/lib/bpa-dev-infrastructure/service-users}"
marker="$state_root/$LANE_SERVICE_USER.created"
created_user=no
created_repo=no
created_worktrees=no

if ! "$GETENT" passwd "$LANE_SERVICE_USER" >/dev/null; then
  [[ ! -e "$LANE_SERVICE_HOME" ]] ||
    die "refusing unowned home directory: $LANE_SERVICE_HOME"
  "$USERADD" --create-home --home-dir "$LANE_SERVICE_HOME" --shell /bin/bash "$LANE_SERVICE_USER"
  created_user=yes
elif [[ ! -f "$marker" ]]; then
  die "user already exists but was not created by this provisioner: $LANE_SERVICE_USER"
fi

actual_home="$($GETENT passwd "$LANE_SERVICE_USER")"
actual_home="${actual_home#*:*:*:*:*:}"
actual_home="${actual_home%%:*}"
[[ "$actual_home" == "$LANE_SERVICE_HOME" ]] || die "service user home mismatch: $actual_home"
service_group="$($ID -gn "$LANE_SERVICE_USER")"
[[ -d "$LANE_REPOSITORY_ROOT" ]] || created_repo=yes
[[ -d "$LANE_WORKTREES_ROOT" ]] || created_worktrees=yes
if [[ "$created_user" == yes ]]; then
  "$INSTALL" -d -m 0700 "$state_root"
  umask 077
  printf 'user=%s\nhome=%s\nrepo=%s\nworktrees=%s\ncreated_repo=%s\ncreated_worktrees=%s\n' \
    "$LANE_SERVICE_USER" "$LANE_SERVICE_HOME" "$LANE_REPOSITORY_ROOT" \
    "$LANE_WORKTREES_ROOT" "$created_repo" "$created_worktrees" >"$marker"
fi
"$INSTALL" -d -m 0700 -o "$LANE_SERVICE_USER" -g "$service_group" "$LANE_SERVICE_HOME"
"$INSTALL" -d -m 0750 -o "$LANE_SERVICE_USER" -g "$service_group" \
  "$LANE_REPOSITORY_ROOT" "$LANE_WORKTREES_ROOT"
"$LOGINCTL" enable-linger "$LANE_SERVICE_USER"
[[ "$($LOGINCTL show-user "$LANE_SERVICE_USER" -p Linger --value)" == yes ]] ||
  die "linger did not become enabled for service user: $LANE_SERVICE_USER"

printf 'service user provisioned: %s\n' "$LANE_SERVICE_USER"
