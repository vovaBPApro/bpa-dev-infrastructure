#!/usr/bin/env bash
# PINNED TEST FIXTURE — round-2 library, verbatim below this header.
#
# Copy of bootstrap/service-user-lib.sh as of 9cd4e7bdf2db00fd5ad160241d725ef9f72068ad.
# Sourced only by the pinned round-2 fixtures beside it, which carry the guard
# that keeps them inside the disposable test container.
su_die() { printf '%s: %s\n' "${SU_TOOL:?}" "$*" >&2; exit 2; }

su_need() {
  local resolved
  resolved="$(command -v "$1" 2>/dev/null)" || su_die "missing required binary: $1"
  [[ -x "$resolved" ]] || su_die "required binary is not executable: $1 ($resolved)"
  printf -v "$2" '%s' "$resolved"
}

# A path is usable as a managed directory only if it is absolute, is not the
# root, has at least two components, and contains no traversal or empty
# component. Purely lexical: it holds before the directory exists.
su_require_sane_path() {
  local path="$1" role="$2"
  [[ "$path" == /* && "$path" != / ]] || su_die "unsafe managed path ($role): $path"
  [[ "$path" =~ ^/[^/]+/[^/]+ ]] || su_die "managed path is too shallow to delete safely ($role): $path"
  [[ "$path" != *//* ]] || su_die "managed path has an empty component ($role): $path"
  [[ "$path" != */. && "$path" != */.. && "$path" != *"/./"* && "$path" != *"/../"* ]] ||
    su_die "managed path contains a traversal component ($role): $path"
  [[ "$path" != */ ]] || su_die "managed path has a trailing slash ($role): $path"
}

