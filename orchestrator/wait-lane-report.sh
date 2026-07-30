#!/usr/bin/env bash
# Bounded polling for a durable lane report; completion-guard remains authoritative.
set -euo pipefail

usage() {
  printf '%s\n' 'Usage: wait-lane-report.sh --report <file> --exit-file <file> --deadline-sec <n> [--poll-sec <n>]'
}

report=""
exit_file=""
deadline_sec=""
poll_sec="${ORCH_LANE_POLL_SECONDS:-15}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --report|--exit-file|--deadline-sec|--poll-sec)
      [[ $# -ge 2 && -n "$2" ]] || { usage >&2; exit 2; }
      case "$1" in
        --report) report="$2" ;;
        --exit-file) exit_file="$2" ;;
        --deadline-sec) deadline_sec="$2" ;;
        --poll-sec) poll_sec="$2" ;;
      esac
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
done

[[ -n "$report" && -n "$exit_file" && -n "$deadline_sec" ]] || { usage >&2; exit 2; }
[[ "$deadline_sec" =~ ^[0-9]+$ ]] || { usage >&2; exit 2; }
[[ "$poll_sec" =~ ^([0-9]+([.][0-9]+)?|[.][0-9]+)$ && -n "${poll_sec//[0.]/}" ]] ||
  { usage >&2; exit 2; }

report_shape_ok() {
  local label count
  [[ -f "$report" ]] || return 1
  for label in commit verify result secret-scan remaining; do
    count="$(grep -c "^$label:" "$report" 2>/dev/null || true)"
    [[ "$count" == 1 ]] || return 1
  done
}

started=$SECONDS
exit_seen=false
while true; do
  if report_shape_ok; then
    exit 0
  fi

  if [[ ! -e "$report" && -f "$exit_file" ]]; then
    if [[ "$exit_seen" == true ]]; then
      printf 'WAIT verdict=report-never-written report=%s exit-file=%s\n' "$report" "$exit_file" >&2
      exit 3
    fi
    exit_seen=true
    # A lane may write its report immediately after the wrapper records process
    # death. Always allow exactly one final poll, even at the outer deadline.
    sleep "$poll_sec"
    continue
  fi

  if (( SECONDS - started >= deadline_sec )); then
    if [[ -e "$report" ]]; then
      printf 'WAIT verdict=malformed-report report=%s\n' "$report" >&2
      exit 5
    fi
    printf 'WAIT verdict=deadline report=%s\n' "$report" >&2
    exit 4
  fi

  sleep "$poll_sec"
done
