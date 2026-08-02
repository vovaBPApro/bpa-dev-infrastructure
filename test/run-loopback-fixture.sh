#!/usr/bin/env bash
set -euo pipefail

[[ "$#" -gt 0 ]] || { printf 'usage: %s command [args...]\n' "$0" >&2; exit 2; }
[[ "${BPA_LOOPBACK_FIXTURE:-0}" != 1 ]] || exec "$@"

token="${BASHPID}-${RANDOM}"
unit="bpa-loopback-fixture-${token}.service"
cleaned=0

cleanup() {
  systemctl stop "$unit" >/dev/null 2>&1 || true
  systemctl reset-failed "$unit" >/dev/null 2>&1 || true
  for _ in {1..50}; do
    [[ "$(systemctl show "$unit" --property=LoadState --value 2>/dev/null || true)" == not-found ]] && break
    sleep 0.02
  done
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
[[ "$(systemctl show "$unit" --property=LoadState --value 2>/dev/null || true)" == not-found ]] || {
  printf 'FAIL: residual loopback fixture unit=%s\n' "$unit" >&2
  exit 1
}
printf 'loopback fixture resources: PASS unit=%s residuals=0\n' "$unit"
exit "$status"
