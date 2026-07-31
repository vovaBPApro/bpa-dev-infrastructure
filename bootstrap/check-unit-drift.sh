#!/usr/bin/env bash
# Fail when a deployed BPA system unit differs from its rendered tracked template.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_DIR="${TEMPLATE_DIR:-$SCRIPT_DIR/units}"
SYSTEMD_SYSTEM_DIR="${SYSTEMD_SYSTEM_DIR:-/etc/systemd/system}"
INSTALL_ROOT="${INSTALL_ROOT:-/root/bpa-dev-infrastructure}"
ENV_FILE="${ENV_FILE:-/root/.config/bpa/orchestrator.env}"
BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"
FULL_SUITE_ON_CALENDAR="${FULL_SUITE_ON_CALENDAR:-*-*-* 03:30:00}"
ORCH_WATCHDOG_INTERVAL="${ORCH_WATCHDOG_INTERVAL:-60}"
EXEMPTIONS_FILE="${EXEMPTIONS_FILE:-$SCRIPT_DIR/../instance/unit-drift-exemptions.tsv}"
export INSTALL_ROOT ENV_FILE BUN_BIN FULL_SUITE_ON_CALENDAR ORCH_WATCHDOG_INTERVAL

command -v envsubst >/dev/null 2>&1 || {
  echo 'ERROR: envsubst is required to check unit drift' >&2
  exit 2
}

scratch="$(mktemp -d "${TMPDIR:-/tmp}/bpa-unit-drift.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT

result=0
template_count=0
declare -A missing_exemptions=()
if [[ -f "$EXEMPTIONS_FILE" ]]; then
  while IFS=$'\t' read -r unit disposition evidence extra; do
    [[ -z "$unit" || "$unit" == \#* ]] && continue
    if [[ -n "${extra:-}" || "$unit" != *.service && "$unit" != *.timer || "$disposition" != deliberately-absent || -z "$evidence" ]]; then
      printf 'ERROR invalid unit-drift exemption: %s\n' "$unit" >&2
      exit 2
    fi
    if [[ -n "${missing_exemptions[$unit]+x}" ]]; then
      printf 'ERROR duplicate unit-drift exemption: %s\n' "$unit" >&2
      exit 2
    fi
    missing_exemptions["$unit"]="$evidence"
  done < "$EXEMPTIONS_FILE"
fi
for template in "$TEMPLATE_DIR"/*.in; do
  [[ -f "$template" ]] || continue
  ((template_count += 1))
  unit="$(basename "${template%.in}")"
  deployed="$SYSTEMD_SYSTEM_DIR/$unit"
  expected="$scratch/$unit"
  envsubst < "$template" > "$expected"
  if [[ ! -f "$deployed" ]]; then
    if [[ -n "${missing_exemptions[$unit]+x}" ]]; then
      printf 'EXEMPT %s: deliberately absent (%s)\n' "$unit" "${missing_exemptions[$unit]}"
    else
      printf 'DRIFT %s: deployed unit missing at %s\n' "$unit" "$deployed" >&2
      result=1
    fi
  elif ! cmp -s "$expected" "$deployed"; then
    printf 'DRIFT %s: deployed unit differs from rendered template\n' "$unit" >&2
    diff -u --label "deployed/$unit" --label "tracked/$unit" "$deployed" "$expected" >&2 || true
    result=1
  else
    printf 'MATCH %s\n' "$unit"
  fi
done

if ((template_count == 0)); then
  printf 'ERROR: no unit templates found in %s\n' "$TEMPLATE_DIR" >&2
  exit 2
fi

exit "$result"
