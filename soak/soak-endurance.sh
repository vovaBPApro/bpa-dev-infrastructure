#!/usr/bin/env bash
# Sustain the round-level soak and fail closed on cross-round resource drift.
set -euo pipefail

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
system_tmp=${TMPDIR:-/tmp}
rounds=20
minutes=''
lanes=10
run_dir=$(mktemp -d "$system_tmp/bpa-soak-endurance.XXXXXX")
tmp_root="$run_dir/tmp"
mkdir -p "$tmp_root"
report="$run_dir/soak-endurance-report.md"

usage() {
  echo 'usage: soak/soak-endurance.sh [--rounds R | --minutes M] [--lanes N] [--report FILE]' >&2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --rounds) rounds=${2:-}; minutes=''; shift 2 ;;
    --minutes) minutes=${2:-}; shift 2 ;;
    --lanes) lanes=${2:-}; shift 2 ;;
    --report) report=${2:-}; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
done

if ! [[ "$lanes" =~ ^[0-9]+$ ]] || [ "$lanes" -lt 3 ] || { [ -n "$minutes" ] && ! [[ "$minutes" =~ ^[0-9]+$ ]]; } || { [ -z "$minutes" ] && { ! [[ "$rounds" =~ ^[0-9]+$ ]] || [ "$rounds" -lt 1 ]; }; } || { [ -n "$minutes" ] && [ "$minutes" -lt 1 ]; }; then
  usage
  exit 2
fi
mkdir -p "$(dirname -- "$report")"

