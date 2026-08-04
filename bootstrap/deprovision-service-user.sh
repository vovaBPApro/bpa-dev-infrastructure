#!/usr/bin/env bash
set -euo pipefail

PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

SU_TOOL=deprovision-service-user
# shellcheck source=bootstrap/service-user-lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/service-user-lib.sh"
die() { su_die "$@"; }

delete_home=no
forget_record=no
while :; do
  case "${1:-}" in
    --delete-home) delete_home=yes; shift ;;
    --forget-record) forget_record=yes; shift ;;
    *) break ;;
  esac
done
[[ $# -le 1 ]] || die 'usage: deprovision-service-user.sh [--delete-home] [--forget-record] [config]'
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

# --forget-record drops this provisioner's claim and nothing else: no account,
# no directory, no linger. It is the answer to a marker that can never become
# authority again — a reservation left by a crash whose name a stranger now
# holds, or a record whose account someone removed by hand. Deleting the file
# is safe precisely BECAUSE the file on its own authorises nothing, and it is
# handled before the format checks below so that a marker too old or too broken
# to be acted on is still one the operator can retire.
if [[ "$forget_record" == yes ]]; then
  "$RM" -f -- "$SU_MARKER_PATH"
  printf 'creation record forgotten: %s\n' "$SU_MARKER_PATH"
  if [[ "$account_present" == yes ]]; then
    printf 'left in place: account %s (uid %s)\n' \
      "$LANE_SERVICE_USER" "$(su_passwd_field "$LANE_SERVICE_USER" uid)"
  fi
  [[ ! -e "$LANE_SERVICE_HOME" ]] || printf 'left in place: %s\n' "$LANE_SERVICE_HOME"
  exit 0
fi

marker_version="${SU_MARKER[version]:-1}"
case "$marker_version" in
  1) die "refusing; creation marker predates uid binding and cannot identify the account it was written for: $SU_MARKER_PATH; re-run provision-service-user.sh --adopt-existing-account to bind it to the account holding that name today, then retry" ;;
  2) die "refusing; creation marker predates witness binding and records only a name, a predicted uid and a predicted home — every one of which a plain useradd reproduces: $SU_MARKER_PATH; re-run provision-service-user.sh --adopt-existing-account to bind it to the account holding that name today, then retry" ;;
  3) ;;
  *) die "refusing; unsupported creation marker version: $marker_version" ;;
esac

marker_state="${SU_MARKER[state]:-}"
[[ "$marker_state" == created || "$marker_state" == creating ]] ||
  die "refusing; creation marker is in an unknown state: ${marker_state:-none}"

marker_uid="${SU_MARKER[uid]:-}"
[[ "$marker_uid" =~ ^[0-9]+$ ]] || die "refusing; creation marker records no usable uid: $SU_MARKER_PATH"
[[ "$marker_uid" != 0 ]] || die 'refusing; creation marker records uid 0'

marker_witness="${SU_MARKER[witness]:-}"
su_require_witness_syntax "$marker_witness"

# ── Authority ───────────────────────────────────────────────────────────────
#
# Nothing above this point is authority. The marker's name, uid and home are
# all values this provisioner CHOSE before the account existed, and the UID was
# chosen by mirroring useradd's own policy, so a plain `useradd` of the same
# name reproduces every one of them. Round 2 deleted on exactly that match and
# destroyed a stranger's account and home.
#
# Authority is one question: does the account that is live right now carry the
# witness this marker recorded? Only the provisioner could have put it there,
# because it was generated into a 0600 root-owned marker and handed to useradd.
if [[ "$account_present" == yes ]]; then
  account_uid="$(su_passwd_field "$LANE_SERVICE_USER" uid)"
  account_home="$(su_passwd_field "$LANE_SERVICE_USER" home)"
  [[ "$account_uid" == "$marker_uid" ]] ||
    die "refusing; creation marker was written for uid $marker_uid but $LANE_SERVICE_USER is uid $account_uid"
  [[ "$account_home" == "$LANE_SERVICE_HOME" ]] ||
    die "refusing; account home $account_home does not match the creation marker"
  su_account_carries_witness "$LANE_SERVICE_USER" "$marker_witness" ||
    die "refusing; $LANE_SERVICE_USER (uid $account_uid) does not carry the provisioning witness recorded in $SU_MARKER_PATH, so this provisioner did not create it — the marker matches this account's name, uid and home only because those were predicted before any account existed; drop the stale claim with '--forget-record' or take ownership with 'provision-service-user.sh --adopt-existing-account'"
fi

# A marker whose account is gone has no live witness, so it can prove nothing
# about the directories left at the recorded paths either: a stranger's tree can
# sit at that path owned by a recycled uid. Round 2 deleted them anyway. Clear
# the record, name what was left behind, and delete nothing.
if [[ "$account_present" == no ]]; then
  "$RM" -f -- "$SU_MARKER_PATH"
  if [[ "$marker_state" == creating ]]; then
    printf 'stale reservation cleared; no account was ever created: %s\n' "$LANE_SERVICE_USER"
  else
    printf 'creation record cleared; the account it named is already gone: %s\n' "$LANE_SERVICE_USER"
  fi
  for orphan in "$LANE_SERVICE_HOME" "$LANE_REPOSITORY_ROOT" "$LANE_WORKTREES_ROOT"; do
    [[ ! -e "$orphan" ]] ||
      printf 'left in place, unprovable without the account that carried the witness: %s\n' "$orphan"
  done
  exit 0
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

# Reaching here means the account is present and carries the witness.
"$LOGINCTL" disable-linger "$LANE_SERVICE_USER"
"$USERDEL" "$LANE_SERVICE_USER"
for target in ${targets[@]+"${targets[@]}"}; do
  "$RM" -rf -- "$target"
done
"$RM" -f -- "$SU_MARKER_PATH"

printf 'service user de-provisioned: %s\n' "$LANE_SERVICE_USER"
