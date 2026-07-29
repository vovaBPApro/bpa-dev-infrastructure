#!/usr/bin/env bash
set -euo pipefail

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
test_root=$(mktemp -d "${TMPDIR:-/tmp}/bpa-endurance-resource-lock.XXXXXX")
cleanup() {
  if [ -f "$test_root/leaked.pid" ]; then kill "$(cat "$test_root/leaked.pid")" 2>/dev/null || true; fi
  rm -rf -- "$test_root"
}
trap cleanup EXIT

fakebin="$test_root/bin"
mkdir -p "$fakebin" "$test_root/external"
cat >"$fakebin/bash" <<EOF
#!/bin/sh
if [ "\${1:-}" = "$root/soak/soak.sh" ]; then
  echo 'overall: PASS'
  exit 0
fi
exec /bin/bash "\$@"
EOF
chmod +x "$fakebin/bash"

cat >"$test_root/round" <<'EOF'
#!/bin/sh
mkdir -p "$SOAK_SANDBOX_ROOT/not-bpa-soak"
mkfifo "$SOAK_SANDBOX_ROOT/leaked.fifo"
: >"$SOAK_EXTERNAL_ROOT/token-file"
setsid env SOAK_RUN_TOKEN="$SOAK_RUN_TOKEN" sleep 60 &
echo "$!" >"$SOAK_TEST_ROOT/leaked.pid"
echo 'overall: PASS'
EOF
chmod +x "$test_root/round"

cat >"$test_root/docker-probe" <<'EOF'
#!/bin/sh
[ "$SOAK_PROBE_PHASE" = before ] || printf '%s\n' \
  'container ctr-added' 'image img-added' 'volume vol-added' 'network net-added'
EOF
cat >"$test_root/external-probe" <<'EOF'
#!/bin/sh
find "$SOAK_EXTERNAL_ROOT" -mindepth 1 -printf '%y %p\n' 2>/dev/null || true
EOF
cat >"$test_root/lease-probe" <<'EOF'
#!/bin/sh
echo 7
EOF
cat >"$test_root/rss-probe" <<'EOF'
#!/bin/sh
echo 321
EOF
chmod +x "$test_root/"*-probe

disk_values="$test_root/disk-values"
printf '%s\n' 100000 99900 99800 99700 >"$disk_values"
cat >"$test_root/disk-probe" <<'EOF'
#!/bin/sh
sed -n '1p' "$SOAK_DISK_VALUES"
sed -i '1d' "$SOAK_DISK_VALUES"
EOF
chmod +x "$test_root/disk-probe"

report="$test_root/report"
set +e
PATH="$fakebin:$PATH" SOAK_TEST_ROOT="$test_root" SOAK_EXTERNAL_ROOT="$test_root/external" \
  SOAK_ROUND_COMMAND="$test_root/round" SOAK_DOCKER_PROBE="$test_root/docker-probe" \
  SOAK_EXTERNAL_PROBE="$test_root/external-probe" SOAK_DISK_PROBE="$test_root/disk-probe" \
  SOAK_DISK_VALUES="$disk_values" SOAK_RSS_PROBE="$test_root/rss-probe" \
  SOAK_LEASE_PROBE="$test_root/lease-probe" SOAK_DISK_TOLERANCE_KB=50 \
  bash "$root/soak/soak-endurance.sh" --rounds 3 --lanes 6 --report "$report" >"$test_root/output" 2>&1
status=$?
set -e

[ "$status" -ne 0 ]
for expected in \
  'container:ctr-added' 'image:img-added' 'volume:vol-added' 'network:net-added' \
  'not-bpa-soak' 'leaked.fifo' 'token-file' 'rss_kb=321' 'active_leases=7'
do
  grep -Fq "$expected" "$report"
done
grep -Eq 'process:[0-9]+' "$report"
grep -Fq 'overall: FAIL' "$report"

cat >"$test_root/clean-round" <<'EOF'
#!/bin/sh
echo 'overall: PASS'
EOF
cat >"$test_root/zero-probe" <<'EOF'
#!/bin/sh
echo 0
EOF
chmod +x "$test_root/clean-round" "$test_root/zero-probe"
printf '%s\n' 100000 99900 99800 99700 >"$disk_values"
disk_report="$test_root/disk-report"
set +e
SOAK_ROUND_COMMAND="$test_root/clean-round" SOAK_DOCKER_PROBE=/bin/true \
  SOAK_EXTERNAL_PROBE=/bin/true SOAK_DISK_PROBE="$test_root/disk-probe" \
  SOAK_DISK_VALUES="$disk_values" SOAK_RSS_PROBE="$test_root/zero-probe" \
  SOAK_LEASE_PROBE="$test_root/zero-probe" SOAK_DISK_TOLERANCE_KB=50 \
  bash "$root/soak/soak-endurance.sh" --rounds 3 --lanes 6 --report "$disk_report" >/dev/null 2>&1
disk_status=$?
set -e
[ "$disk_status" -ne 0 ]
grep -Fq 'first-failure: 1 (disk aggregate drift' "$disk_report"
grep -Fq 'disk_free_kb=100000->99800' "$disk_report"
grep -Fq 'overall: FAIL' "$disk_report"
echo 'soak endurance resource lock: PASS'