# Validate and export the configured facts. Both scripts run this, so a config
# the provisioner accepts is always one the de-provisioner can reverse.
su_load_config() {
  local config="$1"
  [[ -f "$config" && -r "$config" && ! -L "$config" ]] || su_die "config missing or unreadable: $config"
  # shellcheck disable=SC1090
  source "$config"
  : "${LANE_SERVICE_USER:?missing LANE_SERVICE_USER}"
  : "${LANE_SERVICE_HOME:?missing LANE_SERVICE_HOME}"
  : "${LANE_REPOSITORY_ROOT:?missing LANE_REPOSITORY_ROOT}"
  : "${LANE_WORKTREES_ROOT:?missing LANE_WORKTREES_ROOT}"
  [[ "$LANE_SERVICE_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] || su_die 'invalid LANE_SERVICE_USER'
  [[ "$LANE_SERVICE_USER" != root ]] || su_die 'refusing to manage the root account'
  su_require_sane_path "$LANE_SERVICE_HOME" home
  su_require_sane_path "$LANE_REPOSITORY_ROOT" repository
  su_require_sane_path "$LANE_WORKTREES_ROOT" worktrees

  # Containment, enforced at BOTH ends. The provisioner may only create managed
  # directories under the service home, so the de-provisioner's blast radius is
  # one subtree by construction rather than by the marker's say-so. This costs
  # the configuration a little generality — a repository root at /srv is no
  # longer expressible — and buys a destructive rollback that cannot be pointed
  # at an unrelated tree even by a marker that passed every other check.
  local path
  for path in "$LANE_REPOSITORY_ROOT" "$LANE_WORKTREES_ROOT"; do
    [[ "$path" == "$LANE_SERVICE_HOME"/* ]] ||
      su_die "managed path must nest under the service home ($LANE_SERVICE_HOME): $path"
  done
}

su_state_paths() {
  SU_STATE_ROOT="${LANE_PROVISION_STATE_ROOT:-/var/lib/bpa-dev-infrastructure/service-users}"
  su_require_sane_path "$SU_STATE_ROOT" state-root
  SU_MARKER_PATH="$SU_STATE_ROOT/$LANE_SERVICE_USER.created"
}

# The marker only means anything if nobody but root could have put it there.
# Checked before the marker is opened, and repeated for the marker itself:
# a root-owned marker inside a world-writable directory can be replaced.
su_require_trusted_state_root() {
  local owner mode
  [[ -d "$SU_STATE_ROOT" && ! -L "$SU_STATE_ROOT" ]] ||
    su_die "state directory is missing or not a real directory: $SU_STATE_ROOT"
  owner="$("$SU_STAT" -c %u "$SU_STATE_ROOT")"
  mode="$("$SU_STAT" -c %a "$SU_STATE_ROOT")"
  [[ "$owner" == 0 ]] ||
    su_die "refusing untrusted state directory; not owned by root (uid $owner): $SU_STATE_ROOT"
  (( 8#$mode & 8#22 )) &&
    su_die "refusing untrusted state directory; writable by group or other (mode $mode): $SU_STATE_ROOT"
  return 0
}

su_require_trusted_marker() {
  local owner group mode links
  [[ -f "$SU_MARKER_PATH" && ! -L "$SU_MARKER_PATH" ]] ||
    su_die "refusing invalid creation marker; not a regular file: $SU_MARKER_PATH"
  owner="$("$SU_STAT" -c %u "$SU_MARKER_PATH")"
  group="$("$SU_STAT" -c %g "$SU_MARKER_PATH")"
  mode="$("$SU_STAT" -c %a "$SU_MARKER_PATH")"
  links="$("$SU_STAT" -c %h "$SU_MARKER_PATH")"
  [[ "$owner" == 0 ]] ||
    su_die "refusing forged creation marker; not owned by root (uid $owner): $SU_MARKER_PATH"
  [[ "$group" == 0 ]] ||
    su_die "refusing forged creation marker; not group root (gid $group): $SU_MARKER_PATH"
  (( 8#$mode & 8#77 )) &&
    su_die "refusing forged creation marker; accessible to group or other (mode $mode): $SU_MARKER_PATH"
  [[ "$links" == 1 ]] ||
    su_die "refusing creation marker with $links hard links: $SU_MARKER_PATH"
  return 0
}

# Strict parse. An unknown, repeated or malformed field is a refusal rather
# than a field silently ignored: the marker is an authorisation record, and a
# parser that skips what it does not understand cannot be reasoned about.
su_read_marker() {
  local line key value
  declare -gA SU_MARKER=()
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -n "$line" ]] || continue
    [[ "$line" == *=* ]] || su_die "malformed creation marker line: $line"
    key="${line%%=*}"
    value="${line#*=}"
    case "$key" in
      version|state|user|uid|home|repo|worktrees|created_repo|created_worktrees|created_at|home_id|adopted|adopted_at) ;;
      *) su_die "unknown creation marker field: $key" ;;
    esac
    [[ -z "${SU_MARKER[$key]+set}" ]] || su_die "duplicate creation marker field: $key"
    SU_MARKER["$key"]="$value"
  done <"$SU_MARKER_PATH"
  [[ -n "${SU_MARKER[user]:-}" ]] || su_die "creation marker names no user: $SU_MARKER_PATH"
}

su_require_marker_matches_config() {
  [[ "${SU_MARKER[user]:-}" == "$LANE_SERVICE_USER" && \
     "${SU_MARKER[home]:-}" == "$LANE_SERVICE_HOME" && \
     "${SU_MARKER[repo]:-}" == "$LANE_REPOSITORY_ROOT" && \
     "${SU_MARKER[worktrees]:-}" == "$LANE_WORKTREES_ROOT" ]] ||
    su_die 'refusing; creation marker does not match config'
}

# Atomic replacement, so a marker is never observed half-written: a crash
# between the two states must leave one of them, not a truncated file.
su_write_marker() {
  local content="$1" tmp="$SU_STATE_ROOT/.${LANE_SERVICE_USER}.created.$$"
  ( umask 077; printf '%s\n' "$content" >"$tmp" )
  "$SU_CHMOD" 0600 "$tmp"
  "$SU_MV" -f "$tmp" "$SU_MARKER_PATH"
}

# su_marker_content <state> <uid> <created_repo> <created_worktrees> <created_at> [extra-field ...]
su_marker_content() {
  local extra
  printf 'version=2\nstate=%s\nuser=%s\nuid=%s\nhome=%s\nrepo=%s\nworktrees=%s\ncreated_repo=%s\ncreated_worktrees=%s\ncreated_at=%s\n' \
    "$1" "$LANE_SERVICE_USER" "$2" "$LANE_SERVICE_HOME" "$LANE_REPOSITORY_ROOT" \
    "$LANE_WORKTREES_ROOT" "$3" "$4" "$5"
  for extra in "${@:6}"; do printf '%s\n' "$extra"; done
}

# Read one field out of a passwd entry without shelling out to id(1).
su_passwd_field() {
  local entry field
  entry="$("$SU_GETENT" passwd "$1")" || return 1
  IFS=: read -r _ _ SU_PW_UID SU_PW_GID _ SU_PW_HOME _ <<<"$entry"
  field="$2"
  case "$field" in
    uid) printf '%s' "$SU_PW_UID" ;;
    gid) printf '%s' "$SU_PW_GID" ;;
    home) printf '%s' "$SU_PW_HOME" ;;
  esac
}

# The last gate before rm -rf. A path is deletable only if it is one of the
# managed paths, is a real directory rather than a symlink, resolves to
# somewhere still inside the service home after every symlink in it has been
# followed, and is owned right now by the UID the marker was written for.
# Ownership is what makes "the provisioner created it" checkable at delete
# time; the symlink and canonicalisation checks are what stop the path from
# being swapped for something else between provision and de-provision.
su_require_deletable() {
  local path="$1" role="$2" uid="$3" canonical owner canonical_home
  su_require_sane_path "$path" "$role"
  [[ "$path" == "$LANE_SERVICE_HOME" || "$path" == "$LANE_SERVICE_HOME"/* ]] ||
    su_die "refusing to delete a path outside the service home ($role): $path"
  [[ ! -L "$path" ]] || su_die "refusing to delete a symlink ($role): $path"
  [[ -d "$path" ]] || su_die "refusing to delete a non-directory ($role): $path"
  canonical="$("$SU_REALPATH" -e "$path")" ||
    su_die "refusing to delete an unresolvable path ($role): $path"
  canonical_home="$("$SU_REALPATH" -e "$LANE_SERVICE_HOME")" ||
    su_die "refusing to delete; the service home does not resolve: $LANE_SERVICE_HOME"
  [[ "$canonical" == "$canonical_home" || "$canonical" == "$canonical_home"/* ]] ||
    su_die "refusing to delete a path that resolves outside the service home ($role): $path -> $canonical"
  owner="$("$SU_STAT" -c %u "$path")"
  [[ "$owner" == "$uid" ]] ||
    su_die "refusing to delete a directory the provisioner does not own ($role): $path is uid $owner, marker records uid $uid"
  return 0
}
