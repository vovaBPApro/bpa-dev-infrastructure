#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALLER="$SCRIPT_DIR/install.sh"

dry_run="$($INSTALLER --dry-run)"
for expected in \
  'PLAN apt' \
  'PLAN bun' \
  'PLAN repository' \
  'PLAN environment' \
  'PLAN units' \
  'PLAN activate'; do
  grep -Fq "$expected" <<<"$dry_run"
done

verify_fixture="$(mktemp -d)"
trap 'rm -rf "$verify_fixture"' EXIT
install -d -m 700 "$verify_fixture/root/.git" "$verify_fixture/config/systemd/user" "$verify_fixture/bin"
install -m 600 /dev/null "$verify_fixture/root/.env"
printf '%s\n' 'TELEGRAM_BOT_TOKEN=fixture-token' > "$verify_fixture/root/.env"
for unit in bpa-telegram-daemon.service bpa-orchestrator-watchdog.service bpa-orchestrator-watchdog.timer; do
  install -m 600 /dev/null "$verify_fixture/config/systemd/user/$unit"
done
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$verify_fixture/bin/bun"
printf '%s\n' '#!/usr/bin/env bash' 'exit 1' > "$verify_fixture/bin/systemctl"
for command_name in git curl tmux; do
  printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$verify_fixture/bin/$command_name"
done
chmod 700 "$verify_fixture/bin"/*
verify_output="$(PATH="$verify_fixture/bin:$PATH" \
  INSTALL_ROOT="$verify_fixture/root" \
  ENV_FILE="$verify_fixture/root/.env" \
  XDG_CONFIG_HOME="$verify_fixture/config" \
  BUN_BIN="$verify_fixture/bin/bun" \
  "$INSTALLER" --verify)"
grep -Fq 'SKIP user systemd' <<<"$verify_output"
grep -Fq 'SKIP daemon enabled' <<<"$verify_output"

printf '%s\n' 'TELEGRAM_BOT_TOKEN=__OPERATOR_PASTE_TELEGRAM_BOT_TOKEN_HERE__' > "$verify_fixture/root/.env"
placeholder_output="$(PATH="$verify_fixture/bin:$PATH" \
  INSTALL_ROOT="$verify_fixture/root" \
  ENV_FILE="$verify_fixture/root/.env" \
  XDG_CONFIG_HOME="$verify_fixture/config" \
  BUN_BIN="$verify_fixture/bin/bun" \
  "$INSTALLER" --verify)"
grep -Fq 'SKIP token configured' <<<"$placeholder_output"

if ! command -v shellcheck >/dev/null 2>&1; then
  echo 'ERROR: shellcheck is required to run bootstrap tests' >&2
  exit 127
fi
shellcheck "$SCRIPT_DIR"/*.sh

secret_pattern='('
secret_pattern+="gh"'p_'
secret_pattern+='|'
secret_pattern+="client"'_secret'
secret_pattern+='|private[[:space:]_]+key|[0-9]{8,10}:AA)'
if rg -n -i "$secret_pattern" \
  "$SCRIPT_DIR/env.template" "$SCRIPT_DIR/units"; then
  echo 'ERROR: secret-like value found in bootstrap templates' >&2
  exit 1
fi

echo 'PASS bootstrap dry-run, shellcheck, and template secret scan'
