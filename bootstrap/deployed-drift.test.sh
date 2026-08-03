#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHECK="$ROOT/bootstrap/check-deployed-drift.sh"
INDEPENDENT_CALLER="$ROOT/bootstrap/units/bpa-meteorite.service.in"
INSTALLER="$ROOT/bootstrap/install.sh"
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

# Pin the runtime call edge outside the guard's own service and timer.  The
# meteorite service is scheduled independently and runs this probe before its
# rebuild.  A direct fixture invocation alone is not evidence of that edge.
grep -Fq 'ExecStartPre=${INSTALL_ROOT}/bootstrap/check-deployed-drift.sh' "$INDEPENDENT_CALLER"
grep -Fq 'ExecStart=${BASH_BIN} ${INSTALL_ROOT}/meteorite/run.sh' "$INDEPENDENT_CALLER"

# The witness chain terminates at bootstrap: the tracked installer asks systemd
# to persistently schedule the independent caller. These executable source locks
# stay red if either activation itself or its main-path invocation is removed.
grep -Fq 'systemctl enable --now bpa-meteorite.timer' "$INSTALLER"
grep -Fq '  arm_meteorite_witness' "$INSTALLER"
systemctl_calls="$TMP/systemctl.calls"
systemctl() { printf '%s\n' "$*" >> "$systemctl_calls"; }
BOOTSTRAP_LIB_ONLY=true source "$INSTALLER"
arm_meteorite_witness
grep -Fxq 'daemon-reload' "$systemctl_calls"
grep -Fxq 'enable --now bpa-meteorite.timer' "$systemctl_calls"
printf 'container-fixture witness-arming: bootstrap/install.sh -> %s\n' "$(tr '\n' ';' <"$systemctl_calls")"

# Removing a deployed unit is surfaced by the file-drift boundary.
if UNIT_CHECK_EXIT=1 run_check >"$TMP/out" 2>"$TMP/err"; then
  echo 'FAIL: missing deployed unit was accepted' >&2; exit 1
fi
grep -q 'deployed unit files differ from the independent manifest' "$TMP/err"
printf 'container-fixture missing-unit: %s\n' "$(<"$TMP/err")"

# Execute the probe as bpa-meteorite.service's pinned ExecStartPre would.  The
# guard's own service and timer are deliberately not involved in this call.
if TIMER_ENABLED_EXIT=1 TIMER_ACTIVE_EXIT=1 run_check >"$TMP/out" 2>"$TMP/err"; then
  echo 'FAIL: unarmed drift guard was accepted' >&2; exit 1
fi
grep -q 'guard arming absent: bpa-deploy-drift-guard.timer is not enabled' "$TMP/err"
grep -q 'guard arming absent: bpa-deploy-drift-guard.timer is not active' "$TMP/err"
printf 'independent-caller=bpa-meteorite.service/ExecStartPre removed-arming: %s\n' "$(tr '\n' ' ' <"$TMP/err")"

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

printf 'deployed drift, meteorite caller, independent arming, coupled-deletion, and fail-closed locks: PASS\n'
