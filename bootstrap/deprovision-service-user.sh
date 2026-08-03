#!/usr/bin/env bash
set -euo pipefail

PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

die() { printf 'deprovision-service-user: %s\n' "$*" >&2; exit 2; }
need() {
  local resolved
  resolved="$(command -v "$1" 2>/dev/null)" || die "missing required binary: $1"
  [[ -x "$resolved" ]] || die "required binary is not executable: $1 ($resolved)"
  printf -v "$2" '%s' "$resolved"
}

delete_home=no
if [[ "${1:-}" == --delete-home ]]; then delete_home=yes; shift; fi
[[ $# -le 1 ]] || die 'usage: deprovision-service-user.sh [--delete-home] [config]'
config="${1:-instance/lane-service-user.conf}"
[[ "$EUID" -eq 0 ]] || die 'root is required to de-provision the service user'
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
need loginctl LOGINCTL
need userdel USERDEL
need rm RM
state_root="${LANE_PROVISION_STATE_ROOT:-/var/lib/bpa-dev-infrastructure/service-users}"
marker="$state_root/$LANE_SERVICE_USER.created"
[[ -f "$marker" && ! -L "$marker" ]] || die "refusing unowned user; creation marker missing: $LANE_SERVICE_USER"

declare -A recorded=()
while IFS='=' read -r key value; do recorded["$key"]="$value"; done <"$marker"
[[ "${recorded[user]:-}" == "$LANE_SERVICE_USER" && \
   "${recorded[home]:-}" == "$LANE_SERVICE_HOME" && \
   "${recorded[repo]:-}" == "$LANE_REPOSITORY_ROOT" && \
   "${recorded[worktrees]:-}" == "$LANE_WORKTREES_ROOT" ]] ||
  die 'refusing de-provision; creation marker does not match config'
[[ "$delete_home" == yes ]] || die 'refusing irreversible directory deletion without --delete-home'

if "$GETENT" passwd "$LANE_SERVICE_USER" >/dev/null; then
  "$LOGINCTL" disable-linger "$LANE_SERVICE_USER"
  "$USERDEL" "$LANE_SERVICE_USER"
fi
[[ "${recorded[created_worktrees]:-no}" == yes ]] && "$RM" -rf -- "$LANE_WORKTREES_ROOT"
[[ "${recorded[created_repo]:-no}" == yes ]] && "$RM" -rf -- "$LANE_REPOSITORY_ROOT"
"$RM" -rf -- "$LANE_SERVICE_HOME"
"$RM" -f -- "$marker"
printf 'service user de-provisioned: %s\n' "$LANE_SERVICE_USER"
