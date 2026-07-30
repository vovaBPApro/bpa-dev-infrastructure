#!/usr/bin/env bash
# Launch the endurance soak as a durable system unit.
set -euo pipefail

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
unit=soak-endurance
minutes=720
rounds=''
lanes=10
report=''
round_timeout_seconds=3600
dry_run=${SOAK_LAUNCH_DRY_RUN:-0}

usage() {
  echo 'usage: soak/launch-endurance.sh [--unit NAME] [--minutes M | --rounds R] [--lanes N] [--report FILE] [--round-timeout SECONDS] [--dry-run]' >&2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --unit) unit=${2:-}; shift 2 ;;
    --minutes) minutes=${2:-}; rounds=''; shift 2 ;;
    --rounds) rounds=${2:-}; minutes=''; shift 2 ;;
    --lanes) lanes=${2:-}; shift 2 ;;
    --report) report=${2:-}; shift 2 ;;
    --round-timeout) round_timeout_seconds=${2:-}; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
done

if ! [[ "$unit" =~ ^[A-Za-z0-9][A-Za-z0-9_.@-]*$ ]] \
  || ! [[ "$lanes" =~ ^[0-9]+$ ]] || [ "$lanes" -lt 3 ] \
  || ! [[ "$round_timeout_seconds" =~ ^[0-9]+$ ]] || [ "$round_timeout_seconds" -lt 1 ] \
  || { [ -n "$minutes" ] && { ! [[ "$minutes" =~ ^[0-9]+$ ]] || [ "$minutes" -lt 1 ]; }; } \
  || { [ -n "$rounds" ] && { ! [[ "$rounds" =~ ^[0-9]+$ ]] || [ "$rounds" -lt 1 ]; }; } \
  || { [ -z "$minutes" ] && [ -z "$rounds" ]; } \
  || { [ "$dry_run" != 0 ] && [ "$dry_run" != 1 ]; }; then
  usage
  exit 2
fi

if ! command -v systemd-run >/dev/null 2>&1; then
  echo 'launch-endurance: systemd-run is required' >&2
  exit 1
fi
if ! command -v systemctl >/dev/null 2>&1; then
  echo 'launch-endurance: systemctl is required to guard against duplicate launches' >&2
  exit 1
fi
if systemctl is-active --quiet "$unit"; then
  echo "launch-endurance: unit '$unit' is already active; refusing duplicate launch" >&2
  exit 1
fi

[ -n "$report" ] || report="/root/$unit.report.md"
command=(systemd-run --collect --unit "$unit"
  "--setenv=SOAK_ROUND_TIMEOUT_SECONDS=$round_timeout_seconds"
  "--working-directory=$root"
  /bin/bash soak/soak-endurance.sh)
if [ -n "$minutes" ]; then
  command+=(--minutes "$minutes")
else
  command+=(--rounds "$rounds")
fi
command+=(--lanes "$lanes" --report "$report")

if [ "$dry_run" = 1 ]; then
  printf '%q ' "${command[@]}"
  printf '\n'
  exit 0
fi

exec "${command[@]}"
