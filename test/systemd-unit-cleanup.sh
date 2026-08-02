#!/usr/bin/env bash

# Exact-unit cleanup for disposable fixtures. Callers must give every unit a
# unique marker and install that marker as the unit Description.
systemd_unit_is_owned() {
  local unit="$1" marker="$2" description
  if [[ "$marker" == fragment:* ]]; then
    description="$(systemctl show "$unit" --property=FragmentPath --value 2>/dev/null || true)"
    [[ "$description" == "${marker#fragment:}" ]]
    return
  fi
  description="$(systemctl show "$unit" --property=Description --value 2>/dev/null || true)"
  [[ "$description" == "$marker" ]]
}

systemd_unit_enumerate() {
  local unit="$1"
  systemctl list-units --all "$unit" --no-legend --no-pager 2>/dev/null |
    awk -v exact="$unit" '$1 == exact { print }'
}

systemd_unit_assert_absent() {
  local unit="$1" rows
  rows="$(systemd_unit_enumerate "$unit")"
  [[ -z "$rows" ]] || {
    printf 'FAIL: manager retains unit=%s state=%s\n' "$unit" "$(printf '%s' "$rows" | tr '\n' ' ')" >&2
    return 1
  }
}

systemd_unit_cleanup_owned() {
  local unit="$1" marker="$2" fragment="${3:-}"

  if systemd_unit_is_owned "$unit" "$marker"; then
    systemctl stop "$unit" >/dev/null 2>&1 || true
    # Reset while ownership is still measurable. Never reset a missing or
    # reused name after its owned fragment has disappeared.
    systemctl reset-failed "$unit" >/dev/null 2>&1 || true
  elif [[ -n "$(systemd_unit_enumerate "$unit")" ]]; then
    printf 'FAIL: refusing cleanup of foreign/reused unit=%s\n' "$unit" >&2
    return 1
  fi

  if [[ -n "$fragment" ]]; then
    rm -f -- "$fragment"
    systemctl daemon-reload >/dev/null 2>&1 || return 1
  fi

  for _ in {1..50}; do
    systemd_unit_assert_absent "$unit" && return 0
    sleep 0.02
  done
  systemd_unit_assert_absent "$unit"
}
