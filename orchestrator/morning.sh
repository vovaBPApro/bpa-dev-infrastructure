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
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib.sh"

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
PENDING_FILE="${MORNING_PENDING_FILE:-$WATERMARK_FILE.pending}"
STATE_DB="${INFRA_STATE_DB:-$RUNTIME_DIR/state.db}"
BOOTSTRAP_SCRIPT="${MORNING_BOOTSTRAP_SCRIPT:-$REPO_ROOT/bootstrap/install.sh}"
MISSION_CLI="${MORNING_MISSION_CLI:-$REPO_ROOT/core/mission-cli.ts}"
STAND_SCRIPT="${MORNING_STAND_SCRIPT:-$REPO_ROOT/stand/matrix.sh}"
INSTALL_ROOT="${ORCH_INSTALL_ROOT:-${INSTALL_ROOT:-$REPO_ROOT}}"
DISK_ALERT_PCT="${DISK_ALERT_PCT:-80}"
FULL_SUITE_LOG="${FULL_SUITE_LOG:-$RUNTIME_DIR/full-suite.log}"
FULL_SUITE_MAX_AGE_S="${FULL_SUITE_MAX_AGE_S:-93600}"
TABLE_FILE="$(mktemp)"
DETAIL_FILE="$(mktemp)"
trap 'rm -f "$TABLE_FILE" "$DETAIL_FILE" "${OUTBOX_TMP:-}" "${STATE_TMP:-}"' EXIT
RESULT=0

atomic_write() {
  local value="$1" target="$2"
  STATE_TMP="$(mktemp "$(dirname "$target")/.morning.state.XXXXXX")"
  printf '%s\n' "$value" > "$STATE_TMP"
  mv -f "$STATE_TMP" "$target"
  STATE_TMP=''
}

mkdir -p "$(dirname "$OUTBOX_FILE")" "$(dirname "$WATERMARK_FILE")"
# A pending HEAD plus an existing outbox means publication happened. The outbox
# may already be empty because the daemon delivered it; finalize instead of
# exposing the same stable digest ID again.
if [[ -f "$PENDING_FILE" && -e "$OUTBOX_FILE" ]]; then
  PENDING_HEAD="$(<"$PENDING_FILE")"
  if [[ "$PENDING_HEAD" =~ ^[0-9a-f]{40}$ ]] &&
     { [[ ! -s "$OUTBOX_FILE" ]] || grep -Fq "BPA-MORNING-DIGEST-ID: $PENDING_HEAD" "$OUTBOX_FILE"; }; then
    atomic_write "$PENDING_HEAD" "$WATERMARK_FILE"
    rm -f "$PENDING_FILE"
    exit 0
  fi
fi

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

run_disk_check() {
  local pct
  pct="$(df -P "$INSTALL_ROOT" 2>/dev/null | awk 'NR == 2 { value=$5; sub(/%$/, "", value); print value }')"
  if [[ ! "$pct" =~ ^[0-9]+$ ]]; then
    row SKIP 'disk pressure' "df unavailable for $INSTALL_ROOT"
  elif (( pct >= DISK_ALERT_PCT )); then
    row FAIL 'disk pressure' "pct=$pct threshold=$DISK_ALERT_PCT"
  else
    row PASS 'disk pressure' "pct=$pct threshold=$DISK_ALERT_PCT"
  fi
}

