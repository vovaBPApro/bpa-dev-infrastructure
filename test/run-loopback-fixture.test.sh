#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNNER="$ROOT/test/run-loopback-fixture.sh"
PREFIX='bpa-loopback-fixture-*'

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
snapshot() {
  systemctl list-units --all "$PREFIX" --no-legend --no-pager 2>/dev/null |
    awk '$1 ~ /^bpa-loopback-fixture-[0-9]+-[0-9]+\.service$/ { print $1 }' | sort
}
assert_unchanged() {
  local before="$1" after
  after="$(snapshot)"
  [[ "$after" == "$before" ]] || fail "fixture residue changed before=[$before] after=[$after]"
}

state="$(systemctl is-system-running 2>/dev/null || true)"
[[ "$state" == running || "$state" == degraded ]] || fail 'real systemd manager unavailable'

before="$(snapshot)"
"$RUNNER" true >/dev/null
assert_unchanged "$before"

if "$RUNNER" bash -c 'exit 23' >/dev/null 2>&1; then fail 'child failure was swallowed'; fi
assert_unchanged "$before"

if timeout --signal=TERM --kill-after=2 0.2 "$RUNNER" sleep 30 >/dev/null 2>&1; then fail 'bounded timeout was swallowed'; fi
assert_unchanged "$before"

"$RUNNER" sleep 30 >/dev/null 2>&1 & runner_pid=$!
sleep 0.2
kill -TERM "$runner_pid"
for _ in {1..50}; do kill -0 "$runner_pid" 2>/dev/null || break; sleep 0.05; done
kill -0 "$runner_pid" 2>/dev/null && fail 'interrupted runner did not terminate'
wait "$runner_pid" 2>/dev/null || true
assert_unchanged "$before"

# An exact-name collision must fail closed without stopping or resetting the
# foreign unit. This locks both ownership checks used by cleanup.
. "$ROOT/test/systemd-unit-cleanup.sh"
foreign="bpa-loopback-fixture-${BASHPID}-${RANDOM}.service"
systemd-run --quiet --unit "$foreign" --description='foreign reuse lock' sleep 30
if systemd_unit_cleanup_owned "$foreign" 'wrong owner marker' >/dev/null 2>&1; then
  fail 'foreign unit cleanup was accepted'
fi
systemctl is-active --quiet "$foreign" || fail 'foreign unit was stopped or reset'
systemctl stop "$foreign"
systemctl reset-failed "$foreign" >/dev/null 2>&1 || true

printf 'loopback fixture terminal paths: PASS (success child-failure bounded-timeout interruption foreign-reuse independent-list-units)\n'
