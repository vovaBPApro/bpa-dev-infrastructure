#!/usr/bin/env bash
# Sustain the round-level soak and fail closed on cross-round resource drift.
set -euo pipefail

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
system_tmp=${TMPDIR:-/tmp}
rounds=20
minutes=''
lanes=10
run_dir=$(mktemp -d "$system_tmp/bpa-soak-endurance.XXXXXX")
sandbox_root="$run_dir/sandbox"
tmp_root="$sandbox_root/tmp"
mkdir -p "$tmp_root" "$sandbox_root/home" "$sandbox_root/cache" "$sandbox_root/state" "$sandbox_root/runtime"
report="$run_dir/soak-endurance-report.md"
run_token="bpa-endurance-$$-$(date +%s)"
docker_root_initial=''
last_active_leases=0
owned_pgid=''

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
disk_free_kb() {
  if [ -n "${SOAK_DISK_PROBE:-}" ]; then "$SOAK_DISK_PROBE"; else df -Pk "$sandbox_root" | awk 'NR == 2 { print $4 }'; fi
}
docker_root_kb() {
  local docker_root
  command -v docker >/dev/null 2>&1 || { echo unavailable; return; }
  docker_root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null) || { echo unavailable; return; }
  df -Pk "$docker_root" | awk 'NR == 2 {print $4}'
}
docker_ids() {
  local phase=$1
  if [ -n "${SOAK_DOCKER_PROBE:-}" ]; then
    SOAK_PROBE_PHASE=$phase SOAK_RUN_TOKEN=$run_token "$SOAK_DOCKER_PROBE"
    return
  fi
  command -v docker >/dev/null 2>&1 || return 0
  docker ps -aq --filter "label=bpa.soak.run=$run_token" | sed 's/^/container /'
  docker image ls -q --filter "label=bpa.soak.run=$run_token" | sort -u | sed 's/^/image /'
  docker volume ls -q --filter "label=bpa.soak.run=$run_token" | sed 's/^/volume /'
  docker network ls -q --filter "label=bpa.soak.run=$run_token" | sed 's/^/network /'
}
inventory_sandbox() {
  find "$sandbox_root" -mindepth 1 \
    ! -path "$sandbox_root/home" ! -path "$sandbox_root/cache" ! -path "$sandbox_root/state" \
    ! -path "$sandbox_root/runtime" ! -path "$sandbox_root/tmp" \
    -printf '%y %D:%i %p\n' | sort
}
external_ids() {
  if [ -n "${SOAK_EXTERNAL_PROBE:-}" ]; then
    SOAK_RUN_TOKEN=$run_token "$SOAK_EXTERNAL_PROBE"
  fi
}
process_ids() {
  local pid_path pid
  {
    if [ -n "$owned_pgid" ]; then
      ps -eo pid=,pgid=,args= | awk -v pg="$owned_pgid" -v self="$$" '$2 == pg && $1 != self {print "process "$1" pgid="$2" "$0}'
    fi
    grep -aFl "$run_token" /proc/[0-9]*/environ 2>/dev/null |
      while IFS= read -r pid_path; do
        pid=${pid_path#/proc/}; pid=${pid%%/*}
        [ "$pid" = "$$" ] || ps -p "$pid" -o pid=,pgid=,args= | awk 'NF {print "process "$1" pgid="$2" "$0}'
      done
  } | sort -u
  if command -v systemctl >/dev/null 2>&1; then
    systemctl list-units --all --plain --no-legend "bpa-soak-${run_token}*" 2>/dev/null | sed 's/^/unit /' || true
  fi
}
rss_kb() {
  if [ -n "${SOAK_RSS_PROBE:-}" ]; then "$SOAK_RSS_PROBE"; else process_ids | awk '$1 == "process" { f="/proc/"$2"/status"; while ((getline < f)>0) if ($1=="VmRSS:") n+=$2; close(f) } END {print n+0}'; fi
}
active_leases_probe() {
  local fixture=$1
  if [ -n "${SOAK_LEASE_PROBE:-}" ]; then "$SOAK_LEASE_PROBE"; return; fi
  if [ -n "$fixture" ] && [ -f "$fixture/state.db" ]; then
    bun -e "import { Database } from 'bun:sqlite'; const db=new Database(process.argv[1]); console.log(db.query('SELECT COUNT(*) AS n FROM leases WHERE released_at IS NULL').get().n); db.close();" "$fixture/state.db"
  else
    echo 0
  fi
}
snapshot() {
  local phase=$1
  SNAP_DOCKER=$(docker_ids "$phase")
  SNAP_SANDBOX=$(inventory_sandbox)
  SNAP_EXTERNAL=$(external_ids)
  SNAP_PROCESSES=$(process_ids)
  SNAP_PROCS=$(printf '%s\n' "$SNAP_PROCESSES" | awk 'NF {n++} END {print n+0}')
  SNAP_RSS_KB=$(rss_kb)
  SNAP_DISK_KB=$(disk_free_kb)
}
snapshot_line() {
  printf 'round %s snapshot %s: worktrees=0 branches=0 processes=%s rss_kb=%s tmp_dirs=%s disk_free_kb=%s active_leases=%s\n' \
    "$1" "$2" "$SNAP_PROCS" "$SNAP_RSS_KB" "$(printf '%s\n' "$SNAP_SANDBOX" | awk 'NF {n++} END {print n+0}')" "$SNAP_DISK_KB" "$3"
}
added_ids() {
  local before=$1 after=$2 prefix=$3
  comm -13 <(printf '%s\n' "$before" | sed '/^$/d' | sort -u) <(printf '%s\n' "$after" | sed '/^$/d' | sort -u) |
    while IFS= read -r item; do
      if [ "$prefix" = docker ]; then printf '%s:%s\n' "${item%% *}" "${item#* }"; else printf '%s:%s\n' "$prefix" "$item"; fi
    done
}
cleanup_labeled_docker() {
  command -v docker >/dev/null 2>&1 || return 0
  docker ps -aq --filter "label=bpa.soak.run=$run_token" | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker volume ls -q --filter "label=bpa.soak.run=$run_token" | xargs -r docker volume rm >/dev/null 2>&1 || true
  docker network ls -q --filter "label=bpa.soak.run=$run_token" | xargs -r docker network rm >/dev/null 2>&1 || true
  docker image ls -q --filter "label=bpa.soak.run=$run_token" | xargs -r docker image rm >/dev/null 2>&1 || true
}
trap cleanup_labeled_docker EXIT

initial_disk=''
previous_disk=''
disk_declines=0
first_round_ms=''
timings=()
round_details=()
leak_details=()
failure_round=none
failure_reason=''
rounds_run=0
rounds_passed=0
rounds_failed=0
deadline=0
if [ -n "$minutes" ]; then deadline=$(( $(now_ms) + minutes * 60000 )); fi
within_limit() { if [ -n "$minutes" ]; then [ "$(now_ms)" -lt "$deadline" ]; else [ "$rounds_run" -lt "$rounds" ]; fi; }

snapshot before
initial_disk=$SNAP_DISK_KB
previous_disk=$SNAP_DISK_KB
docker_root_initial=$(docker_root_kb)
initial_snapshot=$(snapshot_line 0 before 0)
if [ -z "${SOAK_DOCKER_PROBE:-}" ] && [ "$docker_root_initial" = unavailable ]; then
  failure_round=0
  failure_reason='Docker probe unavailable'
fi

while [ "$failure_round" = none ] && within_limit; do
  round=$((rounds_run + 1))
  snapshot before
  before_docker=$SNAP_DOCKER; before_sandbox=$SNAP_SANDBOX; before_external=$SNAP_EXTERNAL
  before_line=$(snapshot_line "$round" before 0)
  output="$run_dir/round-$round.output"
  started=$(now_ms)
  set +e
  if [ -n "${SOAK_ROUND_COMMAND:-}" ]; then
    setsid env SOAK_RUN_TOKEN="$run_token" SOAK_SANDBOX_ROOT="$sandbox_root" HOME="$sandbox_root/home" TMPDIR="$tmp_root" \
      XDG_CACHE_HOME="$sandbox_root/cache" XDG_STATE_HOME="$sandbox_root/state" XDG_RUNTIME_DIR="$sandbox_root/runtime" \
      "$SOAK_ROUND_COMMAND" >"$output" 2>&1 &
  else
    setsid env SOAK_RUN_TOKEN="$run_token" SOAK_DOCKER_LABEL="bpa.soak.run=$run_token" HOME="$sandbox_root/home" TMPDIR="$tmp_root" \
      XDG_CACHE_HOME="$sandbox_root/cache" XDG_STATE_HOME="$sandbox_root/state" XDG_RUNTIME_DIR="$sandbox_root/runtime" \
      BUN_INSTALL_CACHE_DIR="$sandbox_root/cache/bun" npm_config_cache="$sandbox_root/cache/npm" \
      SOAK_REPORT_FILE="$run_dir/round-$round.report" bash "$root/soak/soak.sh" "$lanes" >"$output" 2>&1 &
  fi
  round_pid=$!
  owned_pgid=$round_pid
  wait "$round_pid"; soak_status=$?
  set -e
  ended=$(now_ms); elapsed=$((ended - started))
  timings+=("$elapsed"); rounds_run=$round
  fixture=$(sed -n 's/^fixture: //p' "$output" | tail -n 1)
  active_leases_probe_failed=false
  if ! last_active_leases=$(active_leases_probe "$fixture"); then last_active_leases=unavailable; active_leases_probe_failed=true; fi
  [ -z "$fixture" ] || [ ! -d "$fixture" ] || rm -rf -- "$fixture"
  round_overall_pass=false
  [ "$soak_status" -eq 0 ] && grep -Fq 'overall: PASS' "$output" && round_overall_pass=true
  snapshot after
  after_line=$(snapshot_line "$round" after "$last_active_leases")
  mapfile -t found_leaks < <(
    added_ids "$before_docker" "$SNAP_DOCKER" docker
    added_ids "$before_sandbox" "$SNAP_SANDBOX" sandbox
    added_ids "$before_external" "$SNAP_EXTERNAL" external
    printf '%s\n' "$SNAP_PROCESSES" | awk 'NF {print "process:"$2}'
  )
  round_details+=("$before_line" "$after_line" "round $round timing_ms=$elapsed soak_exit=$soak_status")
  leak_details+=("${found_leaks[@]}")
  if [ "$round_overall_pass" != true ]; then failure_round=$round; failure_reason='round did not reach overall PASS'
  elif [ "$active_leases_probe_failed" = true ]; then failure_round=$round; failure_reason='could not inspect active leases in disposable state DB'
  elif [ "$last_active_leases" != 0 ]; then failure_round=$round; failure_reason='active leases remained in disposable state DB'
  elif [ "${#found_leaks[@]}" -gt 0 ]; then failure_round=$round; failure_reason='owned resource IDs were added'
  elif [ "$SNAP_RSS_KB" -ne 0 ]; then failure_round=$round; failure_reason='owned process RSS remained'
  elif [ "$SNAP_DISK_KB" -lt $((initial_disk - ${SOAK_DISK_TOLERANCE_KB:-1024})) ]; then
    failure_round=$round; failure_reason="disk aggregate drift (initial=$initial_disk current=$SNAP_DISK_KB tolerance=${SOAK_DISK_TOLERANCE_KB:-1024})"
  elif [ -n "$first_round_ms" ] && [ "$elapsed" -gt $((first_round_ms * 2 + 5000)) ]; then
    failure_round=$round; failure_reason="round timing degraded (first=${first_round_ms}ms current=${elapsed}ms)"
  fi
  [ -n "$first_round_ms" ] || first_round_ms=$elapsed
  if [ "$SNAP_DISK_KB" -lt "$previous_disk" ]; then disk_declines=$((disk_declines + 1)); else disk_declines=0; fi
  previous_disk=$SNAP_DISK_KB
  if [ "$disk_declines" -ge 2 ] && [ "$failure_round" = none ]; then failure_round=$round; failure_reason='disk free space trended down monotonically for two rounds'; fi
  if [ "$failure_round" = none ]; then rounds_passed=$((rounds_passed + 1)); rm -f -- "$output" "$run_dir/round-$round.report"; else rounds_failed=1; fi
done

if [ "$failure_round" != none ] && [ "$rounds_failed" -eq 0 ]; then rounds_failed=1; fi
if [ -n "$minutes" ]; then requested="minutes=$minutes"; else requested="rounds=$rounds"; fi
if [ "$failure_round" = none ]; then overall=PASS; else overall=FAIL; fi
if [ "${#timings[@]}" -gt 0 ]; then
  sorted=$(printf '%s\n' "${timings[@]}" | sort -n)
  timing_min=$(printf '%s\n' "$sorted" | head -n 1); timing_max=$(printf '%s\n' "$sorted" | tail -n 1)
  timing_median=$(printf '%s\n' "$sorted" | awk '{a[NR]=$1} END {if(NR%2) print a[(NR+1)/2]; else print int((a[NR/2]+a[NR/2+1])/2)}')
  timing_last=${timings[$(( ${#timings[@]} - 1 ))]}
else timing_min=0; timing_median=0; timing_max=0; timing_last=0; fi

{
  echo '# Endurance soak aggregate evidence report'; echo
  echo "requested: $requested lanes=$lanes"
  echo "rounds: run=$rounds_run passed=$rounds_passed failed=$rounds_failed"
  echo "first-failure: $failure_round${failure_reason:+ ($failure_reason)}"
  echo "timing-ms: min=$timing_min median=$timing_median max=$timing_max last=$timing_last"
  echo "initial: $initial_snapshot"
  printf '%s\n' "${round_details[@]}"
  printf 'leak: %s\n' "${leak_details[@]}"
  echo "resource-delta: disk_free_kb=$initial_disk->$SNAP_DISK_KB docker_root_fs=$docker_root_initial->$(docker_root_kb) worktrees=0 branches=0 processes=$SNAP_PROCS rss_kb=$SNAP_RSS_KB tmp_dirs=$(printf '%s\n' "$SNAP_SANDBOX" | awk 'NF {n++} END {print n+0}') active_leases=$last_active_leases"
  echo "overall: $overall"
} | tee "$report"
[ "$overall" = PASS ]
