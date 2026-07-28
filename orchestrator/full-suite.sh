#!/usr/bin/env bash
# One full-suite tick over the canonical installed checkout. A red suite is
# recorded but never prevents the remaining suites from running.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${ORCH_CONFIG_FILE:-$SCRIPT_DIR/runtime.env}"
if [[ -f "$CONFIG_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
fi

REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
INSTALL_ROOT="${ORCH_INSTALL_ROOT:-${INSTALL_ROOT:-$REPO_DIR}}"
RUNTIME_DIR="${ORCH_RUNTIME_DIR:-$SCRIPT_DIR/runtime}"
FULL_SUITE_LOG="${FULL_SUITE_LOG:-$RUNTIME_DIR/full-suite.log}"
NUDGE_OUTBOX_FILE="${NUDGE_OUTBOX_FILE:-$RUNTIME_DIR/nudges.outbox}"
FULL_SUITE_NUDGE_REPEAT_MS="${FULL_SUITE_NUDGE_REPEAT_MS:-21600000}"
FULL_SUITE_NUDGE_RATE_FILE="${FULL_SUITE_NUDGE_RATE_FILE:-$RUNTIME_DIR/full-suite-nudge-rate.tsv}"

log() {
  mkdir -p "$(dirname "$FULL_SUITE_LOG")"
  printf '%s\n' "$*" >> "$FULL_SUITE_LOG"
}

validate_numeric_knob() {
  local name="$1" default="$2" value="${!1}"
  if ! [[ "$value" =~ ^[0-9]+$ ]]; then
    log "FULL-SUITE invalid-knob name=$name value=$value using-default=$default"
    printf -v "$name" '%s' "$default"
  fi
}

append_nudge() {
  local line="$1" tmp
  mkdir -p "$(dirname "$NUDGE_OUTBOX_FILE")"
  tmp="$(mktemp "$(dirname "$NUDGE_OUTBOX_FILE")/.nudges.outbox.XXXXXX")"
  [[ -f "$NUDGE_OUTBOX_FILE" ]] && cat "$NUDGE_OUTBOX_FILE" > "$tmp"
  printf '%s\n' "$line" >> "$tmp"
  mv -f "$tmp" "$NUDGE_OUTBOX_FILE"
}

nudge_due() {
  local now="$1" last=0
  if [[ -f "$FULL_SUITE_NUDGE_RATE_FILE" ]]; then
    last="$(awk -F '\t' '$1 == "full-suite" { value=$2 } END { print value+0 }' "$FULL_SUITE_NUDGE_RATE_FILE")"
  fi
  (( now - last >= FULL_SUITE_NUDGE_REPEAT_MS ))
}

record_nudge() {
  local now="$1" tmp
  mkdir -p "$(dirname "$FULL_SUITE_NUDGE_RATE_FILE")"
  tmp="$(mktemp "$(dirname "$FULL_SUITE_NUDGE_RATE_FILE")/.full-suite-rate.XXXXXX")"
  printf 'full-suite\t%s\n' "$now" > "$tmp"
  mv -f "$tmp" "$FULL_SUITE_NUDGE_RATE_FILE"
}

validate_numeric_knob FULL_SUITE_NUDGE_REPEAT_MS 21600000

if [[ ! -d "$INSTALL_ROOT" ]]; then
  log "FULL-SUITE SKIP reason=repo-root-absent root=$INSTALL_ROOT"
  exit 1
fi

mkdir -p "$(dirname "$FULL_SUITE_LOG")"
started_epoch="$(date +%s)"
timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
pass=0
fail=0
failed=()
suite_count=0

# There is deliberately no hand-maintained list: every shell suite present in
# the installed checkout is eligible, including future directories.
while IFS= read -r -d '' suite; do
  suite_count=$((suite_count + 1))
  relative="${suite#"$INSTALL_ROOT"/}"
  if bash "$suite" >> "$FULL_SUITE_LOG" 2>&1; then
    rc=0
    pass=$((pass + 1))
  else
    rc=$?
    fail=$((fail + 1))
    failed+=("$relative")
  fi
  log "FULL-SUITE SUITE ts=$timestamp suite=$relative rc=$rc"
done < <(find "$INSTALL_ROOT" -type f -name '*.test.sh' -print0 | sort -z)

if (( suite_count == 0 )); then
  log "FULL-SUITE SKIP reason=no-test-suites root=$INSTALL_ROOT"
  exit 1
fi

duration_s=$(( $(date +%s) - started_epoch ))
failed_list=none
if (( fail > 0 )); then
  failed_list="$(IFS=,; printf '%s' "${failed[*]}")"
fi
log "FULL-SUITE ts=$timestamp pass=$pass fail=$fail failed=$failed_list duration_s=$duration_s"

if (( fail > 0 )); then
  now_ms=$(( $(date +%s) * 1000 ))
  if nudge_due "$now_ms"; then
    append_nudge "NUDGE full-suite pass=$pass fail=$fail failed=$failed_list"
    record_nudge "$now_ms"
  fi
fi

exit 0
