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
  "$verify_fixture/root/orchestrator" \
  "$verify_fixture/root/workspace" \
  "$verify_fixture/root/gate" \
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
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$verify_fixture/opt/whisper.cpp/bin/whisper-cli"
printf '%s\n' 'disabled by --no-cron' > "$verify_fixture/root/runtime/hygiene-cron.skip"
for command_name in git curl tmux docker codex claude; do
  printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$verify_fixture/bin/$command_name"
done
chmod 700 "$verify_fixture/bin"/*
chmod 700 "$verify_fixture/root/workspace/workspace.sh"
chmod 700 "$verify_fixture/root/orchestrator/watchdog.sh" "$verify_fixture/root/orchestrator/full-suite.sh" "$verify_fixture/root/orchestrator/morning.sh"
chmod 700 "$verify_fixture/root/orchestrator/launch.sh" "$verify_fixture/opt/whisper.cpp/bin/whisper-cli"
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
  'PASS unit Exec paths'; do
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
printf '%s\n' \
  '[Service]' \
  "ExecStart=$verify_fixture/root/orchestrator/watchdog.sh" > "$verify_fixture/systemd/system/bpa-orchestrator-watchdog.service"

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
printf '%s\n' '[Timer]' > "$verify_fixture/systemd/system/orch-morning-report.timer"

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
# shellcheck disable=SC2016 # the recorder shim must expand $* at CALL time
printf '%s\n' '#!/usr/bin/env bash' \
  'printf "%s\n" "$*" >> "${BOOTSTRAP_TEST_SYSTEMCTL_CALLS:?}"' \
  'exit 0' > "$arming_fixture/bin/systemctl"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$arming_fixture/root/workspace/workspace.test.sh"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$arming_fixture/root/workspace/workspace.sh"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$arming_fixture/root/hygiene/install-cron.sh"
for script_name in launch.sh watchdog.sh full-suite.sh morning.sh; do
  printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$arming_fixture/root/orchestrator/$script_name"
done
chmod 700 "$arming_fixture/bin"/* "$arming_fixture/root/hygiene/install-cron.sh" \
  "$arming_fixture/root/workspace/workspace.sh" "$arming_fixture/root/orchestrator"/*.sh

arming_calls="$arming_fixture/systemctl.calls"
run_full_install() { # <extra installer args...>
  : > "$arming_calls"
  PATH="$arming_fixture/bin:$PATH" \
    INSTALL_ROOT="$arming_fixture/root" \
    ENV_FILE="$arming_fixture/root/.env" \
    SYSTEMD_SYSTEM_DIR="$arming_fixture/config" \
    WHISPER_BIN="$arming_fixture/bin/bun" \
    BUN_BIN="$arming_fixture/bin/bun" \
    RUNTIME_DIR="$arming_fixture/root/runtime" \
    BOOTSTRAP_TEST_SYSTEMCTL_CALLS="$arming_calls" \
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
test -f "$arming_fixture/config/bpa-orchestrator-watchdog.timer"
grep -Fq 'Watchdog timer installed INERT' <<<"$bare_install_output"

# Only the explicit watchdog-specific opt-in arms it.
run_full_install --arm-watchdog >/dev/null
grep -Fxq -- 'enable --now bpa-orchestrator-watchdog.timer' "$arming_calls"

# Render deployable unit inputs without requiring host envsubst. Temporary test
# fixtures are intentionally outside this sweep; bootstrap inputs may never
# retain the retired host root.
rendered_units="$(for template in "$SCRIPT_DIR"/units/*.in; do
  # shellcheck disable=SC2016 # preserve template placeholders for sed
  sed 's|\$INSTALL_ROOT|/root/bpa-dev-infrastructure|g; s|\$ENV_FILE|/root/bpa-dev-infrastructure/.env|g; s|\$BUN_BIN|/root/.bun/bin/bun|g' "$template"
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
