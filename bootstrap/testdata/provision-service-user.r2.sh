#!/usr/bin/env bash
# PINNED TEST FIXTURE — DO NOT USE FOR REAL PROVISIONING.
#
# Verbatim copy of this script as of ag-s10-7-r2 tip
# 9cd4e7bdf2db00fd5ad160241d725ef9f72068ad (round 2, verdict REJECT). It is
# retained so the round-3 regression locks can execute the PRE-FIX behaviour
# and show it deleting a stranger's account, instead of asserting only that
# the fixed script refuses. A red-before recorded only in prose stops being
# re-executable the moment the report is filed.
#
# Everything below the guard is unmodified round-2 code, including F1, F2 and
# F3. TWO lines are harness scaffolding rather than demonstrated logic:
#   * the guard immediately below, which keeps the vulnerable copy from running
#     anywhere except inside the disposable container the service-user test
#     creates;
#   * the `source` line, repointed at service-user-lib.r2.sh so the fixture
#     runs against round 2's library and not the fixed one beside it.
# bootstrap/provision-service-user.test.sh hashes the rest of the body against
# 9cd4e7bd, so any other edit fails the suite.
[[ -f /.dockerenv && "${SERVICE_USER_TEST_ISOLATED:-0}" == 1 ]] || {
  printf 'pinned round-2 fixture refuses to run outside the disposable test container\n' >&2
  exit 9
}
set -euo pipefail

# Bootstrap must work under systemd/cron, whose PATH need not contain sbin.
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

SU_TOOL=provision-service-user
# shellcheck source=bootstrap/service-user-lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/service-user-lib.r2.sh"
die() { su_die "$@"; }

