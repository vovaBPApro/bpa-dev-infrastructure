#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHECK="$ROOT/bootstrap/check-deployed-drift.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"

cp "$ROOT/instance/expected-units.tsv" "$TMP/expected-units.tsv"
printf '#!/usr/bin/env bash\nexit "${UNIT_CHECK_EXIT:-0}"\n' > "$TMP/unit-check"
printf '%s\n' '#!/usr/bin/env bash' \
  'case "$*" in' \
  '  show-environment) exit "${SYSTEMD_PROBE_EXIT:-0}" ;;' \
  '  "is-enabled --quiet bpa-deploy-drift-guard.timer") exit "${TIMER_ENABLED_EXIT:-0}" ;;' \
  '  "is-active --quiet bpa-deploy-drift-guard.timer") exit "${TIMER_ACTIVE_EXIT:-0}" ;;' \
  '  *) exit 99 ;;' \
  'esac' > "$TMP/bin/systemctl"
chmod +x "$TMP/unit-check" "$TMP/bin/systemctl"

run_check() {
  env PATH="$TMP/bin:$PATH" MANIFEST_FILE="${MANIFEST_FILE:-$TMP/expected-units.tsv}" \
    UNIT_DRIFT_CHECK="$TMP/unit-check" SYSTEMCTL_BIN=systemctl \
    DEPLOY_DRIFT_NOTIFY_URL= "$CHECK" "$@"
}

run_check | grep -q 'DEPLOY-DRIFT CLEAN'

# Removing a deployed unit is surfaced by the file-drift boundary.
if UNIT_CHECK_EXIT=1 run_check >"$TMP/out" 2>"$TMP/err"; then
  echo 'FAIL: missing deployed unit was accepted' >&2; exit 1
fi
grep -q 'deployed unit files differ from the independent manifest' "$TMP/err"
printf 'container-fixture missing-unit: %s\n' "$(<"$TMP/err")"

# The independent caller catches removal of the guard's own arming.
if TIMER_ENABLED_EXIT=1 TIMER_ACTIVE_EXIT=1 run_check >"$TMP/out" 2>"$TMP/err"; then
  echo 'FAIL: unarmed drift guard was accepted' >&2; exit 1
fi
grep -q 'guard arming absent: bpa-deploy-drift-guard.timer is not enabled' "$TMP/err"
grep -q 'guard arming absent: bpa-deploy-drift-guard.timer is not active' "$TMP/err"
printf 'container-fixture removed-arming: %s\n' "$(tr '\n' ' ' <"$TMP/err")"

# Delete the guard from both simulated host state and the manifest. The fixed
# code anchor must still name it, rather than accepting two coupled deletions.
sed -i '/^bpa-deploy-drift-guard\.service\t/d;/^bpa-deploy-drift-guard\.timer\t/d' "$TMP/expected-units.tsv"
if UNIT_CHECK_EXIT=1 run_check >"$TMP/out" 2>"$TMP/err"; then
  echo 'FAIL: coupled host+manifest deletion was accepted' >&2; exit 1
fi
grep -q 'independent anchor missing required manifest unit: bpa-deploy-drift-guard.service' "$TMP/err"
printf 'container-fixture coupled-deletion: %s\n' "$(<"$TMP/err")"
cp "$ROOT/instance/expected-units.tsv" "$TMP/expected-units.tsv"

mkdir "$TMP/unreadable-manifest"
if MANIFEST_FILE="$TMP/unreadable-manifest" run_check >"$TMP/out" 2>"$TMP/err"; then
  echo 'FAIL: unreadable manifest was accepted' >&2; exit 1
fi
grep -q 'expected-units manifest unreadable' "$TMP/err"

if SYSTEMD_PROBE_EXIT=124 run_check >"$TMP/out" 2>"$TMP/err"; then
  echo 'FAIL: unreachable systemd was accepted' >&2; exit 1
fi
grep -q 'systemd unreachable or timed out' "$TMP/err"

printf 'deployed drift, independent arming, coupled-deletion, and fail-closed locks: PASS\n'
