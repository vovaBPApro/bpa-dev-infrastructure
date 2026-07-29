#!/usr/bin/env bash
# Exercise real workspace, durable-state, completion-guard, and land-gate rails.
set -u
set -o pipefail

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
lanes=${1:-10}
fail_setup_lane=${SOAK_FAIL_SETUP_LANE:-}

if ! [[ "$lanes" =~ ^[0-9]+$ ]] || [ "$lanes" -lt 3 ]; then
  echo "usage: soak/soak.sh [N >= 3]" >&2
  exit 2
fi
if [ -n "$fail_setup_lane" ] && { ! [[ "$fail_setup_lane" =~ ^[0-9]+$ ]] || [ "$fail_setup_lane" -lt 1 ] || [ "$fail_setup_lane" -gt "$lanes" ]; }; then
  echo "SOAK_FAIL_SETUP_LANE must name a lane between 1 and $lanes" >&2
  exit 2
fi

fixture=$(mktemp -d "${TMPDIR:-/tmp}/bpa-soak.XXXXXX")
report_file=${SOAK_REPORT_FILE:-"$fixture/soak-report.md"}
mkdir -p "$(dirname -- "$report_file")"
db="$fixture/state.db"
repo="$fixture/product"
origin="$fixture/product-origin.git"
worktrees="$fixture/worktrees"
reports="$fixture/lane-reports"
events="$fixture/events"
logs="$fixture/logs"
mkdir -p "$worktrees" "$reports" "$events" "$logs"

