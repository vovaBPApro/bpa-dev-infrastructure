#!/usr/bin/env bash
set -euo pipefail

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
test_root=$(mktemp -d "${TMPDIR:-/tmp}/bpa-endurance-disk-threshold.XXXXXX")
trap 'rm -rf -- "$test_root"' EXIT

cat >"$test_root/round" <<'EOF'
#!/bin/sh
echo 'overall: PASS'
EOF
cat >"$test_root/zero-probe" <<'EOF'
#!/bin/sh
echo 0
EOF
cat >"$test_root/disk-probe" <<'EOF'
#!/bin/sh
sed -n '1p' "$SOAK_DISK_VALUES"
sed -i '1d' "$SOAK_DISK_VALUES"
EOF
chmod +x "$test_root/round" "$test_root/zero-probe" "$test_root/disk-probe"

run_case() {
  local values=$1 report=$2
  SOAK_ROUND_COMMAND="$test_root/round" SOAK_DOCKER_PROBE=/bin/true \
    SOAK_EXTERNAL_PROBE=/bin/true SOAK_DISK_PROBE="$test_root/disk-probe" \
    SOAK_DISK_VALUES="$values" SOAK_RSS_PROBE="$test_root/zero-probe" \
    SOAK_LEASE_PROBE="$test_root/zero-probe" SOAK_DISK_LEAK_MIN_KB=100 \
    bash "$root/soak/soak-endurance.sh" --rounds 3 --lanes 6 --report "$report" >/dev/null 2>&1
}

noise_values="$test_root/noise-values"
printf '%s\n' 1000000 1000000 999990 999990 999980 999980 999970 >"$noise_values"
noise_report="$test_root/noise-report"
run_case "$noise_values" "$noise_report"
grep -Fq 'overall: PASS' "$noise_report"
if grep -Fq 'leak: disk:' "$noise_report"; then
  echo 'sub-threshold disk noise was reported as a leak' >&2
  exit 1
fi

leak_values="$test_root/leak-values"
printf '%s\n' 1000000 1000000 999940 999940 999880 999880 999820 >"$leak_values"
leak_report="$test_root/leak-report"
set +e
run_case "$leak_values" "$leak_report"
leak_status=$?
set -e
[ "$leak_status" -ne 0 ]
grep -Fq 'first-failure: 2 (disk free space decreased materially for two rounds' "$leak_report"
grep -Fq 'leak: disk:free_kb=1000000->999880 decrease_kb=120 threshold_kb=100' "$leak_report"
grep -Fq 'overall: FAIL' "$leak_report"

echo 'soak endurance disk threshold: PASS'
