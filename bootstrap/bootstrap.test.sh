#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALLER="$SCRIPT_DIR/install.sh"

# shellcheck disable=SC2016 # inspect the literal default assignment
grep -Fxq 'INSTALL_ROOT="${INSTALL_ROOT:-/home/bpa-dev-infrastructure}"' "$INSTALLER"

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
  "$verify_fixture/root/workspace" \
  "$verify_fixture/root/gate" \
  "$verify_fixture/root/runtime" \
  "$verify_fixture/config/systemd/user" \
  "$verify_fixture/bin"
install -m 600 /dev/null "$verify_fixture/root/.env"
printf '%s\n' 'TELEGRAM_BOT_TOKEN=fixture-token' > "$verify_fixture/root/.env"
for unit in bpa-telegram-daemon.service bpa-orchestrator-watchdog.service bpa-orchestrator-watchdog.timer; do
  install -m 600 /dev/null "$verify_fixture/config/systemd/user/$unit"
done
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$verify_fixture/bin/bun"
printf '%s\n' '#!/usr/bin/env bash' 'exit 1' > "$verify_fixture/bin/systemctl"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$verify_fixture/root/workspace/workspace.sh"
printf '%s\n' 'disabled by --no-cron' > "$verify_fixture/root/runtime/hygiene-cron.skip"
for command_name in git curl tmux; do
  printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$verify_fixture/bin/$command_name"
done
chmod 700 "$verify_fixture/bin"/*
chmod 700 "$verify_fixture/root/workspace/workspace.sh"
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
  'SKIP hygiene-cron' \
  'PASS gate'; do
  grep -Fq "$expected" <<<"$verify_output"
done
grep -Eq '^(PASS|SKIP) stand' <<<"$verify_output"

printf '%s\n' 'TELEGRAM_BOT_TOKEN=__OPERATOR_PASTE_TELEGRAM_BOT_TOKEN_HERE__' > "$verify_fixture/root/.env"
placeholder_output="$(PATH="$verify_fixture/bin:$PATH" \
  INSTALL_ROOT="$verify_fixture/root" \
  ENV_FILE="$verify_fixture/root/.env" \
  XDG_CONFIG_HOME="$verify_fixture/config" \
  BUN_BIN="$verify_fixture/bin/bun" \
  "$INSTALLER" --verify)"
grep -Fq 'SKIP token configured' <<<"$placeholder_output"

# Render deployable unit inputs without requiring host envsubst. Temporary test
# fixtures are intentionally outside this sweep; bootstrap inputs may never
# retain the retired host root.
rendered_units="$(for template in "$SCRIPT_DIR"/units/*.in; do
  # shellcheck disable=SC2016 # preserve template placeholders for sed
  sed 's|\$INSTALL_ROOT|/home/bpa-dev-infrastructure|g; s|\$ENV_FILE|/home/bpa-dev-infrastructure/.env|g; s|\$BUN_BIN|/root/.bun/bin/bun|g' "$template"
done)"
if grep -RInF '/home/bpa-shell' "$INSTALLER" "$SCRIPT_DIR/env.template" "$SCRIPT_DIR/units" >/dev/null; then
  echo 'ERROR: legacy /home/bpa-shell reference found in bootstrap input' >&2
  exit 1
fi
if grep -Fq '/home/bpa-shell' <<<"$rendered_units"; then
  echo 'ERROR: legacy /home/bpa-shell reference found in rendered unit' >&2
  exit 1
fi

docker run --rm -v "$SCRIPT_DIR:/bootstrap:ro" koalaman/shellcheck:stable \
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
