#!/usr/bin/env bash
set -euo pipefail

# Bootstrap must work under systemd/cron, whose PATH need not contain sbin.
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

SU_TOOL=provision-service-user
# shellcheck source=bootstrap/service-user-lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/service-user-lib.sh"
die() { su_die "$@"; }

adopt_legacy=no
case "${1:-}" in
  --adopt-legacy-marker|--adopt-existing-account) adopt_legacy=yes; shift ;;
esac
[[ $# -le 1 ]] || die 'usage: provision-service-user.sh [--adopt-existing-account] [config]'
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
su_need od SU_OD
su_need tr SU_TR

su_state_paths
# Trust before mutation. `install -d` follows a symlink, so running it first
# chowns and chmods whatever the state root points at and only then rejects it.
# Anything already present is validated before it is touched; only a genuinely
# absent path is created, and the result is validated too.
if [[ -e "$SU_STATE_ROOT" || -L "$SU_STATE_ROOT" ]]; then
  su_require_trusted_state_root
else
  "$INSTALL" -d -m 0700 -o root -g root "$SU_STATE_ROOT"
  su_require_trusted_state_root
fi

# Pick the lowest free UID in the login.defs range, the same policy useradd
# applies when it chooses for itself. Reserving the UID here rather than
# letting useradd pick is what lets the marker be complete BEFORE the account
# exists — see the creation sequence below. If getent cannot enumerate every
# account (a network directory, say) the reservation can collide, and useradd
# then fails loudly rather than silently reusing an occupied UID.
#
# Because this deliberately mirrors useradd's own policy, the reserved UID is
# reproduced by any later plain `useradd` of the same name. It is therefore a
# PREDICTION and never authority: what authorises deletion is the witness this
# script hands to useradd and then reads back off the created account.
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
  [[ "$marker_version" == 1 || "$marker_version" == 2 || "$marker_version" == 3 ]] ||
    die "unsupported creation marker version: $marker_version"
fi

created_user=no
if [[ "$account_exists" == yes ]]; then
  [[ "$marker_present" == yes ]] ||
    die "user already exists but was not created by this provisioner: $LANE_SERVICE_USER"
  account_uid="$(su_passwd_field "$LANE_SERVICE_USER" uid)"

  # Does the account that is live RIGHT NOW carry the witness this marker
  # recorded? That is the only question whose answer is an observation. A v1 or
  # v2 marker cannot even be asked it, because neither format has a witness.
  witness_holds=no
  if [[ "$marker_version" == 3 ]]; then
    su_require_witness_syntax "${SU_MARKER[witness]:-}"
    if su_account_carries_witness "$LANE_SERVICE_USER" "${SU_MARKER[witness]}"; then
      witness_holds=yes
    fi
  fi

  if [[ "$witness_holds" == yes ]]; then
    [[ "${SU_MARKER[uid]:-}" == "$account_uid" ]] ||
      die "creation marker was written for uid ${SU_MARKER[uid]:-none} but $LANE_SERVICE_USER is uid $account_uid"
    if [[ "${SU_MARKER[state]:-}" == creating ]]; then
      # Resume, and note what makes it safe: the account carries the witness
      # generated for THIS marker and handed to THIS marker's useradd, so the
      # interrupted run really is the one that created it. Completing the
      # record asserts nothing that was not read back out of passwd. Round 2
      # completed it on a UID match alone, which any plain useradd reproduces.
      su_write_marker "$(su_marker_content created "$account_uid" "${SU_MARKER[witness]}" \
        "${SU_MARKER[created_repo]:-no}" "${SU_MARKER[created_worktrees]:-no}" \
        "${SU_MARKER[created_at]:-unknown}" \
        "home_id=$("$SU_STAT" -c %d:%i "$LANE_SERVICE_HOME")")"
      printf 'resumed an interrupted provisioning; witness verified on uid %s: %s\n' \
        "$account_uid" "$LANE_SERVICE_USER"
    fi
  elif [[ "$adopt_legacy" == yes ]]; then
    # Adoption is the operator asserting what this script cannot observe: that
    # the account holding this name is the one the marker meant. The assertion
    # is made real by stamping a fresh witness onto the account and reading it
    # back, so every later run rests on an observation again — and it is
    # recorded as `adopted=yes`, so a reader can see an operator, not this
    # script, supplied the identity.
    su_need usermod USERMOD
    adopt_witness="$(su_new_witness)"
    "$USERMOD" --comment \
      "$(su_gecos_with_witness "$(su_passwd_field "$LANE_SERVICE_USER" gecos)" "$adopt_witness")" \
      "$LANE_SERVICE_USER"
    su_account_carries_witness "$LANE_SERVICE_USER" "$adopt_witness" ||
      die "could not stamp the provisioning witness onto $LANE_SERVICE_USER; refusing to record authority that cannot be re-checked"
    su_write_marker "$(su_marker_content created "$account_uid" "$adopt_witness" \
      "${SU_MARKER[created_repo]:-no}" "${SU_MARKER[created_worktrees]:-no}" \
      "${SU_MARKER[created_at]:-unknown}" \
      "home_id=$("$SU_STAT" -c %d:%i "$LANE_SERVICE_HOME")" \
      "adopted=yes" "adopted_at=$("$SU_DATE" -u +%s)")"
    printf 'creation marker adopted by operator assertion and bound to uid %s by witness: %s\n' \
      "$account_uid" "$LANE_SERVICE_USER"
  elif [[ "$marker_version" == 3 ]]; then
    # THE round-2 defect, refused. The marker predicted this name, this home and
    # (via the mirrored allocation policy) this UID, so all three match an
    # account it never created. The witness does not, and the witness is the
    # only field that was ever observed. Refuse, name the record, and say what
    # to do — a stale record must never be resolved silently in either
    # direction.
    die "refusing to bind: $LANE_SERVICE_USER (uid $account_uid) does not carry the provisioning witness recorded in $SU_MARKER_PATH, so this provisioner did not create it (marker records state=${SU_MARKER[state]:-none} for uid ${SU_MARKER[uid]:-none}); clear the stale record with 'deprovision-service-user.sh --forget-record $config', or take ownership of the existing account with '--adopt-existing-account'"
  else
    # v1 and v2 markers bind a name, or a name plus a predicted UID. Neither can
    # prove which account it was written for, so neither is silently upgraded.
    die "creation marker version $marker_version predates witness binding and cannot prove it created $LANE_SERVICE_USER (uid $account_uid): $SU_MARKER_PATH; re-run with --adopt-existing-account to bind it to that account, or clear it with 'deprovision-service-user.sh --forget-record $config'"
  fi
else
  [[ ! -e "$LANE_SERVICE_HOME" ]] ||
    die "refusing unowned home directory: $LANE_SERVICE_HOME"
  if [[ "$marker_present" == yes ]]; then
    [[ "$marker_version" == 3 && "${SU_MARKER[state]:-}" == creating ]] ||
      die "creation marker records an account that no longer exists: $SU_MARKER_PATH; run 'deprovision-service-user.sh --forget-record $config' to clear it first"
    reserved_uid="${SU_MARKER[uid]:-}"
    [[ "$reserved_uid" =~ ^[0-9]+$ ]] || die "creation marker reserves no usable uid: $SU_MARKER_PATH"
    # Reuse the reserved witness, not a fresh one: the reservation and the
    # account it finally creates have to be the same claim.
    witness="${SU_MARKER[witness]:-}"
    su_require_witness_syntax "$witness"
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
    witness="$(su_new_witness)"
    # The marker is written BEFORE useradd, carrying the witness that useradd is
    # then told to stamp on the account. That is what removes the pre-marker
    # window: there is no instant at which an account exists and no record
    # claims it. What it deliberately does NOT do is authorise anything — this
    # record is `state=creating`, and until the witness is read back off a live
    # account it grants no deletion at all. Round 2 wrote the same record and
    # treated it as a grant, which is how a stranger's account got deleted.
    su_write_marker "$(su_marker_content creating "$reserved_uid" "$witness" \
      "$created_repo" "$created_worktrees" "$created_at")"
  fi
  "$USERADD" --uid "$reserved_uid" --comment "$(su_witness_token "$witness")" \
    --create-home --home-dir "$LANE_SERVICE_HOME" \
    --shell /bin/bash "$LANE_SERVICE_USER"
  # The observation. Everything above this line was chosen by this script;
  # everything below rests on what the passwd database actually says.
  account_uid="$(su_passwd_field "$LANE_SERVICE_USER" uid)"
  [[ "$account_uid" == "$reserved_uid" ]] ||
    die "useradd created $LANE_SERVICE_USER as uid $account_uid, not the reserved uid $reserved_uid"
  su_account_carries_witness "$LANE_SERVICE_USER" "$witness" ||
    die "useradd did not record the provisioning witness on $LANE_SERVICE_USER; refusing to claim an account this provisioner cannot identify later"
  su_write_marker "$(su_marker_content created "$account_uid" "$witness" \
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
