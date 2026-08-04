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

PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

SU_TOOL=deprovision-service-user
# shellcheck source=bootstrap/service-user-lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/service-user-lib.r2.sh"
die() { su_die "$@"; }

delete_home=no
if [[ "${1:-}" == --delete-home ]]; then delete_home=yes; shift; fi
[[ $# -le 1 ]] || die 'usage: deprovision-service-user.sh [--delete-home] [config]'
config="${1:-instance/lane-service-user.conf}"
[[ "$EUID" -eq 0 ]] || die 'root is required to de-provision the service user'
su_load_config "$config"

su_need getent SU_GETENT
su_need loginctl LOGINCTL
su_need userdel USERDEL
su_need rm RM
su_need stat SU_STAT
su_need realpath SU_REALPATH

su_state_paths

account_present=no
if "$SU_GETENT" passwd "$LANE_SERVICE_USER" >/dev/null; then account_present=yes; fi

if [[ ! -e "$SU_MARKER_PATH" ]]; then
  if [[ "$account_present" == no ]]; then
    printf 'service user already absent: %s\n' "$LANE_SERVICE_USER"
    exit 0
  fi
  die "refusing unowned user; creation marker missing: $LANE_SERVICE_USER"
fi

# Trust before content. Ownership and mode of the state directory and of the
# marker are checked before a single field is read, because a marker anyone
# could have written is a note saying "I made this", not a grant.
su_require_trusted_state_root
su_require_trusted_marker
su_read_marker
su_require_marker_matches_config

marker_version="${SU_MARKER[version]:-1}"
[[ "$marker_version" == 2 ]] ||
  die "refusing; creation marker predates uid binding and cannot identify the account it was written for: $SU_MARKER_PATH; re-run provision-service-user.sh --adopt-legacy-marker to bind it to the account holding that name today, then retry"

marker_state="${SU_MARKER[state]:-}"
[[ "$marker_state" == created || "$marker_state" == creating ]] ||
  die "refusing; creation marker is in an unknown state: ${marker_state:-none}"

marker_uid="${SU_MARKER[uid]:-}"
[[ "$marker_uid" =~ ^[0-9]+$ ]] || die "refusing; creation marker records no usable uid: $SU_MARKER_PATH"
[[ "$marker_uid" != 0 ]] || die 'refusing; creation marker records uid 0'

# Identity, not just name. A marker authorises deletion of the account it was
# written for; once a same-name account has been replaced the UID no longer
# matches, and the replacement is not this marker's to delete.
if [[ "$account_present" == yes ]]; then
  account_uid="$(su_passwd_field "$LANE_SERVICE_USER" uid)"
  account_home="$(su_passwd_field "$LANE_SERVICE_USER" home)"
  [[ "$account_uid" == "$marker_uid" ]] ||
    die "refusing; creation marker was written for uid $marker_uid but $LANE_SERVICE_USER is uid $account_uid"
  [[ "$account_home" == "$LANE_SERVICE_HOME" ]] ||
    die "refusing; account home $account_home does not match the creation marker"
fi

[[ "$delete_home" == yes ]] || die 'refusing irreversible directory deletion without --delete-home'

# Decide the whole deletion set and validate every member BEFORE removing
# anything, so a refusal never lands halfway through a teardown. A managed root
# is a target only if the marker says this provisioner created it; the home is
# always a target, because creating it is what provisioning means.
targets=()
if [[ "${SU_MARKER[created_worktrees]:-no}" == yes && -e "$LANE_WORKTREES_ROOT" ]]; then
  su_require_deletable "$LANE_WORKTREES_ROOT" worktrees "$marker_uid"
  targets+=("$LANE_WORKTREES_ROOT")
fi
if [[ "${SU_MARKER[created_repo]:-no}" == yes && -e "$LANE_REPOSITORY_ROOT" ]]; then
  su_require_deletable "$LANE_REPOSITORY_ROOT" repository "$marker_uid"
  targets+=("$LANE_REPOSITORY_ROOT")
fi
if [[ -e "$LANE_SERVICE_HOME" ]]; then
  su_require_deletable "$LANE_SERVICE_HOME" home "$marker_uid"
  targets+=("$LANE_SERVICE_HOME")
fi

if [[ "$account_present" == yes ]]; then
  "$LOGINCTL" disable-linger "$LANE_SERVICE_USER"
  "$USERDEL" "$LANE_SERVICE_USER"
fi
for target in ${targets[@]+"${targets[@]}"}; do
  "$RM" -rf -- "$target"
done
"$RM" -f -- "$SU_MARKER_PATH"

if [[ "$account_present" == yes ]]; then
  printf 'service user de-provisioned: %s\n' "$LANE_SERVICE_USER"
else
  printf 'service user already absent; creation marker and managed directories cleared: %s\n' "$LANE_SERVICE_USER"
fi
