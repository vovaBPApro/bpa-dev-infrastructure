#!/usr/bin/env bash
# Build the 08:00 Krakow readiness digest. The Telegram daemon owns delivery:
# it consumes MORNING_OUTBOX_FILE after this script atomically replaces it.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${MORNING_REPO_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
CONFIG_FILE="${ORCH_CONFIG_FILE:-$SCRIPT_DIR/runtime.env}"
if [[ -f "$CONFIG_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
fi

DRY_RUN=false
case "${1:-}" in
  '') ;;
  --dry-run) DRY_RUN=true ;;
  -h|--help) printf '%s\n' 'Usage: morning.sh [--dry-run]'; exit 0 ;;
  *) printf 'Usage: morning.sh [--dry-run]\n' >&2; exit 2 ;;
esac

RUNTIME_DIR="${ORCH_RUNTIME_DIR:-$SCRIPT_DIR/runtime}"
OUTBOX_FILE="${MORNING_OUTBOX_FILE:-$RUNTIME_DIR/morning.outbox}"
WATERMARK_FILE="${MORNING_WATERMARK_FILE:-$RUNTIME_DIR/morning.watermark}"
STATE_DB="${INFRA_STATE_DB:-$RUNTIME_DIR/state.db}"
BUN_BIN="${BUN_BIN:-bun}"
BOOTSTRAP_SCRIPT="${MORNING_BOOTSTRAP_SCRIPT:-$REPO_ROOT/bootstrap/install.sh}"
MISSION_CLI="${MORNING_MISSION_CLI:-$REPO_ROOT/core/mission-cli.ts}"
STAND_SCRIPT="${MORNING_STAND_SCRIPT:-$REPO_ROOT/stand/matrix.sh}"
TABLE_FILE="$(mktemp)"
DETAIL_FILE="$(mktemp)"
trap 'rm -f "$TABLE_FILE" "$DETAIL_FILE" "${OUTBOX_TMP:-}"' EXIT
RESULT=0

row() {
  local state="$1" label="$2" detail="${3:-}"
  printf '%s|%s|%s\n' "$state" "$label" "$detail" >> "$TABLE_FILE"
  [[ "$state" != FAIL ]] || RESULT=1
}

run_bootstrap() {
  if INSTALL_ROOT="${INSTALL_ROOT:-$REPO_ROOT}" RUNTIME_DIR="$RUNTIME_DIR" INFRA_STATE_DB="$STATE_DB" "$BOOTSTRAP_SCRIPT" --verify >"$DETAIL_FILE" 2>&1; then
    row PASS 'bootstrap verify' 'bootstrap/install.sh --verify'
  else
    row FAIL 'bootstrap verify' 'bootstrap/install.sh --verify failed'
  fi
  while IFS= read -r check; do
    printf '%s\n' "$check" >> "$TABLE_FILE"
  done < <(sed -n '/^\(PASS\|FAIL\|SKIP\) /p' "$DETAIL_FILE")
}

run_status() {
  if INFRA_STATE_DB="$STATE_DB" "$BUN_BIN" "$MISSION_CLI" status >"$DETAIL_FILE" 2>&1; then
    STATUS_JSON="$(cat "$DETAIL_FILE")"
    row PASS 'стан місій' 'mission-cli status'
  else
    STATUS_JSON='{"missions":[],"lanes":[],"leases":[]}'
    row FAIL 'стан місій' 'mission-cli status failed'
  fi
}

run_stand() {
  if ! command -v docker >/dev/null 2>&1; then
    row SKIP 'stand smoke' 'docker command unavailable'
    return
  fi
  if ! docker info >/dev/null 2>&1; then
    row SKIP 'stand smoke' 'docker daemon unavailable'
    return
  fi
  local up_ok=true down_ok=true
  "$STAND_SCRIPT" up morning-smoke >"$DETAIL_FILE" 2>&1 || up_ok=false
  "$STAND_SCRIPT" down morning-smoke >>"$DETAIL_FILE" 2>&1 || down_ok=false
  if "$up_ok" && "$down_ok"; then
    row PASS 'stand smoke' 'up, health, down'
  else
    row FAIL 'stand smoke' 'up, health, or down failed'
  fi
}

run_systemd_check() {
  if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
    row PASS 'user systemd' 'user session available'
  else
    row SKIP 'user systemd' 'no user-systemd session'
  fi
}

run_bootstrap
run_status
run_stand
run_systemd_check

if (( RESULT != 0 )); then
  printf 'Morning readiness failed; digest was not delivered.\n' >&2
  exit 1
fi

if [[ -f "$WATERMARK_FILE" ]]; then
  WATERMARK="$(<"$WATERMARK_FILE")"
else
  WATERMARK=''
fi
if [[ -n "$WATERMARK" ]] && git -C "$REPO_ROOT" cat-file -e "$WATERMARK^{commit}" 2>/dev/null; then
  COMMITS="$(git -C "$REPO_ROOT" log --format='%h %s' "$WATERMARK..HEAD")"
else
  COMMITS="$(git -C "$REPO_ROOT" log -1 --format='%h %s')"
fi
[[ -n "$COMMITS" ]] || COMMITS='Нових комітів немає.'

DIGEST_FILE="$(mktemp)"
trap 'rm -f "$TABLE_FILE" "$DETAIL_FILE" "$DIGEST_FILE" "${OUTBOX_TMP:-}"' EXIT
{
  printf 'Ранковий звіт BPA — %s (Краків)\n\n' "$(TZ=Europe/Warsaw date '+%Y-%m-%d %H:%M')"
  printf 'Що нового\n%s\n\n' "$COMMITS"
  printf 'Активні місії / лейни / lease-и\n%s\n\n' "$STATUS_JSON"
  printf 'Готовність\n'
  while IFS='|' read -r state label detail; do
    printf '%s — %s%s\n' "$state" "$label" "${detail:+ ($detail)}"
  done < "$TABLE_FILE"
  printf '\nЩо потестити\nПеревірити Telegram-доставку цього звіту та активні місії вище.\n'
} > "$DIGEST_FILE"

if "$DRY_RUN"; then
  cat "$DIGEST_FILE"
  exit 0
fi
mkdir -p "$(dirname "$OUTBOX_FILE")" "$(dirname "$WATERMARK_FILE")"
OUTBOX_TMP="$(mktemp "$(dirname "$OUTBOX_FILE")/.morning.outbox.XXXXXX")"
cp "$DIGEST_FILE" "$OUTBOX_TMP"
if [[ "${MORNING_INJECT_FAILURE:-}" == before-mv ]]; then
  printf 'Injected failure before atomic outbox replacement.\n' >&2
  exit 1
fi
mv -f "$OUTBOX_TMP" "$OUTBOX_FILE"
OUTBOX_TMP=''
printf '%s\n' "$(git -C "$REPO_ROOT" rev-parse HEAD)" > "$WATERMARK_FILE"