adopt_legacy=no
if [[ "${1:-}" == --adopt-legacy-marker ]]; then adopt_legacy=yes; shift; fi
[[ $# -le 1 ]] || die 'usage: provision-service-user.sh [--adopt-legacy-marker] [config]'
config="${1:-instance/lane-service-user.conf}"
[[ "$EUID" -eq 0 ]] || die 'root is required to provision the service user'
su_load_config "$config"

su_need getent SU_GETENT
su_need useradd USERADD
su_need id ID
su_need install INSTALL
su_need loginctl LOGINCTL
su_need stat SU_STAT
su_need chmod SU_CHMOD
su_need mv SU_MV
su_need date SU_DATE

su_state_paths
"$INSTALL" -d -m 0700 -o root -g root "$SU_STATE_ROOT"
su_require_trusted_state_root

# Pick the lowest free UID in the login.defs range, the same policy useradd
# applies when it chooses for itself. Reserving the UID here rather than
# letting useradd pick is what lets the marker be complete BEFORE the account
# exists — see the creation sequence below. If getent cannot enumerate every
# account (a network directory, say) the reservation can collide, and useradd
# then fails loudly rather than silently reusing an occupied UID.
allocate_uid() {
  local uid_min=1000 uid_max=60000 line candidate value
  local -A taken=()
  if [[ -r /etc/login.defs ]]; then
    while IFS= read -r line; do
      if [[ "$line" =~ ^[[:space:]]*UID_MIN[[:space:]]+([0-9]+) ]]; then uid_min="${BASH_REMATCH[1]}"; fi
      if [[ "$line" =~ ^[[:space:]]*UID_MAX[[:space:]]+([0-9]+) ]]; then uid_max="${BASH_REMATCH[1]}"; fi
    done </etc/login.defs
  fi
  while IFS=: read -r _ _ value _; do taken["$value"]=1; done < <("$SU_GETENT" passwd)
  for (( candidate = uid_min; candidate <= uid_max; candidate++ )); do
    if [[ -z "${taken[$candidate]:-}" ]]; then printf '%s' "$candidate"; return 0; fi
  done
  die "no free uid in range $uid_min-$uid_max"
}

account_exists=no
if "$SU_GETENT" passwd "$LANE_SERVICE_USER" >/dev/null; then account_exists=yes; fi

marker_present=no
marker_version=0
if [[ -e "$SU_MARKER_PATH" ]]; then
  su_require_trusted_marker
  su_read_marker
  su_require_marker_matches_config
  marker_present=yes
  marker_version="${SU_MARKER[version]:-1}"
  [[ "$marker_version" == 1 || "$marker_version" == 2 ]] ||
    die "unsupported creation marker version: $marker_version"
fi

created_user=no
if [[ "$account_exists" == yes ]]; then
  [[ "$marker_present" == yes ]] ||
    die "user already exists but was not created by this provisioner: $LANE_SERVICE_USER"
  account_uid="$(su_passwd_field "$LANE_SERVICE_USER" uid)"
  if [[ "$marker_version" == 1 ]]; then
    # A marker written before UID binding existed authorises the NAME only,
    # which is exactly the defect this round closes, so it is not silently
    # upgraded: binding it to whatever account currently holds the name is an
    # assertion only the operator can make. The flag is that assertion,
    # recorded in the marker so a later reader can see it was made.
    [[ "$adopt_legacy" == yes ]] ||
      die "legacy creation marker has no uid binding: $SU_MARKER_PATH; re-run with --adopt-legacy-marker to bind it to the existing $LANE_SERVICE_USER (uid $account_uid)"
    su_write_marker "$(su_marker_content created "$account_uid" \
      "${SU_MARKER[created_repo]:-no}" "${SU_MARKER[created_worktrees]:-no}" \
      "${SU_MARKER[created_at]:-unknown}" \
      "home_id=$("$SU_STAT" -c %d:%i "$LANE_SERVICE_HOME")" \
      "adopted=yes" "adopted_at=$("$SU_DATE" -u +%s)")"
    printf 'legacy creation marker adopted and bound to uid %s: %s\n' "$account_uid" "$LANE_SERVICE_USER"
  else
    [[ "${SU_MARKER[uid]:-}" == "$account_uid" ]] ||
      die "creation marker was written for uid ${SU_MARKER[uid]:-none} but $LANE_SERVICE_USER is uid $account_uid"
    if [[ "${SU_MARKER[state]:-}" == creating ]]; then
      # Resumed after an interrupted creation: the account reached the passwd
      # database, so finish the record rather than leaving it half-written.
      su_write_marker "$(su_marker_content created "$account_uid" \
        "${SU_MARKER[created_repo]:-no}" "${SU_MARKER[created_worktrees]:-no}" \
        "${SU_MARKER[created_at]:-unknown}" \
        "home_id=$("$SU_STAT" -c %d:%i "$LANE_SERVICE_HOME")")"
    fi
  fi
else
  [[ ! -e "$LANE_SERVICE_HOME" ]] ||
    die "refusing unowned home directory: $LANE_SERVICE_HOME"
  if [[ "$marker_present" == yes ]]; then
    [[ "$marker_version" == 2 && "${SU_MARKER[state]:-}" == creating ]] ||
      die "creation marker records an account that no longer exists: $SU_MARKER_PATH; run deprovision-service-user.sh --delete-home to clear it first"
    reserved_uid="${SU_MARKER[uid]:-}"
    [[ "$reserved_uid" =~ ^[0-9]+$ ]] || die "creation marker reserves no usable uid: $SU_MARKER_PATH"
    created_repo="${SU_MARKER[created_repo]:-no}"
    created_worktrees="${SU_MARKER[created_worktrees]:-no}"
    created_at="${SU_MARKER[created_at]:-unknown}"
  else
    created_repo=no
    created_worktrees=no
    [[ -d "$LANE_REPOSITORY_ROOT" ]] || created_repo=yes
    [[ -d "$LANE_WORKTREES_ROOT" ]] || created_worktrees=yes
    created_at="$("$SU_DATE" -u +%s)"
    reserved_uid="$(allocate_uid)"
    # The marker is written BEFORE useradd, carrying the UID that useradd is
    # then told to use. That is what removes the pre-marker window: there is no
    # instant at which an account exists and no record claims it, so a crash
    # anywhere in this sequence still leaves a marker the de-provisioner can
    # act on, and the record it leaves already names the account by UID.
    su_write_marker "$(su_marker_content creating "$reserved_uid" \
      "$created_repo" "$created_worktrees" "$created_at")"
  fi
  "$USERADD" --uid "$reserved_uid" --create-home --home-dir "$LANE_SERVICE_HOME" \
    --shell /bin/bash "$LANE_SERVICE_USER"
  account_uid="$(su_passwd_field "$LANE_SERVICE_USER" uid)"
  [[ "$account_uid" == "$reserved_uid" ]] ||
    die "useradd created $LANE_SERVICE_USER as uid $account_uid, not the reserved uid $reserved_uid"
  su_write_marker "$(su_marker_content created "$account_uid" \
    "$created_repo" "$created_worktrees" "$created_at" \
    "home_id=$("$SU_STAT" -c %d:%i "$LANE_SERVICE_HOME")")"
  created_user=yes
fi

actual_home="$(su_passwd_field "$LANE_SERVICE_USER" home)"
[[ "$actual_home" == "$LANE_SERVICE_HOME" ]] || die "service user home mismatch: $actual_home"
service_group="$($ID -gn "$LANE_SERVICE_USER")"
"$INSTALL" -d -m 0700 -o "$LANE_SERVICE_USER" -g "$service_group" "$LANE_SERVICE_HOME"
"$INSTALL" -d -m 0750 -o "$LANE_SERVICE_USER" -g "$service_group" \
  "$LANE_REPOSITORY_ROOT" "$LANE_WORKTREES_ROOT"
"$LOGINCTL" enable-linger "$LANE_SERVICE_USER"
[[ "$($LOGINCTL show-user "$LANE_SERVICE_USER" -p Linger --value)" == yes ]] ||
  die "linger did not become enabled for service user: $LANE_SERVICE_USER"

printf 'service user provisioned: %s\n' "$LANE_SERVICE_USER"
[[ "$created_user" == no ]] || printf 'created uid: %s\n' "$account_uid"