run_full_suite_check() {
  local summary timestamp pass fail skipped failed skipped_list duration summary_epoch now age
  if [[ ! -f "$FULL_SUITE_LOG" ]]; then
    row SKIP 'FULL-SUITE' 'summary log absent'
    return
  fi
  summary="$(tail -n 1 "$FULL_SUITE_LOG")"
  if [[ "$summary" =~ ^FULL-SUITE\ ts=([^[:space:]]+)\ pass=([0-9]+)\ fail=([0-9]+)\ skipped=([0-9]+)\ failed=([^[:space:]]+)\ skipped_list=([^[:space:]]+)\ duration_s=([0-9]+)$ ]]; then
    timestamp="${BASH_REMATCH[1]}"
    pass="${BASH_REMATCH[2]}"
    fail="${BASH_REMATCH[3]}"
    skipped="${BASH_REMATCH[4]}"
    failed="${BASH_REMATCH[5]}"
    skipped_list="${BASH_REMATCH[6]}"
    duration="${BASH_REMATCH[7]}"
  else
    row FAIL 'FULL-SUITE' 'reason=summary-unavailable'
    return
  fi
  summary_epoch="$(date -u -d "$timestamp" +%s 2>/dev/null || true)"
  now="$(date +%s)"
  if ! [[ "$summary_epoch" =~ ^[0-9]+$ && "$now" =~ ^[0-9]+$ ]]; then
    row FAIL 'FULL-SUITE' 'reason=summary-timestamp-unavailable'
    return
  fi
  age=$(( now - summary_epoch ))
  if ! [[ "$FULL_SUITE_MAX_AGE_S" =~ ^[0-9]+$ ]]; then
    row FAIL 'FULL-SUITE' "reason=invalid-max-age value=$FULL_SUITE_MAX_AGE_S"
  elif (( age < 0 )); then
    row FAIL 'FULL-SUITE' "reason=future-timestamp age_s=$age"
  elif (( age > FULL_SUITE_MAX_AGE_S )); then
    row FAIL 'FULL-SUITE' "reason=stale age_s=$age max_age_s=$FULL_SUITE_MAX_AGE_S"
  elif (( fail == 0 )); then
    row PASS 'FULL-SUITE' "pass=$pass fail=$fail skipped=$skipped age_s=$age duration_s=$duration"
  else
    row FAIL 'FULL-SUITE' "pass=$pass fail=$fail skipped=$skipped failed=$failed skipped_list=$skipped_list age_s=$age duration_s=$duration"
  fi
}

run_bootstrap
run_status
run_stand
run_systemd_check
run_disk_check
run_full_suite_check

if [[ -f "$WATERMARK_FILE" ]]; then
  WATERMARK="$(<"$WATERMARK_FILE")"
else
  WATERMARK=''
fi
TARGET_HEAD="$(git -C "$REPO_ROOT" rev-parse HEAD)"
if [[ -n "$WATERMARK" ]] && git -C "$REPO_ROOT" cat-file -e "$WATERMARK^{commit}" 2>/dev/null; then
  COMMITS="$(git -C "$REPO_ROOT" log --format='%h %s' "$WATERMARK..$TARGET_HEAD")"
else
  COMMITS="$(git -C "$REPO_ROOT" log -1 --format='%h %s' "$TARGET_HEAD")"
fi
[[ -n "$COMMITS" ]] || COMMITS='Нових комітів немає.'

DIGEST_FILE="$(mktemp)"
trap 'rm -f "$TABLE_FILE" "$DETAIL_FILE" "$DIGEST_FILE" "${OUTBOX_TMP:-}" "${STATE_TMP:-}"' EXIT
{
  printf 'BPA-MORNING-DIGEST-ID: %s\n' "$TARGET_HEAD"
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
  if (( RESULT != 0 )); then
    printf 'Morning readiness failed; digest was not delivered.\n' >&2
  fi
  exit "$RESULT"
fi

if (( RESULT != 0 )); then
  printf 'Morning readiness failed; digest was not delivered.\n' >&2
  exit 1
fi
OUTBOX_TMP="$(mktemp "$(dirname "$OUTBOX_FILE")/.morning.outbox.XXXXXX")"
cp "$DIGEST_FILE" "$OUTBOX_TMP"
if [[ "${MORNING_INJECT_FAILURE:-}" == before-mv ]]; then
  printf 'Injected failure before atomic outbox replacement.\n' >&2
  exit 1
fi
atomic_write "$TARGET_HEAD" "$PENDING_FILE"
mv -f "$OUTBOX_TMP" "$OUTBOX_FILE"
OUTBOX_TMP=''
atomic_write "$TARGET_HEAD" "$WATERMARK_FILE"
rm -f "$PENDING_FILE"
