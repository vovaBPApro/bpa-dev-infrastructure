#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALLER="$SCRIPT_DIR/install.sh"

# shellcheck disable=SC2016 # inspect the literal default assignment
grep -Fxq 'INSTALL_ROOT="${INSTALL_ROOT:-/home/bpa-dev-infrastructure}"' "$INSTALLER"
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
  "$verify_fixture/config/systemd/user" \
  "$verify_fixture/bin"
install -m 600 /dev/null "$verify_fixture/root/.env"
printf '%s\n' 'TELEGRAM_BOT_TOKEN=fixture-token' > "$verify_fixture/root/.env"
printf '%s\n' \
  '[Service]' \
  "ExecStart=$verify_fixture/bin/bun run server.ts" > "$verify_fixture/config/systemd/user/bpa-telegram-daemon.service"
printf '%s\n' \
  '[Service]' \
  "ExecStart=$verify_fixture/root/orchestrator/watchdog.sh" > "$verify_fixture/config/systemd/user/bpa-orchestrator-watchdog.service"
printf '%s\n' '[Timer]' > "$verify_fixture/config/systemd/user/bpa-orchestrator-watchdog.timer"
printf '%s\n' \
  '[Service]' \
  "ExecStart=$verify_fixture/root/orchestrator/full-suite.sh" > "$verify_fixture/config/systemd/user/bpa-full-suite.service"
printf '%s\n' '[Timer]' > "$verify_fixture/config/systemd/user/bpa-full-suite.timer"
printf '%s\n' \
  '[Service]' \
  "ExecStart=$verify_fixture/root/orchestrator/morning.sh" > "$verify_fixture/config/systemd/user/orch-morning-report.service"
printf '%s\n' '[Timer]' > "$verify_fixture/config/systemd/user/orch-morning-report.timer"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$verify_fixture/bin/bun"
printf '%s\n' '#!/usr/bin/env bash' 'exit 1' > "$verify_fixture/bin/systemctl"
printf '%s\n' '#!/usr/bin/env bash' 'printf "%s\\n" "Linger=yes"' > "$verify_fixture/bin/loginctl"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$verify_fixture/root/workspace/workspace.sh"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$verify_fixture/root/orchestrator/watchdog.sh"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$verify_fixture/root/orchestrator/full-suite.sh"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$verify_fixture/root/orchestrator/morning.sh"
printf '%s\n' 'disabled by --no-cron' > "$verify_fixture/root/runtime/hygiene-cron.skip"
for command_name in git curl tmux; do
  printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$verify_fixture/bin/$command_name"