now_ms() { bun -e 'console.log(Date.now())'; }
elapsed_ms() { echo $(( $2 - $1 )); }
cli() { INFRA_STATE_DB="$db" bun "$root/core/mission-cli.ts" "$@"; }
cli_retry() {
  local attempt=0 output
  while [ "$attempt" -lt 20 ]; do
    attempt=$((attempt + 1))
    if output=$(cli "$@" 2>&1); then
      printf '%s\n' "$output"
      return 0
    fi
    sleep 0.05
  done
  printf '%s\n' "$output" >&2
  return 1
}
sql_count() {
  local query=$1
  bun -e "import { Database } from 'bun:sqlite'; const db = new Database(process.argv[1]); console.log(db.query(process.argv[2]).get().n); db.close();" "$db" "$query"
}
cleanup() {
  local wt branch
  for wt in "$worktrees"/*; do
    [ -e "$wt" ] || continue
    git -C "$repo" worktree remove --force "$wt" >/dev/null 2>&1 || true
  done
  git -C "$repo" worktree prune >/dev/null 2>&1 || true
  for branch in $(git -C "$repo" for-each-ref --format='%(refname:short)' 'refs/heads/ag-soak-*'); do
    git -C "$repo" branch -D "$branch" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

git init --bare --initial-branch=main "$origin" >/dev/null
git clone "$origin" "$repo" >/dev/null
git -C "$repo" config user.email soak@example.test
git -C "$repo" config user.name "Soak Harness"
mkdir -p "$repo/lanes"
printf 'base\n' > "$repo/README.txt"
for i in $(seq 1 "$lanes"); do
  printf 'lane-%s=0\n' "$i"
  # Keep independent counter edits outside Git's default three-line merge hunk.
  printf 'padding-%s\n' "$i"; printf 'padding-%s\n' "$i"; printf 'padding-%s\n' "$i"; printf 'padding-%s\n' "$i"
done > "$repo/shared-counter.txt"
git -C "$repo" add README.txt shared-counter.txt
git -C "$repo" commit -m '[ORCH] seed soak fixture' >/dev/null
git -C "$repo" push -u origin main >/dev/null

started=$(now_ms)
mission_id=$(cli mission create "soak-$(date +%s)-$$" | sed -n 's/^MISSION id=\([^ ]*\).*/\1/p')
[ -n "$mission_id" ] || { echo 'failed to create soak mission' >&2; exit 1; }
cli mission transition "$mission_id" running >/dev/null
for i in $(seq 1 "$lanes"); do cli lane create "$mission_id" "soak-$i" >/dev/null; done
rows_before="missions=$(sql_count 'SELECT COUNT(*) AS n FROM missions') lanes=$(sql_count 'SELECT COUNT(*) AS n FROM lanes') leases=$(sql_count 'SELECT COUNT(*) AS n FROM leases')"

worker() {
  local i=$1 branch="ag-soak-$1" wt="$worktrees/$1" owner="worker-$1" token sha started_at ended_at mode
  end_worker() { now_ms > "$events/$i.end"; }
  started_at=$(now_ms)
  printf '%s\n' "$started_at" > "$events/$i.start"
  if ! cli_retry lane transition "soak-$i" running >"$logs/$i.state.log"; then end_worker; return 1; fi
  token=$(cli_retry lease acquire "$owner" "soak/lane/$i" 30000 | sed -n 's/.*token=\([0-9][0-9]*\).*/\1/p')
  if [ -z "$token" ]; then
    printf 'worker lease acquire failed\n' > "$logs/$i.worker.log"
    end_worker; return 1
  fi
  mkdir -p "$wt/lanes"
  printf 'lane %s deterministic worker\n' "$i" > "$wt/lanes/lane-$i.txt"
  sed -i "s/^lane-$i=0$/lane-$i=1/" "$wt/shared-counter.txt"
  if [ "$i" -eq 1 ]; then
    # Generated only in the disposable fixture; never appears in this repository.
    prefix=gh
    prefix="${prefix}p_"
    printf '%s\n' "${prefix}""$(printf 'x%.0s' $(seq 1 36))" > "$wt/lanes/planted-secret.txt"
    mode=secret
  elif [ "$i" -eq 2 ]; then
    mode=malformed-report
  else
    mode=good
  fi
  git -C "$wt" add lanes "shared-counter.txt"
  git -C "$wt" commit -m "[CODER] soak lane $i" >/dev/null
  sha=$(git -C "$wt" rev-parse HEAD)
  if [ "$mode" = good ] || [ "$mode" = secret ]; then
    printf 'commit: %s [CODER] soak lane %s\nverify: test -f lanes/lane-%s.txt\nresult: clean\nsecret-scan: clean\nremaining: none\n' "$sha" "$i" "$i" > "$reports/$i.md"
  else
    printf 'commit: %s [CODER] soak lane %s\nresult: clean\n' "$sha" "$i" > "$reports/$i.md"
  fi
  if ! cli_retry lease release "$owner" "soak/lane/$i" "$token" >>"$logs/$i.state.log"; then end_worker; return 1; fi
  ended_at=$(now_ms)
  printf '%s\n' "$ended_at" > "$events/$i.end"
}

# Git updates the shared $GIT_DIR/worktrees administration directory while
# adding a worktree. Keep this small setup phase serial; workers stay parallel.
setup_failed=0
for i in $(seq 1 "$lanes"); do
  wt="$worktrees/$i"
  branch="ag-soak-$i"
  if [ "$i" = "$fail_setup_lane" ]; then
    mkdir -p "$wt"
    printf 'intentional setup blocker\n' > "$wt/.soak-setup-blocker"
  fi
  if ! git -C "$repo" worktree add -b "$branch" "$wt" main >"$logs/$i.setup.log" 2>&1 \
    || [ "$(git -C "$wt" rev-parse --is-inside-work-tree 2>/dev/null || true)" != true ] \
    || [ ! -f "$wt/shared-counter.txt" ]; then
    printf 'setup-failure|worktree-add-or-validation\n' > "$events/$i.verdict"
    now_ms > "$events/$i.start"
    cp "$events/$i.start" "$events/$i.end"
    cli lane transition "soak-$i" failed >>"$logs/$i.state.log" 2>&1 || true
    # A failed add can leave an unregistered directory, so remove both Git's
    # registration (if any) and the known disposable fixture target.
    git -C "$repo" worktree remove --force "$wt" >/dev/null 2>&1 || true
    rm -rf -- "$wt"
    git -C "$repo" worktree prune >/dev/null 2>&1 || true
    git -C "$repo" branch -D "$branch" >/dev/null 2>&1 || true
    setup_failed=$((setup_failed + 1))
  fi
done

coding_started=$(now_ms)
pids=""
for i in $(seq 1 "$lanes"); do
  if [ -f "$events/$i.verdict" ]; then
    continue
  fi
  worker "$i" &
  pids="$pids $!"
done
workers_ok=true
for pid in $pids; do wait "$pid" || workers_ok=false; done
coding_ended=$(now_ms)

landing_started=$(now_ms)
for i in $(seq 1 "$lanes"); do
  if [ -f "$events/$i.verdict" ]; then
    continue
  fi
  branch="ag-soak-$i"
  output="$logs/$i.land.log"
  max_land_attempts=$((lanes + 2))
  land_attempt=1
  landed_lane=false
  while [ "$land_attempt" -le "$max_land_attempts" ]; do
    printf 'LAND retry lane=%s attempt=%s/%s action=gate\n' "$i" "$land_attempt" "$max_land_attempts" >>"$output"
    if "$root/gate/land.sh" --branch "$branch" --report "$reports/$i.md" --repo "$repo" --worktree "$worktrees/$i" --no-push >>"$output" 2>&1; then
      sha=$(sed -n 's/^LAND verdict=landed sha=\([^ ]*\).*/\1/p' "$output" | tail -n 1)
      printf 'landed|%s\n' "$sha" > "$events/$i.verdict"
      cli lane transition "soak-$i" succeeded >>"$logs/$i.state.log"
      landed_lane=true
      break
    fi
    reason=$(sed -n 's/^LAND step=\([^ ]*\) status=fail.*/\1/p' "$output" | tail -n 1)
    if [ "$reason" != freshness ] || [ "$land_attempt" -eq "$max_land_attempts" ]; then
      [ -n "$reason" ] || reason=gate-refusal
      printf 'refused|%s\n' "$reason" > "$events/$i.verdict"
      # These lanes exercise expected gate refusals. The worker completed its
      # assigned adversarial assertion successfully, so it is not a failed
      # mission child; the refusal remains explicit in the soak evidence.
      cli lane transition "soak-$i" succeeded >>"$logs/$i.state.log"
      break
    fi
    printf 'LAND retry lane=%s attempt=%s/%s action=rebase-main reason=freshness\n' "$i" "$land_attempt" "$max_land_attempts" >>"$output"
    # --no-push leaves the prior serialized landing local. Publish only the
    # disposable fixture main before retrying, matching a real pushed landing.
    if ! git -C "$repo" push origin main >>"$output" 2>&1; then
      printf 'refused|fixture-sync\n' > "$events/$i.verdict"
      cli lane transition "soak-$i" failed >>"$logs/$i.state.log"
      break
    fi
    if ! git -C "$worktrees/$i" rebase main >>"$output" 2>&1; then
      git -C "$worktrees/$i" rebase --abort >/dev/null 2>&1 || true
      printf 'refused|merge-conflict\n' > "$events/$i.verdict"
      cli lane transition "soak-$i" failed >>"$logs/$i.state.log"
      break
    fi
    sha=$(git -C "$worktrees/$i" rev-parse HEAD)
    sed -i "1s/^commit: [^ ]*/commit: $sha/" "$reports/$i.md"
    land_attempt=$((land_attempt + 1))
  done
  if [ "$landed_lane" != true ]; then
    git -C "$repo" worktree remove --force "$worktrees/$i" >/dev/null 2>&1 || true
    git -C "$repo" branch -D "$branch" >/dev/null 2>&1 || true
  fi
done
landing_ended=$(now_ms)

max_concurrent=0
for point in $(cat "$events"/*.start "$events"/*.end | sort -n | uniq); do
  active=0
  for i in $(seq 1 "$lanes"); do
    [ "$(cat "$events/$i.start")" -le "$point" ] && [ "$(cat "$events/$i.end")" -ge "$point" ] && active=$((active + 1))
  done
  [ "$active" -gt "$max_concurrent" ] && max_concurrent=$active
done

git -C "$repo" worktree prune
leftover_worktrees=$(find "$worktrees" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')
leftover_branches=$(git -C "$repo" for-each-ref --format='%(refname)' 'refs/heads/ag-soak-*' | wc -l | tr -d ' ')
leftover_processes=0
for pid in $pids; do
  if kill -0 "$pid" 2>/dev/null; then leftover_processes=$((leftover_processes + 1)); fi
done
rows_after="missions=$(sql_count 'SELECT COUNT(*) AS n FROM missions') lanes=$(sql_count 'SELECT COUNT(*) AS n FROM lanes') leases=$(sql_count 'SELECT COUNT(*) AS n FROM leases') active_leases=$(sql_count 'SELECT COUNT(*) AS n FROM leases WHERE released_at IS NULL')"
good_expected=$((lanes - 2))
landed=$(grep -l '^landed|' "$events"/*.verdict | wc -l | tr -d ' ')
secret_refused=$(grep -c '^refused|secret-scan$' "$events/1.verdict" || true)
malformed_refused=$(grep -c '^refused|completion-guard$' "$events/2.verdict" || true)
overall=PASS
if [ "$workers_ok" != true ] || [ "$setup_failed" -ne 0 ] || [ "$landed" -ne "$good_expected" ] || [ "$secret_refused" -ne 1 ] || [ "$malformed_refused" -ne 1 ] || [ "$max_concurrent" -lt 2 ] || [ "$leftover_worktrees" -ne 0 ] || [ "$leftover_branches" -ne 0 ] || [ "$leftover_processes" -ne 0 ]; then overall=FAIL; fi
mission_state=succeeded
[ "$overall" = PASS ] || mission_state=failed
if ! cli mission transition "$mission_id" "$mission_state" >/dev/null; then
  echo "failed to persist terminal mission state: $mission_state" >&2
  overall=FAIL
fi
ended=$(now_ms)

{
  echo '# Soak evidence report'
  echo
  echo "fixture: $fixture"
  echo "lanes: $lanes (good=$good_expected, adversarial=2)"
  echo "review-policy: not required; fixture paths only change lanes/ and shared-counter.txt, outside gate/review-policy.conf prefixes"
  echo
  echo '| lane | worker ms | verdict | evidence |'
  echo '| --- | ---: | --- | --- |'
  for i in $(seq 1 "$lanes"); do
    worker_ms=$(elapsed_ms "$(cat "$events/$i.start")" "$(cat "$events/$i.end")")
    IFS='|' read -r verdict detail < "$events/$i.verdict"
    echo "| $i | $worker_ms | $verdict | $detail |"
  done
  echo
  echo "phases: setup+state=$(elapsed_ms "$started" "$coding_started")ms coding=$(elapsed_ms "$coding_started" "$coding_ended")ms landing=$(elapsed_ms "$landing_started" "$landing_ended")ms total=$(elapsed_ms "$started" "$ended")ms"
  echo "parallelism: max-concurrent-lanes=$max_concurrent (overlapping worker start/end timestamps)"
  echo "state rows before: $rows_before"
  echo "state rows after: $rows_after"
  echo "cleanup: worktrees=$leftover_worktrees branches=$leftover_branches processes=$leftover_processes"
  echo "overall: $overall"
} | tee "$report_file"

[ "$overall" = PASS ]
