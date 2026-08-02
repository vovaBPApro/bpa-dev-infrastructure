#!/usr/bin/env bash
set -euo pipefail

[[ "$#" -gt 0 ]] || { printf 'usage: %s command [args...]\n' "$0" >&2; exit 2; }
[[ "${BPA_LOOPBACK_FIXTURE:-0}" != 1 ]] || exec "$@"

token="${BASHPID}-${RANDOM}"
unit="bpa-loopback-fixture-${token}.service"
marker="BPA loopback fixture ${token}"
cleaned=0
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/systemd-unit-cleanup.sh"

cleanup() {
  systemd_unit_cleanup_owned "$unit" "$marker" || return 1
  cleaned=1
}
trap cleanup EXIT

state="$(systemctl is-system-running 2>/dev/null || true)"
[[ "$state" == running || "$state" == degraded ]] || {
  printf 'NO-GO: real systemd manager unavailable for isolated loopback fixture\n' >&2
  exit 1
}

status=0
systemd-run --quiet --wait --pipe --collect --unit "$unit" \
  --description="$marker" \
  --property=Type=exec \
  --property=PrivateNetwork=no \
  --property=IPAddressAllow=localhost \
  --working-directory "$PWD" \
  --setenv=BPA_LOOPBACK_FIXTURE=1 \
  --setenv=PATH="$PATH" \
  --setenv=HOME="${HOME:?}" \
  --setenv=TMPDIR="${TMPDIR:-/tmp}" \
  -- "$@" || status=$?

cleanup
trap - EXIT
[[ "$cleaned" == 1 ]] || { printf 'FAIL: loopback fixture cleanup did not run\n' >&2; exit 1; }
systemd_unit_assert_absent "$unit"
printf 'loopback fixture resources: PASS unit=%s residuals=0\n' "$unit"
exit "$status"
