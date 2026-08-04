#!/usr/bin/env bash
# Shared state handling for bootstrap/provision-service-user.sh and
# bootstrap/deprovision-service-user.sh. Sourced by both, never executed: the
# guard that decides whether a deletion is authorised must be one piece of
# code, because two copies of a destructive check drift and only one of them
# gets fixed.
#
# THREAT MODEL, stated plainly.
#
# These scripts run as root and delete accounts and directories. Their only
# durable authority is the creation marker under $LANE_PROVISION_STATE_ROOT.
# An attacker who is ALREADY root can rewrite that marker, rewrite this file,
# edit the account database and delete the directories directly. Nothing here
# stops that and nothing could; a mechanism that claimed otherwise would be
# lying about its own boundary. What the guards below do stop:
#
#   * a marker forged by an unprivileged user — the marker and the directory
#     holding it must be root-owned and closed to group and other BEFORE the
#     marker is read, so a file anyone can write is never a grant;
#   * a marker that has outlived the account it was written for — deleting an
#     account requires that account to carry the witness this marker records,
#     so a same-name replacement is refused;
#   * deletion of anything the provisioner did not create — managed paths must
#     nest under the service home, must not be symlinks, and must be owned by
#     the recorded UID at the moment of deletion.
#
# OBSERVED, NEVER PREDICTED.
#
# The marker is written before useradd runs, so that no instant exists at which
# an account is live and no record claims it. That ordering is only safe if the
# record it leaves cannot be mistaken for authority over an account it never
# created — and every field a pre-creation marker can hold is a PREDICTION. The
# name comes from the config. The home comes from the config. The UID is chosen
# by mirroring useradd's own lowest-free-UID policy, so any later plain
# `useradd` reproduces it exactly. Matching all three proves a SHAPE, not an
# account, and the shape is the one the default tooling produces.
#
# So the marker carries one field that no prediction can supply: a random
# witness, generated before useradd and handed TO useradd, which writes it into
# the account's GECOS field as part of creating the account. Afterwards the
# provisioner reads the account back out of the passwd database and checks the
# witness is there. That read-back is the only thing in this system that
# distinguishes "the account I created" from "an account shaped like the one I
# meant to create".
#
# Deletion authority therefore comes from the LIVE ACCOUNT, never from the
# marker alone: su_account_carries_witness must hold before anything is
# removed. A marker whose witness is absent from the account is a record of an
# intention, and an intention is not a grant.
#
# The witness lives in a marker that is mode 0600 root:root, so an unprivileged
# attacker cannot read it to forge a matching GECOS. The service user can clear
# their own GECOS with chfn(1) and thereby make their own account undeletable
# by this tool; that is a refusal, which is the safe direction.
#
# $LANE_PROVISION_STATE_ROOT is itself an authority input: whoever sets it
# chooses which marker is consulted. It is only settable by the caller, and the
# caller is root, so it sits inside the boundary above rather than defending it.

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
      version|state|user|uid|witness|home|repo|worktrees|created_repo|created_worktrees|created_at|home_id|adopted|adopted_at) ;;
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

# su_marker_content <state> <uid> <witness> <created_repo> <created_worktrees> <created_at> [extra-field ...]
#
# Version 3 adds `witness`. Versions 1 and 2 are refused for deletion rather
# than upgraded: v1 binds a name, v2 binds a name plus a predicted UID, and
# neither can prove which account it was written for. Only the operator can
# assert that, via provision-service-user.sh --adopt-legacy-marker.
su_marker_content() {
  local extra
  printf 'version=3\nstate=%s\nuser=%s\nuid=%s\nwitness=%s\nhome=%s\nrepo=%s\nworktrees=%s\ncreated_repo=%s\ncreated_worktrees=%s\ncreated_at=%s\n' \
    "$1" "$LANE_SERVICE_USER" "$2" "$3" "$LANE_SERVICE_HOME" "$LANE_REPOSITORY_ROOT" \
    "$LANE_WORKTREES_ROOT" "$4" "$5" "$6"
  for extra in "${@:7}"; do printf '%s\n' "$extra"; done
}

# Read one field out of a passwd entry without shelling out to id(1).
su_passwd_field() {
  local entry field
  entry="$("$SU_GETENT" passwd "$1")" || return 1
  IFS=: read -r _ _ SU_PW_UID SU_PW_GID SU_PW_GECOS SU_PW_HOME _ <<<"$entry"
  field="$2"
  case "$field" in
    uid) printf '%s' "$SU_PW_UID" ;;
    gid) printf '%s' "$SU_PW_GID" ;;
    gecos) printf '%s' "$SU_PW_GECOS" ;;
    home) printf '%s' "$SU_PW_HOME" ;;
  esac
}

# ── The witness: the one fact about an account that cannot be predicted ──────

# 128 bits from the kernel CSPRNG. A witness that fell back to something
# guessable would silently turn the whole authority check back into a
# prediction, so failure to produce one is fatal rather than degraded.
su_new_witness() {
  local nonce
  nonce="$("$SU_OD" -An -tx1 -N16 /dev/urandom | "$SU_TR" -d ' \n')" ||
    su_die 'could not read /dev/urandom to generate a provisioning witness'
  su_require_witness_syntax "$nonce"
  printf '%s' "$nonce"
}

su_require_witness_syntax() {
  [[ "${1:-}" =~ ^[0-9a-f]{32}$ ]] ||
    su_die "provisioning witness is not 32 hex characters: ${1:-none}"
}

# The token as it appears in the account's GECOS field. GECOS is
# comma-separated and may not contain a colon; a hex witness needs neither, so
# the token is one whole comma-separated field and is matched as one. Matching
# a substring instead would let a prefix of the witness pass.
su_witness_token() { printf 'service-user-witness=%s' "$1"; }

# THE authority check. True only when the account that is live in the passwd
# database right now carries the witness this marker recorded.
su_account_carries_witness() { # $1=user $2=witness
  local gecos field token
  token="$(su_witness_token "$2")"
  gecos="$(su_passwd_field "$1" gecos)" || return 1
  local IFS=,
  for field in $gecos; do
    if [[ "$field" == "$token" ]]; then return 0; fi
  done
  return 1
}

# Build a GECOS value carrying exactly one witness token, preserving any other
# fields already on the account. Used when the operator adopts an account the
# provisioner cannot prove it created.
su_gecos_with_witness() { # $1=existing gecos $2=witness
  local field
  local -a out=()
  local IFS=,
  for field in $1; do
    if [[ "$field" != service-user-witness=* ]]; then out+=("$field"); fi
  done
  out+=("$(su_witness_token "$2")")
  printf '%s' "${out[*]}"
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