now_ms() { bun -e 'console.log(Date.now())'; }
count_tmp_dirs() { find "$tmp_root" -mindepth 1 -maxdepth 1 -type d -name 'bpa-soak.*' -print | wc -l | tr -d ' '; }
count_worktrees() {
  local fixture total=0 n
  while IFS= read -r fixture; do
    [ -d "$fixture/worktrees" ] || continue
    n=$(find "$fixture/worktrees" -mindepth 1 -maxdepth 1 -type d -print | wc -l | tr -d ' ')
    total=$((total + n))
  done < <(find "$tmp_root" -mindepth 1 -maxdepth 1 -type d -name 'bpa-soak.*' -print)
  echo "$total"
}
count_branches() {
  local fixture total=0 n
  while IFS= read -r fixture; do
    [ -d "$fixture/product/.git" ] || continue
    n=$(git -C "$fixture/product" for-each-ref --format='%(refname)' 'refs/heads/ag-soak-*' 2>/dev/null | wc -l | tr -d ' ')
    total=$((total + n))
  done < <(find "$tmp_root" -mindepth 1 -maxdepth 1 -type d -name 'bpa-soak.*' -print)
  echo "$total"
}
process_stats() {
  ps -eo comm=,rss=,args= | awk '$1 ~ /^(bun|git)$/ && $0 ~ /bpa-soak\./ { count += 1; rss += $2 } END { print count + 0, rss + 0 }'
}
disk_free_kb() { df -Pk "$tmp_root" | awk 'NR == 2 { print $4 }'; }
snapshot() {
  local stats
  stats=$(process_stats)
  SNAP_WORKTREES=$(count_worktrees)
  SNAP_BRANCHES=$(count_branches)
  SNAP_TMP_DIRS=$(count_tmp_dirs)
  SNAP_PROCS=${stats%% *}
  SNAP_RSS_KB=${stats##* }
  SNAP_DISK_KB=$(disk_free_kb)
}
settled_snapshot() {
  local attempt=0
  snapshot
  # A shell can return just ahead of a final Git/Bun child reaping. Give only
  # fixture-associated children a bounded one-second grace, then assert zero.
  while [ "$SNAP_PROCS" -ne 0 ] && [ "$attempt" -lt 10 ]; do
    sleep 0.1
    attempt=$((attempt + 1))
    snapshot
  done
}
snapshot_line() {
  printf 'round %s snapshot %s: worktrees=%s branches=%s processes=%s rss_kb=%s tmp_dirs=%s disk_free_kb=%s active_leases=%s\n' \
    "$1" "$2" "$SNAP_WORKTREES" "$SNAP_BRANCHES" "$SNAP_PROCS" "$SNAP_RSS_KB" "$SNAP_TMP_DIRS" "$SNAP_DISK_KB" "$3"
}
cleanup_fixture() {
  local fixture=$1
  [ -n "$fixture" ] && [ -d "$fixture" ] && rm -rf -- "$fixture"
}

initial_disk=''
previous_disk=''
disk_declines=0
first_round_ms=''
timings=()
round_details=()
failure_round='none'
failure_reason=''
rounds_run=0
rounds_passed=0
rounds_failed=0
deadline=0
if [ -n "$minutes" ]; then deadline=$(( $(now_ms) + minutes * 60000 )); fi
within_limit() {
  if [ -n "$minutes" ]; then
    [ "$(now_ms)" -lt "$deadline" ]
  else
    [ "$rounds_run" -lt "$rounds" ]
  fi
}

settled_snapshot
initial_disk=$SNAP_DISK_KB
previous_disk=$SNAP_DISK_KB
initial_snapshot=$(snapshot_line 0 before 0)
if [ "$SNAP_WORKTREES" -ne 0 ] || [ "$SNAP_BRANCHES" -ne 0 ] || [ "$SNAP_PROCS" -ne 0 ] || [ "$SNAP_TMP_DIRS" -ne 0 ]; then
  failure_round=0
  failure_reason='pre-existing soak resources'
fi

while [ "$failure_round" = none ] && within_limit; do
  round=$((rounds_run + 1))
  settled_snapshot
  before_line=$(snapshot_line "$round" before 0)
  if [ "$SNAP_WORKTREES" -ne 0 ] || [ "$SNAP_BRANCHES" -ne 0 ] || [ "$SNAP_PROCS" -ne 0 ] || [ "$SNAP_TMP_DIRS" -ne 0 ]; then
    failure_round=$round
    failure_reason='resources present before round'
    round_details+=("$before_line")
    break
  fi

  output="$run_dir/round-$round.output"
  started=$(now_ms)
  set +e
  TMPDIR="$tmp_root" SOAK_REPORT_FILE="$run_dir/round-$round.report" bash "$root/soak/soak.sh" "$lanes" >"$output" 2>&1
  soak_status=$?
  set -e
  ended=$(now_ms)
  elapsed=$((ended - started))
  timings+=("$elapsed")
  rounds_run=$round
  fixture=$(sed -n 's/^fixture: //p' "$output" | tail -n 1)
  active_leases='unavailable'
  if [ -n "$fixture" ] && [ -f "$fixture/state.db" ]; then
    active_leases=$(bun -e "import { Database } from 'bun:sqlite'; const db = new Database(process.argv[1]); console.log(db.query('SELECT COUNT(*) AS n FROM leases WHERE released_at IS NULL').get().n); db.close();" "$fixture/state.db")
  fi
  cleanup_fixture "$fixture"
  round_overall_pass=false
  if [ "$soak_status" -eq 0 ] && grep -Fq 'overall: PASS' "$output"; then round_overall_pass=true; fi
  # Successful round logs are summarized below; retaining them would itself
  # create a tiny artificial downward df trend across a long endurance run.
  if [ "$round_overall_pass" = true ]; then
    rm -f -- "$output" "$run_dir/round-$round.report"
  fi
  settled_snapshot
  after_line=$(snapshot_line "$round" after "$active_leases")
  round_details+=("$before_line" "$after_line" "round $round timing_ms=$elapsed soak_exit=$soak_status")

  if [ "$round_overall_pass" != true ]; then
    failure_round=$round
    failure_reason='round did not reach overall PASS'
  elif [ "$active_leases" != 0 ]; then
    failure_round=$round
    failure_reason='active leases remained in disposable state DB'
  elif [ "$SNAP_WORKTREES" -ne 0 ] || [ "$SNAP_BRANCHES" -ne 0 ] || [ "$SNAP_PROCS" -ne 0 ] || [ "$SNAP_TMP_DIRS" -ne 0 ]; then
    failure_round=$round
    failure_reason='cross-round cleanup resource remained'
  elif [ -n "$first_round_ms" ] && [ "$elapsed" -gt $((first_round_ms * 2 + 5000)) ]; then
    failure_round=$round
    failure_reason="round timing degraded (first=${first_round_ms}ms current=${elapsed}ms)"
  fi
  if [ -z "$first_round_ms" ]; then first_round_ms=$elapsed; fi
  # Ignore one filesystem allocation unit; report/log metadata is not a leak.
  if [ "$SNAP_DISK_KB" -lt $((previous_disk - 1024)) ]; then disk_declines=$((disk_declines + 1)); else disk_declines=0; fi
  previous_disk=$SNAP_DISK_KB
  if [ "$disk_declines" -ge 2 ]; then
    failure_round=$round
    failure_reason='disk free space trended down monotonically for two rounds'
  fi
  if [ "$failure_round" = none ]; then rounds_passed=$((rounds_passed + 1)); else rounds_failed=1; fi
done

if [ "$failure_round" != none ] && [ "$rounds_failed" -eq 0 ]; then rounds_failed=1; fi
if [ -n "$minutes" ]; then requested="minutes=$minutes"; else requested="rounds=$rounds"; fi
if [ "$failure_round" = none ]; then overall=PASS; else overall=FAIL; fi
if [ "${#timings[@]}" -gt 0 ]; then
  sorted=$(printf '%s\n' "${timings[@]}" | sort -n)
  timing_min=$(printf '%s\n' "$sorted" | head -n 1)
  timing_max=$(printf '%s\n' "$sorted" | tail -n 1)
  timing_median=$(printf '%s\n' "$sorted" | awk '{ a[NR] = $1 } END { if (NR % 2) print a[(NR + 1) / 2]; else print int((a[NR / 2] + a[NR / 2 + 1]) / 2) }')
  timing_last=${timings[$(( ${#timings[@]} - 1 ))]}
else
  timing_min=0; timing_median=0; timing_max=0; timing_last=0
fi

{
  echo '# Endurance soak aggregate evidence report'
  echo
  echo "requested: $requested lanes=$lanes"
  echo "rounds: run=$rounds_run passed=$rounds_passed failed=$rounds_failed"
  echo "first-failure: $failure_round${failure_reason:+ ($failure_reason)}"
  echo "timing-ms: min=$timing_min median=$timing_median max=$timing_max last=$timing_last"
  echo "initial: $initial_snapshot"
  printf '%s\n' "${round_details[@]}"
  echo "resource-delta: disk_free_kb=$initial_disk->$SNAP_DISK_KB worktrees=$SNAP_WORKTREES branches=$SNAP_BRANCHES processes=$SNAP_PROCS rss_kb=$SNAP_RSS_KB tmp_dirs=$SNAP_TMP_DIRS active_leases=0"
  if [ "$failure_round" != none ] && [ -f "$run_dir/round-$failure_round.output" ]; then
    echo
    echo "## Captured output for failed round $failure_round"
    sed -n '1,260p' "$run_dir/round-$failure_round.output"
  fi
  echo "overall: $overall"
} | tee "$report"

[ "$overall" = PASS ]