done
chmod 700 "$verify_fixture/bin"/*
chmod 700 "$verify_fixture/root/workspace/workspace.sh"
chmod 700 "$verify_fixture/root/orchestrator/watchdog.sh" "$verify_fixture/root/orchestrator/full-suite.sh" "$verify_fixture/root/orchestrator/morning.sh"
verify_output="$(PATH="$verify_fixture/bin:$PATH" \
  INSTALL_ROOT="$verify_fixture/root" \
  ENV_FILE="$verify_fixture/root/.env" \
  XDG_CONFIG_HOME="$verify_fixture/config" \
  BUN_BIN="$verify_fixture/bin/bun" \
  "$INSTALLER" --verify)"
grep -Fq 'SKIP user systemd' <<<"$verify_output"
grep -Fq 'SKIP daemon enabled' <<<"$verify_output"
for expected in \
  'PASS state-db' \
  'PASS workspace' \
  'PASS linger' \
  'SKIP hygiene-cron' \
  'PASS gate' \
  'PASS morning service' \
  'PASS morning timer' \
  'PASS unit Exec paths'; do
  grep -Fq "$expected" <<<"$verify_output"
done
grep -Eq '^(PASS|SKIP) stand' <<<"$verify_output"

old_watchdog_exec="$(git -C "$SCRIPT_DIR/.." show 148b9ad0:bootstrap/units/bpa-orchestrator-watchdog.service.in | sed -n 's/^ExecStart=//p')"
expected_old_watchdog_exec="\$INSTALL_ROOT/daemon/orchestrator-watchdog.sh"
[[ "$old_watchdog_exec" == "$expected_old_watchdog_exec" ]]
old_watchdog_exec="${old_watchdog_exec/\$INSTALL_ROOT/$verify_fixture/root}"
printf '%s\n' \
  '[Service]' \
  "ExecStart=$old_watchdog_exec" > "$verify_fixture/config/systemd/user/bpa-orchestrator-watchdog.service"
if broken_output="$(PATH="$verify_fixture/bin:$PATH" \
  INSTALL_ROOT="$verify_fixture/root" \
  ENV_FILE="$verify_fixture/root/.env" \
  XDG_CONFIG_HOME="$verify_fixture/config" \
  BUN_BIN="$verify_fixture/bin/bun" \
  "$INSTALLER" --verify 2>&1)"; then
  echo 'ERROR: verify accepted a unit with a missing ExecStart target' >&2
  exit 1
fi
grep -Fq 'FAIL unit Exec paths' <<<"$broken_output"
printf 'FAIL-BEFORE 148b9ad0 ExecStart=%s\n' "$old_watchdog_exec"
grep '^FAIL unit Exec paths' <<<"$broken_output"
printf '%s\n' \
  '[Service]' \
  "ExecStart=$verify_fixture/root/orchestrator/watchdog.sh" > "$verify_fixture/config/systemd/user/bpa-orchestrator-watchdog.service"

rm "$verify_fixture/config/systemd/user/orch-morning-report.timer"
if missing_morning_output="$(PATH="$verify_fixture/bin:$PATH" \
  INSTALL_ROOT="$verify_fixture/root" \
  ENV_FILE="$verify_fixture/root/.env" \
  XDG_CONFIG_HOME="$verify_fixture/config" \
  BUN_BIN="$verify_fixture/bin/bun" \
  "$INSTALLER" --verify 2>&1)"; then
  echo 'ERROR: verify accepted a missing morning timer' >&2
  exit 1
fi
grep -Fq 'FAIL morning timer' <<<"$missing_morning_output"
printf '%s\n' 'FAIL-BEFORE missing morning timer'
grep '^FAIL morning timer' <<<"$missing_morning_output"
printf '%s\n' '[Timer]' > "$verify_fixture/config/systemd/user/orch-morning-report.timer"

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
  XDG_CONFIG_HOME="$verify_fixture/config" \
  BUN_BIN="$verify_fixture/bin/bun" \
  "$INSTALLER" --verify)"
grep -Fq 'SKIP token configured' <<<"$placeholder_output"

printf '%s\n' '#!/usr/bin/env bash' 'printf "%s\\n" "Linger=no"' > "$verify_fixture/bin/loginctl"
linger_warning="$(PATH="$verify_fixture/bin:$PATH" \
  INSTALL_ROOT="$verify_fixture/root" \
  ENV_FILE="$verify_fixture/root/.env" \
  INSTALLER_PATH="$INSTALLER" \
  BOOTSTRAP_LIB_ONLY=true \
  bash -c 'source "$INSTALLER_PATH"; warn_if_linger_disabled' 2>&1)"
grep -Fq 'WARNING: user lingering is disabled' <<<"$linger_warning"
grep -Fq "loginctl enable-linger $USER" <<<"$linger_warning"

# Render deployable unit inputs without requiring host envsubst. Temporary test
# fixtures are intentionally outside this sweep; bootstrap inputs may never
# retain the retired host root.
rendered_units="$(for template in "$SCRIPT_DIR"/units/*.in; do
  # shellcheck disable=SC2016 # preserve template placeholders for sed
  sed 's|\$INSTALL_ROOT|/home/bpa-dev-infrastructure|g; s|\$ENV_FILE|/home/bpa-dev-infrastructure/.env|g; s|\$BUN_BIN|/root/.bun/bin/bun|g' "$template"
done)"
grep -Fq 'WorkingDirectory=/home/bpa-dev-infrastructure/orchestrator' <<<"$rendered_units"
grep -Fq 'EnvironmentFile=/home/bpa-dev-infrastructure/.env' <<<"$rendered_units"
grep -Fq 'ExecStart=/home/bpa-dev-infrastructure/orchestrator/morning.sh' <<<"$rendered_units"
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
