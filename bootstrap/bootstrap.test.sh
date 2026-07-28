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
