#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALLER="$SCRIPT_DIR/install.sh"

# shellcheck disable=SC2016 # inspect the literal default assignment
grep -Fxq 'INSTALL_ROOT="${INSTALL_ROOT:-/root/bpa-dev-infrastructure}"' "$INSTALLER"
grep -Fxq 'TimeoutSec=3600' "$SCRIPT_DIR/units/bpa-full-suite.service.in"

dry_run="$($INSTALLER --dry-run)"
for expected in \
  'PLAN apt' \
  'PLAN bun' \
  'PLAN repository' \
  'PLAN environment' \
  'PLAN state-db' \
  'PLAN workspace' \
  'PLAN hygiene' \
  'PLAN test-gate' \
  'PLAN units' \
  'PLAN activate'; do
  grep -Fq "$expected" <<<"$dry_run"
done

verify_fixture="$(mktemp -d)"
trap 'rm -rf "$verify_fixture"' EXIT
install -d -m 700 \
  "$verify_fixture/root/.git" \
  "$verify_fixture/root/core" \
  "$verify_fixture/root/daemon" \
  "$verify_fixture/root/deploy" \
  "$verify_fixture/root/orchestrator" \
  "$verify_fixture/root/workspace" \
  "$verify_fixture/root/gate" \
  "$verify_fixture/root/bootstrap" \
  "$verify_fixture/root/runtime" \
  "$verify_fixture/systemd/system" \
  "$verify_fixture/bin" \
  "$verify_fixture/opt/whisper.cpp/bin"
install -m 600 /dev/null "$verify_fixture/root/.env"
printf '%s\n' 'TELEGRAM_BOT_TOKEN=fixture-token' > "$verify_fixture/root/.env"
printf '%s\n' \
  '[Service]' \
  "ExecStart=$verify_fixture/bin/bun run server.ts" > "$verify_fixture/systemd/system/bpa-telegram-daemon.service"
printf '%s\n' '[Service]' "ExecStart=$verify_fixture/root/orchestrator/launch.sh start" > "$verify_fixture/systemd/system/bpa-orchestrator.service"
printf '%s\n' \
  '[Service]' \
  "ExecStart=$verify_fixture/root/orchestrator/watchdog.sh" > "$verify_fixture/systemd/system/bpa-orchestrator-watchdog.service"
printf '%s\n' '[Timer]' > "$verify_fixture/systemd/system/bpa-orchestrator-watchdog.timer"
printf '%s\n' \
  '[Service]' \
  "ExecStart=$verify_fixture/root/orchestrator/full-suite.sh" > "$verify_fixture/systemd/system/bpa-full-suite.service"
printf '%s\n' '[Timer]' > "$verify_fixture/systemd/system/bpa-full-suite.timer"
printf '%s\n' \
  '[Service]' \
  "ExecStart=$verify_fixture/root/orchestrator/morning.sh" > "$verify_fixture/systemd/system/orch-morning-report.service"
printf '%s\n' '[Timer]' > "$verify_fixture/systemd/system/orch-morning-report.timer"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$verify_fixture/bin/bun"
printf '%s\n' '#!/usr/bin/env bash' 'exit 1' > "$verify_fixture/bin/systemctl"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$verify_fixture/root/workspace/workspace.sh"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$verify_fixture/root/orchestrator/watchdog.sh"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$verify_fixture/root/orchestrator/full-suite.sh"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$verify_fixture/root/orchestrator/morning.sh"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$verify_fixture/root/orchestrator/launch.sh"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$verify_fixture/root/bootstrap/check-deployed-drift.sh"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$verify_fixture/root/deploy/check-live-stand-staleness.sh"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$verify_fixture/opt/whisper.cpp/bin/whisper-cli"
printf '%s\n' 'disabled by --no-cron' > "$verify_fixture/root/runtime/hygiene-cron.skip"
for command_name in git curl tmux docker codex claude; do
  printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$verify_fixture/bin/$command_name"
