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
DEFAULT_FULL_SUITE_EXCLUDE="migration-prep/"
FULL_SUITE_EXCLUDE="${FULL_SUITE_EXCLUDE:-$DEFAULT_FULL_SUITE_EXCLUDE}"

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

validate_exclude_knob() {
  local value="$FULL_SUITE_EXCLUDE" selector
  local -a selectors
  IFS=',' read -r -a selectors <<< "$value"
  if ((${#selectors[@]} == 0)); then
    log "FULL-SUITE invalid-knob name=FULL_SUITE_EXCLUDE value=$value using-default=$DEFAULT_FULL_SUITE_EXCLUDE"
    FULL_SUITE_EXCLUDE="$DEFAULT_FULL_SUITE_EXCLUDE"
    return
  fi
  for selector in "${selectors[@]}"; do
    if ! [[ "$selector" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*/$ ]] || [[ "$selector" == *'..'* || "$selector" == *'//' ]]; then
      log "FULL-SUITE invalid-knob name=FULL_SUITE_EXCLUDE value=$value using-default=$DEFAULT_FULL_SUITE_EXCLUDE"
      FULL_SUITE_EXCLUDE="$DEFAULT_FULL_SUITE_EXCLUDE"
      return
    fi
  done
}

suite_is_excluded() {
  local relative="$1" selector
  local -a selectors
  IFS=',' read -r -a selectors <<< "$FULL_SUITE_EXCLUDE"
  for selector in "${selectors[@]}"; do
    [[ "$relative" == "$selector"* ]] && return 0
  done
  return 1
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
validate_exclude_knob

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
skipped=()
suite_count=0

# There is deliberately no hand-maintained list: every shell suite present in
# the installed checkout is eligible, including future directories.
while IFS= read -r -d '' suite; do
  suite_count=$((suite_count + 1))
  relative="${suite#"$INSTALL_ROOT"/}"
  if suite_is_excluded "$relative"; then
    skipped+=("$relative")
    log "FULL-SUITE SUITE ts=$timestamp suite=$relative rc=SKIP reason=excluded"
    continue
  fi
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

# Bun receives the complete, sorted TypeScript suite set in one deterministic
# invocation. Shell suites retain their existing one-process-per-suite behavior.
ts_suites=()
while IFS= read -r -d '' suite; do
  suite_count=$((suite_count + 1))
  relative="${suite#"$INSTALL_ROOT"/}"
  if suite_is_excluded "$relative"; then
    skipped+=("$relative")
    log "FULL-SUITE SUITE ts=$timestamp suite=$relative rc=SKIP reason=excluded"
    continue
  fi
  ts_suites+=("$relative")
done < <(find "$INSTALL_ROOT" -type f -name '*.test.ts' -print0 | sort -z)

if ((${#ts_suites[@]} > 0)); then
  # BUN_OPTIONS is a caller-level CLI injection surface (for example,
  # --only-failures or --test-name-pattern). Nightly semantics are fixed here.
  if (cd "$INSTALL_ROOT" && env -u BUN_OPTIONS bun test "${ts_suites[@]}") >> "$FULL_SUITE_LOG" 2>&1; then
    rc=0
    pass=$((pass + ${#ts_suites[@]}))
  else
    rc=$?
    fail=$((fail + ${#ts_suites[@]}))
    failed+=("${ts_suites[@]}")
  fi
  for relative in "${ts_suites[@]}"; do
    log "FULL-SUITE SUITE ts=$timestamp suite=$relative rc=$rc"
  done
fi

if (( suite_count == 0 )); then
  log "FULL-SUITE SKIP reason=no-test-suites root=$INSTALL_ROOT"
  exit 1
fi

duration_s=$(( $(date +%s) - started_epoch ))
failed_list=none
skipped_list=none
if (( fail > 0 )); then
  failed_list="$(IFS=,; printf '%s' "${failed[*]}")"
fi
if ((${#skipped[@]} > 0)); then
  skipped_list="$(IFS=,; printf '%s' "${skipped[*]}")"
fi
log "FULL-SUITE ts=$timestamp pass=$pass fail=$fail skipped=${#skipped[@]} failed=$failed_list skipped_list=$skipped_list duration_s=$duration_s"

if (( fail > 0 )); then
  now_ms=$(( $(date +%s) * 1000 ))
  if nudge_due "$now_ms"; then
    append_nudge "NUDGE full-suite pass=$pass fail=$fail failed=$failed_list"
    record_nudge "$now_ms"
  fi
fi

(( fail == 0 ))
