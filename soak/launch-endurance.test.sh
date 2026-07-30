#!/usr/bin/env bash
# Regression lock for the durable endurance-soak launch boundary.
set -euo pipefail

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
launcher="$root/soak/launch-endurance.sh"
unit="soak-endurance-test-$$"
report="/tmp/soak endurance test $$.md"
fixture=$(mktemp -d "${TMPDIR:-/tmp}/bpa-launch-endurance-test.XXXXXX")
invocations="$fixture/systemd-run.invocations"
trap 'rm -rf -- "$fixture"' EXIT
printf '#!/usr/bin/env bash\nprintf "invoked\\n" >>"$SOAK_TEST_INVOCATIONS"\n' >"$fixture/systemd-run"
printf '#!/usr/bin/env bash\nexit 3\n' >"$fixture/systemctl"
chmod +x "$fixture/systemd-run" "$fixture/systemctl"

output=$(PATH="$fixture:$PATH" SOAK_TEST_INVOCATIONS="$invocations" \
  "$launcher" --dry-run --unit "$unit" --minutes 37 --lanes 6 \
  --round-timeout 123 --report "$report")

assert_contains() {
  local expected=$1
  if [[ "$output" != *"$expected"* ]]; then
    echo "FAIL: emitted command does not contain: $expected" >&2
    echo "$output" >&2
    exit 1
  fi
}

assert_contains 'systemd-run'
assert_contains '--collect'
assert_contains "--unit $unit"
assert_contains 'SOAK_ROUND_TIMEOUT_SECONDS=123'
assert_contains '/bin/bash soak/soak-endurance.sh'
assert_contains '--minutes 37'
assert_contains '--lanes 6'
assert_contains '/tmp/soak\ endurance\ test'
if [[ "$output" == *setsid* ]] || [[ "$output" == *nohup* ]]; then
  echo 'FAIL: emitted command contains a fragile setsid/nohup launch' >&2
  echo "$output" >&2
  exit 1
fi
if [ -e "$invocations" ]; then
  echo 'FAIL: dry-run invoked systemd-run' >&2
  exit 1
fi

env_output=$(PATH="$fixture:$PATH" SOAK_TEST_INVOCATIONS="$invocations" \
  SOAK_LAUNCH_DRY_RUN=1 "$launcher" --unit "$unit-env" --rounds 4)
[[ "$env_output" == *"--unit $unit-env"* ]]
[[ "$env_output" == *"--rounds 4"* ]]
[ ! -e "$invocations" ]

echo 'PASS: durable endurance launcher dry-run'