done
chmod 700 "$verify_fixture/bin"/*
chmod 700 "$verify_fixture/root/workspace/workspace.sh"
chmod 700 "$verify_fixture/root/orchestrator/watchdog.sh" "$verify_fixture/root/orchestrator/full-suite.sh" "$verify_fixture/root/orchestrator/morning.sh"
chmod 700 "$verify_fixture/root/orchestrator/launch.sh" "$verify_fixture/opt/whisper.cpp/bin/whisper-cli"
chmod 700 "$verify_fixture/root/bootstrap/check-deployed-drift.sh"
chmod 700 "$verify_fixture/root/deploy/check-live-stand-staleness.sh"
INSTALL_ROOT="$verify_fixture/root" \
  ENV_FILE="$verify_fixture/root/.env" \
  BUN_BIN="$verify_fixture/bin/bun" \
  FULL_SUITE_ON_CALENDAR='*-*-* 03:30:00' \
  ORCH_WATCHDOG_INTERVAL=60 \
  envsubst < /dev/null >/dev/null
render_fixture_unit() {
  local unit_template="$1" unit_name
  unit_name="$(basename "${unit_template%.in}")"
  INSTALL_ROOT="$verify_fixture/root" \
    ENV_FILE="$verify_fixture/root/.env" \
    BUN_BIN="$verify_fixture/bin/bun" \
    BASH_BIN="/usr/bin/bash" \
    FULL_SUITE_ON_CALENDAR='*-*-* 03:30:00' \
    ORCH_WATCHDOG_INTERVAL=60 \
    envsubst < "$unit_template" > "$verify_fixture/systemd/system/$unit_name"
}
for unit_template in "$SCRIPT_DIR"/units/*.in; do
  render_fixture_unit "$unit_template"
done
verify_output="$(PATH="$verify_fixture/bin:$PATH" \
  INSTALL_ROOT="$verify_fixture/root" \
  ENV_FILE="$verify_fixture/root/.env" \
  SYSTEMD_SYSTEM_DIR="$verify_fixture/systemd/system" \
  WHISPER_BIN="$verify_fixture/opt/whisper.cpp/bin/whisper-cli" \
  BUN_BIN="$verify_fixture/bin/bun" \
  "$INSTALLER" --verify-source)"
grep -Fq 'SKIP system systemd' <<<"$verify_output"
for expected in \
  'PASS state-db' \
  'PASS workspace' \
  'SKIP hygiene-cron' \
  'PASS gate' \
  'PASS morning service' \
  'PASS morning timer' \
  'PASS deploy drift service' \
  'PASS deploy drift timer' \
  'PASS stand staleness service' \
  'PASS stand staleness timer' \
  'PASS stand verifier service' \
  'PASS unit Exec paths' \
  'PASS deployed unit drift'; do
  grep -Fq "$expected" <<<"$verify_output"
done
grep -Fq 'PASS docker' <<<"$verify_output"

# Regression lock for meteorite gap 1: the same incomplete activation boundary
# may be inspected in explicitly limited source mode, but production verify
# must be red. Before this fix `--verify` returned zero with these SKIP rows.
if strict_output="$(PATH="$verify_fixture/bin:$PATH" \
  INSTALL_ROOT="$verify_fixture/root" \
  ENV_FILE="$verify_fixture/root/.env" \
  SYSTEMD_SYSTEM_DIR="$verify_fixture/systemd/system" \
  WHISPER_BIN="$verify_fixture/opt/whisper.cpp/bin/whisper-cli" \
  BUN_BIN="$verify_fixture/bin/bun" \
  "$INSTALLER" --verify 2>&1)"; then
  echo 'ERROR: production verify accepted an unavailable system manager' >&2
  exit 1
fi
grep -Fq 'FAIL system systemd' <<<"$strict_output"
printf '%s\n' 'FAIL-BEFORE meteorite gap 1: production verify accepted activation SKIPs'
grep '^FAIL system systemd' <<<"$strict_output"

# Keep this regression fixture self-contained: Actions checks out depth one, so
# the historical pre-fix commit is intentionally unavailable in CI.
old_watchdog_exec="\$INSTALL_ROOT/daemon/orchestrator-watchdog.sh"
expected_old_watchdog_exec="\$INSTALL_ROOT/daemon/orchestrator-watchdog.sh"
[[ "$old_watchdog_exec" == "$expected_old_watchdog_exec" ]]
old_watchdog_exec="${old_watchdog_exec/\$INSTALL_ROOT/$verify_fixture/root}"
printf '%s\n' \
  '[Service]' \
  "ExecStart=$old_watchdog_exec" > "$verify_fixture/systemd/system/bpa-orchestrator-watchdog.service"
if broken_output="$(PATH="$verify_fixture/bin:$PATH" \
  INSTALL_ROOT="$verify_fixture/root" \
  ENV_FILE="$verify_fixture/root/.env" \
  SYSTEMD_SYSTEM_DIR="$verify_fixture/systemd/system" \
  WHISPER_BIN="$verify_fixture/opt/whisper.cpp/bin/whisper-cli" \
  BUN_BIN="$verify_fixture/bin/bun" \
  "$INSTALLER" --verify-source 2>&1)"; then
  echo 'ERROR: verify accepted a unit with a missing ExecStart target' >&2
  exit 1
fi
grep -Fq 'FAIL unit Exec paths' <<<"$broken_output"
printf 'FAIL-BEFORE 148b9ad0 ExecStart=%s\n' "$old_watchdog_exec"
grep '^FAIL unit Exec paths' <<<"$broken_output"
render_fixture_unit "$SCRIPT_DIR/units/bpa-orchestrator-watchdog.service.in"

# A deployed unit that loses a tracked restart boundary must fail the
# byte-for-byte template comparison.
cp "$verify_fixture/systemd/system/bpa-telegram-daemon.service" "$verify_fixture/daemon.unit.good"
sed -i '/^RestartSec=5$/d' \
  "$verify_fixture/systemd/system/bpa-telegram-daemon.service"
if drift_output="$(TEMPLATE_DIR="$SCRIPT_DIR/units" \
  INSTALL_ROOT="$verify_fixture/root" \
  ENV_FILE="$verify_fixture/root/.env" \
  BUN_BIN="$verify_fixture/bin/bun" \
  SYSTEMD_SYSTEM_DIR="$verify_fixture/systemd/system" \
  "$SCRIPT_DIR/check-unit-drift.sh" 2>&1)"; then
  echo 'ERROR: unit drift check accepted a missing daemon restart boundary' >&2
  exit 1
fi
grep -Fq 'DRIFT bpa-telegram-daemon.service' <<<"$drift_output"
grep -Fq -- '+RestartSec=5' <<<"$drift_output"
printf '%s\n' 'FAIL-BEFORE deployed daemon missing RestartSec=5'
mv "$verify_fixture/daemon.unit.good" "$verify_fixture/systemd/system/bpa-telegram-daemon.service"

rm "$verify_fixture/systemd/system/orch-morning-report.timer"
if missing_morning_output="$(PATH="$verify_fixture/bin:$PATH" \
  INSTALL_ROOT="$verify_fixture/root" \
  ENV_FILE="$verify_fixture/root/.env" \
  SYSTEMD_SYSTEM_DIR="$verify_fixture/systemd/system" \
  WHISPER_BIN="$verify_fixture/opt/whisper.cpp/bin/whisper-cli" \
  BUN_BIN="$verify_fixture/bin/bun" \
  "$INSTALLER" --verify-source 2>&1)"; then
  echo 'ERROR: verify accepted a missing morning timer' >&2
  exit 1
fi
grep -Fq 'FAIL morning timer' <<<"$missing_morning_output"
printf '%s\n' 'FAIL-BEFORE missing morning timer'
grep '^FAIL morning timer' <<<"$missing_morning_output"
render_fixture_unit "$SCRIPT_DIR/units/orch-morning-report.timer.in"

# A missing unit is tolerated only through an explicit, evidence-bearing
# exemption. Every other missing unit remains drift.
rm "$verify_fixture/systemd/system/bpa-orchestrator-watchdog.service"
exemptions="$verify_fixture/unit-drift-exemptions.tsv"
printf '%s\t%s\t%s\n' \
  'bpa-orchestrator-watchdog.service' 'deliberately-absent' 'operator-presence-required' > "$exemptions"
exempt_output="$(PATH="$verify_fixture/bin:$PATH" \
  TEMPLATE_DIR="$SCRIPT_DIR/units" \
  SYSTEMD_SYSTEM_DIR="$verify_fixture/systemd/system" \
  INSTALL_ROOT="$verify_fixture/root" \
  ENV_FILE="$verify_fixture/root/.env" \
  BUN_BIN="$verify_fixture/bin/bun" \
  EXEMPTIONS_FILE="$exemptions" \
  "$SCRIPT_DIR/check-unit-drift.sh")"
grep -Fq 'EXEMPT bpa-orchestrator-watchdog.service: deliberately absent (operator-presence-required)' <<<"$exempt_output"
rm "$verify_fixture/systemd/system/bpa-full-suite.service"
if PATH="$verify_fixture/bin:$PATH" \
  TEMPLATE_DIR="$SCRIPT_DIR/units" \
  SYSTEMD_SYSTEM_DIR="$verify_fixture/systemd/system" \
  INSTALL_ROOT="$verify_fixture/root" \
  ENV_FILE="$verify_fixture/root/.env" \
  BUN_BIN="$verify_fixture/bin/bun" \
  EXEMPTIONS_FILE="$exemptions" \
  "$SCRIPT_DIR/check-unit-drift.sh" >/dev/null 2>&1; then
  echo 'ERROR: an undocumented missing unit passed drift verification' >&2
  exit 1
fi
render_fixture_unit "$SCRIPT_DIR/units/bpa-orchestrator-watchdog.service.in"
render_fixture_unit "$SCRIPT_DIR/units/bpa-full-suite.service.in"

empty_templates="$verify_fixture/empty-templates"
mkdir "$empty_templates"
if empty_output="$(TEMPLATE_DIR="$empty_templates" \
  SYSTEMD_SYSTEM_DIR="$verify_fixture/systemd/system" \
  EXEMPTIONS_FILE="$verify_fixture/no-exemptions.tsv" \
  "$SCRIPT_DIR/check-unit-drift.sh" 2>&1)"; then
  echo 'ERROR: an empty template inventory passed drift verification' >&2
  exit 1
fi
grep -Fq 'ERROR: no unit templates found' <<<"$empty_output"
printf '%s\n' 'FAIL-BEFORE empty unit template inventory'

chmod 644 "$verify_fixture/root/.env"
printf '%s\n' 'FAIL-BEFORE loose environment permissions'
[[ "$(stat -c '%a' "$verify_fixture/root/.env")" == 644 ]]
BOOTSTRAP_LIB_ONLY=true \
  ENV_FILE="$verify_fixture/root/.env" \
  INSTALL_ROOT="$verify_fixture/root" \
  INSTALLER_PATH="$INSTALLER" \
  bash -c 'source "$INSTALLER_PATH"; render_environment'
[[ "$(stat -c '%a' "$verify_fixture/root/.env")" == 600 ]]

printf '%s\n' 'fixture-token' > "$verify_fixture/env-target"
ln -s "$verify_fixture/env-target" "$verify_fixture/symlinked.env"
if BOOTSTRAP_LIB_ONLY=true \
  ENV_FILE="$verify_fixture/symlinked.env" \
  INSTALL_ROOT="$verify_fixture/root" \
  INSTALLER_PATH="$INSTALLER" \
  bash -c 'source "$INSTALLER_PATH"; render_environment'; then
  echo 'ERROR: installer accepted a symlinked environment file' >&2
  exit 1
fi
printf '%s\n' 'FAIL-BEFORE symlinked environment file'

printf '%s\n' 'TELEGRAM_BOT_TOKEN=__OPERATOR_PASTE_TELEGRAM_BOT_TOKEN_HERE__' > "$verify_fixture/root/.env"
placeholder_output="$(PATH="$verify_fixture/bin:$PATH" \
  INSTALL_ROOT="$verify_fixture/root" \
  ENV_FILE="$verify_fixture/root/.env" \
  SYSTEMD_SYSTEM_DIR="$verify_fixture/systemd/system" \
  WHISPER_BIN="$verify_fixture/opt/whisper.cpp/bin/whisper-cli" \
  BUN_BIN="$verify_fixture/bin/bun" \
  "$INSTALLER" --verify-source)"
grep -Fq 'SKIP token configured' <<<"$placeholder_output"

# ── Bare install on a token-configured host must NOT arm the watchdog ───────
# Standing deploy ruling: the watchdog timer stays unarmed. At 17ec3e0a
# activate_units treated a configured token as a watchdog opt-in and ran
# `systemctl --user enable --now bpa-orchestrator-watchdog.timer` on every
# rerun of the installer — the exact deploy path. The full install flow runs
# here against a shimmed host: systemctl is a recorder, so nothing on this
# machine is enabled, started, or reloaded for real.
arming_fixture="$(mktemp -d)"
trap 'rm -rf "$verify_fixture" "$arming_fixture"' EXIT
install -d -m 700 \
  "$arming_fixture/root/.git" \
  "$arming_fixture/root/daemon" \
  "$arming_fixture/root/orchestrator" \
  "$arming_fixture/root/core" \
  "$arming_fixture/root/gate" \
  "$arming_fixture/root/workspace" \
  "$arming_fixture/root/hygiene" \
  "$arming_fixture/root/bootstrap" \
  "$arming_fixture/root/deploy" \
  "$arming_fixture/root/runtime" \
  "$arming_fixture/config" \
  "$arming_fixture/bin"
printf '%s\n' 'TELEGRAM_BOT_TOKEN=fixture-token' > "$arming_fixture/root/.env"
chmod 600 "$arming_fixture/root/.env"
for command_name in git curl tmux unzip xz crontab bun docker codex claude; do
  printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$arming_fixture/bin/$command_name"
done
printf '%s\n' '#!/usr/bin/env bash' 'printf "%s\n" "# BEGIN bpa-dev-infrastructure hygiene"' > "$arming_fixture/bin/crontab"
printf '%s\n' '#!/usr/bin/env bash' 'printf "%s\\n" "Linger=yes"' > "$arming_fixture/bin/loginctl"
# The fake is a state machine, not a call logger: unknown operations fail and
# enable/disable mutate the states observed by later postchecks.
# shellcheck disable=SC2016
printf '%s\n' '#!/usr/bin/env bash' \
  'set -u' \
  'call="$*"; printf "%s\n" "$call" >> "${BOOTSTRAP_TEST_SYSTEMCTL_CALLS:?}"' \
  '[[ "$call" != "${BOOTSTRAP_TEST_FAIL_COMMAND:-}" ]] || exit "${BOOTSTRAP_TEST_FAIL_RC:-41}"' \
  'case "$call" in' \
  '  "show-environment"|"daemon-reload"|"enable --now bpa-telegram-daemon.service"|"enable --now bpa-orchestrator.service"|"enable --now bpa-full-suite.timer"|"enable --now orch-morning-report.timer"|"enable --now bpa-deploy-drift-guard.timer"|"enable --now agentic-bpa-staleness.timer"|"enable --now agentic-bpa-db-grants.timer"|"enable --now agentic-bpa-stand-verifier.service"|"enable --now bpa-meteorite.timer") exit 0 ;;' \
  '  "is-enabled --quiet bpa-orchestrator.service"|"is-active --quiet bpa-orchestrator.service"|"is-enabled --quiet bpa-telegram-daemon.service"|"is-active --quiet bpa-telegram-daemon.service"|"is-enabled --quiet bpa-full-suite.timer"|"is-enabled --quiet orch-morning-report.timer"|"is-enabled --quiet bpa-deploy-drift-guard.timer"|"is-enabled --quiet agentic-bpa-staleness.timer"|"is-enabled --quiet agentic-bpa-db-grants.timer"|"is-enabled --quiet agentic-bpa-stand-verifier.service"|"is-enabled --quiet bpa-meteorite.timer") exit 0 ;;' \
  '  "is-enabled --quiet bpa-orchestrator-watchdog.timer") [[ "$(head -n1 "${BOOTSTRAP_TEST_SYSTEM_STATE:?}")" == enabled ]] ;;' \
  '  "--user disable --now orch-runtime-watchdog.timer") printf "disabled\ninactive\n" > "${BOOTSTRAP_TEST_LEGACY_STATE:?}"; exit 0 ;;' \
  '  "--user enable --now orch-runtime-watchdog.timer") printf "enabled\nactive\n" > "${BOOTSTRAP_TEST_LEGACY_STATE:?}"; exit 0 ;;' \
  '  "disable --now bpa-orchestrator-watchdog.timer") printf "disabled\ninactive\n" > "${BOOTSTRAP_TEST_SYSTEM_STATE:?}"; exit 0 ;;' \
  '  "enable --now bpa-orchestrator-watchdog.timer") printf "enabled\nactive\n" > "${BOOTSTRAP_TEST_SYSTEM_STATE:?}"; exit 0 ;;' \
  '  "--user is-enabled orch-runtime-watchdog.timer") state="$(head -n1 "${BOOTSTRAP_TEST_LEGACY_STATE:?}")"; [[ "${BOOTSTRAP_TEST_BLANK_AFTER_LEGACY_DISABLE:-0}" != 1 || "$state" != disabled ]] || exit 0; printf "%s\n" "$state"; [[ "$state" == disabled ]] && exit 1; [[ "$state" == not-found ]] && exit 4; exit 0 ;;' \
  '  "--user is-active orch-runtime-watchdog.timer") state="$(tail -n1 "${BOOTSTRAP_TEST_LEGACY_STATE:?}")"; printf "%s\n" "$state"; [[ "$state" == inactive ]] && exit 3; exit 0 ;;' \
  '  "is-enabled bpa-orchestrator-watchdog.timer") state="$(head -n1 "${BOOTSTRAP_TEST_SYSTEM_STATE:?}")"; printf "%s\n" "$state"; [[ "$state" == disabled ]] && exit 1; [[ "$state" == not-found ]] && exit 4; exit 0 ;;' \
  '  "is-active bpa-orchestrator-watchdog.timer") state="$(tail -n1 "${BOOTSTRAP_TEST_SYSTEM_STATE:?}")"; printf "%s\n" "$state"; [[ "$state" == inactive ]] && exit 3; exit 0 ;;' \
  '  "show bpa-orchestrator-watchdog.timer --property=NextElapseUSecRealtime --value") printf "%s\n" "${BOOTSTRAP_TEST_NEXT_TRIGGER:-Sat 2026-08-01 12:00:00 UTC}" ;;' \
  '  "start bpa-orchestrator-watchdog.service") exit "${BOOTSTRAP_TEST_IMMEDIATE_RC:-0}" ;;' \
  '  *) printf "unknown systemctl operation: %s\n" "$call" >&2; exit 64 ;;' \
  'esac' > "$arming_fixture/bin/systemctl"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$arming_fixture/root/workspace/workspace.test.sh"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$arming_fixture/root/workspace/workspace.sh"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$arming_fixture/root/hygiene/install-cron.sh"
for script_name in launch.sh watchdog.sh full-suite.sh morning.sh; do
  printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$arming_fixture/root/orchestrator/$script_name"
done
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$arming_fixture/root/bootstrap/check-deployed-drift.sh"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$arming_fixture/root/deploy/check-live-stand-staleness.sh"
chmod 700 "$arming_fixture/bin"/* "$arming_fixture/root/hygiene/install-cron.sh" \
  "$arming_fixture/root/workspace/workspace.sh" "$arming_fixture/root/orchestrator"/*.sh \
  "$arming_fixture/root/bootstrap/check-deployed-drift.sh"
chmod 700 "$arming_fixture/root/deploy/check-live-stand-staleness.sh"

arming_calls="$arming_fixture/systemctl.calls"
run_full_install() { # <extra installer args...>
  : > "$arming_calls"
  printf '%s\n%s\n' "${BOOTSTRAP_TEST_LEGACY_ENABLED:-disabled}" \
    "${BOOTSTRAP_TEST_LEGACY_ACTIVE:-inactive}" > "$arming_fixture/legacy.state"
  printf '%s\n%s\n' "${BOOTSTRAP_TEST_SYSTEM_ENABLED:-disabled}" \
    "${BOOTSTRAP_TEST_SYSTEM_ACTIVE:-inactive}" > "$arming_fixture/system.state"
  PATH="$arming_fixture/bin:$PATH" \
    INSTALL_ROOT="$arming_fixture/root" \
    ENV_FILE="$arming_fixture/root/.env" \
    SYSTEMD_SYSTEM_DIR="$arming_fixture/config" \
    WHISPER_BIN="$arming_fixture/bin/bun" \
    BUN_BIN="$arming_fixture/bin/bun" \
    RUNTIME_DIR="$arming_fixture/root/runtime" \
    BOOTSTRAP_TEST_SYSTEMCTL_CALLS="$arming_calls" \
    BOOTSTRAP_TEST_LEGACY_STATE="$arming_fixture/legacy.state" \
    BOOTSTRAP_TEST_SYSTEM_STATE="$arming_fixture/system.state" \
    BOOTSTRAP_TEST_FAIL_COMMAND="${BOOTSTRAP_TEST_FAIL_COMMAND:-}" \
    BOOTSTRAP_TEST_FAIL_RC="${BOOTSTRAP_TEST_FAIL_RC:-41}" \
    BOOTSTRAP_TEST_BLANK_AFTER_LEGACY_DISABLE="${BOOTSTRAP_TEST_BLANK_AFTER_LEGACY_DISABLE:-0}" \
    BOOTSTRAP_TEST_NEXT_TRIGGER="${BOOTSTRAP_TEST_NEXT_TRIGGER:-Sat 2026-08-01 12:00:00 UTC}" \
    BOOTSTRAP_TEST_IMMEDIATE_RC="${BOOTSTRAP_TEST_IMMEDIATE_RC:-0}" \
    ORCH_WATCHDOG_NOW="${ORCH_WATCHDOG_NOW:-1785582000}" \
    "$INSTALLER" "$@"
}

bare_install_output="$(run_full_install)"
if grep -F 'enable --now bpa-orchestrator-watchdog.timer' "$arming_calls"; then
  echo 'ERROR: a bare install on a token-configured host armed the watchdog timer' >&2
  exit 1
fi
printf 'FAIL-BEFORE 17ec3e0a bare install recorded: enable --now bpa-orchestrator-watchdog.timer\n'
# The rest of the stack still activates: inertness is watchdog-specific.
grep -Fxq -- 'enable --now bpa-telegram-daemon.service' "$arming_calls"
grep -Fxq -- 'enable --now bpa-orchestrator.service' "$arming_calls"
grep -Fxq -- 'enable --now bpa-full-suite.timer' "$arming_calls"
grep -Fxq -- 'enable --now orch-morning-report.timer' "$arming_calls"
grep -Fxq -- 'daemon-reload' "$arming_calls"
test -f "$arming_fixture/config/bpa-orchestrator-watchdog.service"
test -f "$arming_fixture/config/bpa-orchestrator-watchdog.timer"
grep -Fq "EnvironmentFile=$arming_fixture/root/.env" "$arming_fixture/config/bpa-orchestrator-watchdog.service"
grep -Fq "ExecStart=$arming_fixture/root/orchestrator/watchdog.sh" "$arming_fixture/config/bpa-orchestrator-watchdog.service"
grep -Fq 'Persistent=true' "$arming_fixture/config/bpa-orchestrator-watchdog.timer"
grep -Fq 'Watchdog timer installed but remains unarmed.' <<<"$bare_install_output"

# Explicit arm retires an armed legacy user timer first, proves it inactive,
# enables the canonical system timer, validates one explicit finite property,
# and performs an immediate safe one-shot tick.
BOOTSTRAP_TEST_LEGACY_ENABLED=enabled \
BOOTSTRAP_TEST_LEGACY_ACTIVE=active \
BOOTSTRAP_TEST_NEXT_TRIGGER='Sat 2026-08-01 12:00:00 UTC' \
ORCH_WATCHDOG_NOW=1785582000 \
run_full_install --arm-watchdog >/dev/null
grep -Fxq -- '--user disable --now orch-runtime-watchdog.timer' "$arming_calls"
grep -Fxq -- 'enable --now bpa-orchestrator-watchdog.timer' "$arming_calls"
grep -Fxq -- 'show bpa-orchestrator-watchdog.timer --property=NextElapseUSecRealtime --value' "$arming_calls"
grep -Fxq -- 'start bpa-orchestrator-watchdog.service' "$arming_calls"

# An active timer without a finite future trigger is not armed.
if BOOTSTRAP_TEST_NEXT_TRIGGER=n/a ORCH_WATCHDOG_NOW=1785582000 \
  run_full_install --arm-watchdog >/dev/null 2>&1; then
  echo 'ERROR: bootstrap accepted an active watchdog with no next trigger' >&2
  exit 1
fi
grep -Fxq -- 'disable --now bpa-orchestrator-watchdog.timer' "$arming_calls"

# Rollback/disarm leaves rendered units for a future arm but ensures neither
# the canonical system timer nor legacy user timer remains armed.
run_full_install --disarm-watchdog >/dev/null
grep -Fxq -- 'disable --now bpa-orchestrator-watchdog.timer' "$arming_calls"
grep -Fxq -- '--user disable --now orch-runtime-watchdog.timer' "$arming_calls"
test -f "$arming_fixture/config/bpa-orchestrator-watchdog.timer"

# Every failed command/query is terminal, emits no false success, and leaves
# both timer generations in a modeled, inspectable state.
for failed_command in \
  'disable --now bpa-orchestrator-watchdog.timer' \
  '--user disable --now orch-runtime-watchdog.timer' \
  'is-enabled bpa-orchestrator-watchdog.timer' \
  '--user is-active orch-runtime-watchdog.timer'; do
  if disarm_output="$(BOOTSTRAP_TEST_FAIL_COMMAND="$failed_command" run_full_install --disarm-watchdog 2>&1)"; then
    echo "ERROR: disarm accepted failed command: $failed_command" >&2
    exit 1
  fi
  if grep -Fq 'Watchdog timers disarmed' <<<"$disarm_output"; then
    echo "ERROR: disarm printed false success after: $failed_command" >&2
    exit 1
  fi
done

# Blank post-retirement state is unverifiable and restores the proven armed
# legacy generation after proving the canonical generation inert.
if blank_output="$(BOOTSTRAP_TEST_LEGACY_ENABLED=enabled BOOTSTRAP_TEST_LEGACY_ACTIVE=active \
  BOOTSTRAP_TEST_BLANK_AFTER_LEGACY_DISABLE=1 run_full_install --arm-watchdog 2>&1)"; then
  echo 'ERROR: arm accepted blank legacy post-retirement output' >&2
  exit 1
fi
if grep -Fq 'Bootstrap completed' <<<"$blank_output"; then
  echo 'ERROR: blank post-retirement query printed success' >&2
  exit 1
fi

# Immediate recovery is in the arm transaction. Failure disables and proves
# the canonical timer, then restores the exact prior armed legacy state.
if immediate_output="$(BOOTSTRAP_TEST_LEGACY_ENABLED=enabled BOOTSTRAP_TEST_LEGACY_ACTIVE=active \
  BOOTSTRAP_TEST_IMMEDIATE_RC=42 ORCH_WATCHDOG_NOW=1785582000 \
  run_full_install --arm-watchdog 2>&1)"; then
  echo 'ERROR: arm accepted a failed immediate watchdog service' >&2
  exit 1
fi
grep -Fxq 'disabled' < <(head -n1 "$arming_fixture/system.state")
grep -Fxq 'inactive' < <(tail -n1 "$arming_fixture/system.state")
grep -Fxq 'enabled' < <(head -n1 "$arming_fixture/legacy.state")
grep -Fxq 'active' < <(tail -n1 "$arming_fixture/legacy.state")
if grep -Fq 'Bootstrap completed' <<<"$immediate_output"; then
  echo 'ERROR: immediate failure printed success' >&2
  exit 1
fi

# A rollback whose canonical disable fails is itself NO-GO.
if rollback_output="$(BOOTSTRAP_TEST_NEXT_TRIGGER=n/a \
  BOOTSTRAP_TEST_FAIL_COMMAND='disable --now bpa-orchestrator-watchdog.timer' \
  ORCH_WATCHDOG_NOW=1785582000 run_full_install --arm-watchdog 2>&1)"; then
  echo 'ERROR: arm accepted an unproven rollback disable' >&2
  exit 1
fi
grep -Fq 'rollback could not be proven' <<<"$rollback_output"

# Render deployable unit inputs without requiring host envsubst. Temporary test
# fixtures are intentionally outside this sweep; bootstrap inputs may never
# retain the retired host root.
rendered_units="$(for template in "$SCRIPT_DIR"/units/*.in; do
  # shellcheck disable=SC2016 # preserve template placeholders for sed
  sed 's|\$INSTALL_ROOT|/root/bpa-dev-infrastructure|g; s|\$ENV_FILE|/root/bpa-dev-infrastructure/.env|g; s|\$BUN_BIN|/root/.bun/bin/bun|g; s|\$BASH_BIN|/usr/bin/bash|g' "$template"
done)"
grep -Fq 'WorkingDirectory=/root/bpa-dev-infrastructure/orchestrator' <<<"$rendered_units"
grep -Fq 'EnvironmentFile=/root/bpa-dev-infrastructure/.env' <<<"$rendered_units"
grep -Fq 'ExecStart=/root/bpa-dev-infrastructure/orchestrator/morning.sh' <<<"$rendered_units"
if grep -RInF '/home/bpa-shell' "$INSTALLER" "$SCRIPT_DIR/env.template" "$SCRIPT_DIR/units" >/dev/null; then
  echo 'ERROR: legacy /home/bpa-shell reference found in bootstrap input' >&2
  exit 1
fi
if grep -Fq '/home/bpa-shell' <<<"$rendered_units"; then
  echo 'ERROR: legacy /home/bpa-shell reference found in rendered unit' >&2
  exit 1
fi

docker run --rm -v "$SCRIPT_DIR:/bootstrap:ro" koalaman/shellcheck:v0.10.0 \
  /bootstrap/install.sh /bootstrap/bootstrap.test.sh

secret_pattern='('
secret_pattern+="gh"'p_'
secret_pattern+='|'
secret_pattern+="client"'_secret'
secret_pattern+='|private[[:space:]_]+key|[0-9]{8,10}:AA)'

set +e
secret_scan_output="$(grep -RInE "$secret_pattern" \
  "$SCRIPT_DIR/env.template" "$SCRIPT_DIR/units" 2>&1)"
secret_scan_rc=$?
set -e

if [ "$secret_scan_rc" -eq 0 ]; then
  echo 'ERROR: secret-like value found in bootstrap templates' >&2
  echo "$secret_scan_output" >&2
  exit 1
elif [ "$secret_scan_rc" -eq 1 ]; then
  : # no matches
elif [ "$secret_scan_rc" -eq 2 ]; then
  echo 'ERROR: secret scan command failed while running grep' >&2
  echo "$secret_scan_output" >&2
  exit 1
else
  echo "ERROR: secret scan command failed with status $secret_scan_rc" >&2
  echo "$secret_scan_output" >&2
  exit 1
fi

echo 'PASS bootstrap dry-run, verify rows, containerized shellcheck, and template secret scan'
