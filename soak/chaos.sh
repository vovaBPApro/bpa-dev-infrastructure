#!/usr/bin/env bash
# Deterministic failure-injection evidence for the local landing control plane.
set -u
set -o pipefail

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
selected=${CHAOS_SCENARIOS:-all}
fixture=$(mktemp -d "${TMPDIR:-/tmp}/bpa-chaos.XXXXXX")
report_file=${CHAOS_REPORT_FILE:-"$fixture/chaos-report.md"}
mkdir -p "$(dirname -- "$report_file")" "$fixture/logs"
pass=0 fail=0 total=0

cleanup() { [ "${CHAOS_KEEP_FIXTURE:-false}" = true ] || rm -rf -- "$fixture"; }
trap cleanup EXIT

now_ms() { bun -e 'console.log(Date.now())'; }
cli() { INFRA_STATE_DB="$1" bun "$root/core/mission-cli.ts" "${@:2}"; }
say() { printf '%s\n' "$*" | tee -a "$report_file"; }
has() { grep -Fq -- "$2" "$1"; }
assert() { "$@" || return 1; }

# Names the predicate that failed so a FAIL line says which invariant broke
# instead of a bare assertion-failed that the next reader has to re-derive.
check() {
  local label=$1
  shift
  "$@" && return 0
  [ -n "${CHAOS_FAIL_REASON:-}" ] || CHAOS_FAIL_REASON=$label
  return 1
}

# Runs a command that a scenario deliberately SIGKILLs (the injected
# `verify: kill -9 "$PPID"`). The inner shell reaps the signal, so this shell
# never emits bash's bare "<pid> Killed" job notice -- which reads like an OOM
# or a supervisor kill and has already cost one investigation. The deliberate
# kill is reported as such, and an unexpected signal is reported plainly too.
crash_injected() {
  local label=$1 log=$2 status=0
  shift 2
  # The trailing `exit` keeps bash from exec-optimizing itself away, so the
  # inner shell survives to reap the signal and report it as a normal status.
  # $0 carries the log path so only the victim is redirected, not our report.
  # `exec 2>/dev/null` drops the inner shell's own job-status notice -- the
  # victim's stderr still reaches the log through its explicit `2>&1`.
  bash -c 'set -u; exec 2>/dev/null; "$@" >"$0" 2>&1; exit $?' "$log" "$@" || status=$?
  if [ "$status" -gt 128 ]; then
    say "CHAOS inject=$label signal=$((status - 128)) note=deliberate-crash-injection"
  else
    say "CHAOS inject=$label status=$status note=verifier-exited-without-crashing"
  fi
  return 0
}

want() { [ "$selected" = all ] || [[ ",$selected," == *",$1,"* ]]; }
run() {
  local name=$1 detail status=0
  want "$name" || return 0
  total=$((total + 1))
  CHAOS_FAIL_REASON=''
  "$name" || status=$?
  if [ "$status" -eq 0 ]; then
    detail=${CHAOS_DETAIL:-reaction-asserted}
    say "CHAOS scenario=$name verdict=PASS detail=$detail"
    pass=$((pass + 1))
  else
    # A scenario body that itself died on a signal must say so; signal deaths
    # are not assertion failures and must not be reported as if they were.
    if [ "$status" -gt 128 ]; then
      detail=${CHAOS_DETAIL:-killed-by-signal-$((status - 128))}
    else
      detail=${CHAOS_DETAIL:-${CHAOS_FAIL_REASON:-assertion-failed}}
    fi
    say "CHAOS scenario=$name verdict=FAIL detail=$detail"
    fail=$((fail + 1))
  fi
}

make_repo() {
  local name=$1 base origin
  base="$fixture/$name"
  origin="$fixture/$name-origin.git"
  git init --bare --initial-branch=main "$origin" >/dev/null
  git clone "file://$origin" "$base" >/dev/null 2>&1
  git -C "$base" config user.email chaos@example.test
  git -C "$base" config user.name 'Chaos Harness'
  printf 'base\n' > "$base/base.txt"
  git -C "$base" add base.txt && git -C "$base" commit -m '[ORCH] chaos base' >/dev/null
  git -C "$base" push -u origin main >/dev/null
  printf 'ref: refs/heads/main\n' > "$origin/HEAD"
  printf '%s\n' "$base"
}

lane() {
  local repo=$1 branch=$2 file=$3 value=$4
  git -C "$repo" checkout -qb "$branch" main
  mkdir -p "$(dirname -- "$repo/$file")"
  printf '%s\n' "$value" > "$repo/$file"
  git -C "$repo" add "$file" && git -C "$repo" commit -m "[CODER] $branch" >/dev/null
  git -C "$repo" checkout -q main
  git -C "$repo" rev-parse "$branch"
}
report() { printf 'commit: %s fixture\nverify: true\nresult: clean\nsecret-scan: clean\nremaining: none\n' "$2" > "$1"; }
origin_main() { git --git-dir="$(dirname -- "$1")/$(basename -- "$1")-origin.git" rev-parse main; }
no_merge_head() { ! git -C "$1" rev-parse --verify --quiet MERGE_HEAD >/dev/null; }
poll_reap() {
  local db=$1 deadline=$(( $(now_ms) + 3000 )) out
  while [ "$(now_ms)" -lt "$deadline" ]; do
    out=$(cli "$db" reap 2>&1 || true)
    [ -n "$out" ] && { printf '%s\n' "$out"; return 0; }
    sleep 0.02
  done
  return 1
}

dead-lane-no-report() {
  local repo db mission fakebin keeper correlation=dead-lane
  repo=$(make_repo dead); db="$fixture/dead.db"; mission=$(cli "$db" mission create "$correlation" | sed -n 's/^MISSION id=\([^ ]*\).*/\1/p')
  cli "$db" mission transition "$mission" running >/dev/null; cli "$db" lane create "$mission" dead-lane >/dev/null
  lane "$repo" ag-dead lanes/dead.txt dead >/dev/null
  fakebin="$fixture/dead-bin"; mkdir -p "$fakebin"
  # shellcheck disable=SC2016 # The shim expands these when watchdog executes it.
  printf '#!/usr/bin/env bash\ncase "$1" in has-session) exit 0;; list-panes) echo "$TMUX_FAKE_PID";; *) exit 0;; esac\n' > "$fakebin/tmux"
  chmod +x "$fakebin/tmux"
  sleep 60 & keeper=$!
  cli "$db" lease acquire watchdog orchestrator 30000 >/dev/null
  printf 'owner=watchdog\ntoken=1\n' > "$fixture/dead.lease"
  PATH="$fakebin:$PATH" TMUX_FAKE_PID="$keeper" ORCH_STATE_DB="$db" ORCH_LEASE_FILE="$fixture/dead.lease" ORCH_RUNTIME_DIR="$fixture/dead-runtime" ORCH_WATCHDOG_LOG="$fixture/dead.log" ORCH_MISSION_CLI="$root/core/mission-cli.ts" ORCH_WATCHDOG_NOW_MS=$(( $(now_ms) + 10000 )) FLEET_IDLE_NUDGE_MS=1 FLEET_NUDGE_REPEAT_MS=1 NUDGE_OUTBOX_FILE="$fixture/dead.nudges" NUDGE_RATE_FILE="$fixture/dead.rate" "$root/orchestrator/watchdog.sh" >"$fixture/logs/dead-watchdog" 2>&1
  kill "$keeper" 2>/dev/null || true
  "$root/gate/land.sh" --branch ag-dead --report "$fixture/missing.md" --repo "$repo" --no-push >"$fixture/logs/dead-land" 2>&1 && return 1
  has "$fixture/dead.nudges" "NUDGE mission=$correlation" && has "$fixture/logs/dead-land" 'LAND step=completion-guard status=fail'
}

crash-mid-landing() {
  local repo sha before after origin before_origin
  repo=$(make_repo crash); sha=$(lane "$repo" ag-crash lanes/crash.txt crash); report "$fixture/crash.md" "$sha"
  # The verify shell kills its parent (land.sh) after merge and before push/reap.
  # shellcheck disable=SC2016 # PPID belongs to the disposable verifier shell.
  printf 'commit: %s fixture\nverify: kill -9 "$PPID"\nresult: clean\nsecret-scan: clean\nremaining: none\n' "$sha" > "$fixture/crash.md"
  before_origin=$(origin_main "$repo")
  crash_injected crash-mid-landing "$fixture/logs/crash-land" "$root/gate/land.sh" --branch ag-crash --report "$fixture/crash.md" --repo "$repo" --no-push --run-verify
  after=$(git -C "$repo" rev-parse main); origin=$(origin_main "$repo")
  git -C "$repo" rev-parse --verify --quiet MERGE_HEAD >/dev/null && return 1
  # Recovery is allowed to complete or to make an honest guard refusal; no half merge reached origin.
  "$root/gate/land.sh" --branch ag-crash --report "$fixture/crash.md" --repo "$repo" --no-push >"$fixture/logs/crash-rerun" 2>&1 || has "$fixture/logs/crash-rerun" 'LAND step='
  [ "$origin" = "$before_origin" ] && [ -n "$after" ]
}

conflict-in-batch() {
  local repo before one two three
  repo=$(make_repo conflict); before=$(git -C "$repo" rev-parse main)
  one=$(lane "$repo" ag-conflict-one shared.txt one); two=$(lane "$repo" ag-conflict-two shared.txt two); three=$(lane "$repo" ag-conflict-good good.txt good)
  report "$fixture/c1.md" "$one"; report "$fixture/c2.md" "$two"; report "$fixture/c3.md" "$three"
  "$root/gate/land-batch.sh" --branches ag-conflict-one,ag-conflict-two,ag-conflict-good --reports "$fixture/c1.md,$fixture/c2.md,$fixture/c3.md" --repo "$repo" --no-push >"$fixture/logs/conflict-batch" 2>&1 && return 1
  [ "$(git -C "$repo" rev-parse main)" = "$before" ] && has "$fixture/logs/conflict-batch" 'BATCH verdict=conflict' && ! git -C "$repo" rev-parse --verify --quiet MERGE_HEAD >/dev/null && "$root/gate/land.sh" --branch ag-conflict-good --report "$fixture/c3.md" --repo "$repo" --no-push >"$fixture/logs/conflict-single" 2>&1
}

orphan-worktree() {
  local repo junk unique out
  repo=$(make_repo orphan); junk="$fixture/orphan-junk"; unique="$fixture/orphan-unique"
  git -C "$repo" worktree add -qb ag-orphan-junk "$junk" main
  git -C "$repo" worktree add -qb ag-orphan-unique "$unique" main
  printf unique > "$unique/unique.txt"; git -C "$unique" add unique.txt; git -C "$unique" commit -m '[CODER] unique' >/dev/null
  rm -rf -- "$junk"
  "$root/hygiene/reap.sh" worktrees --repo "$repo" --apply >"$fixture/logs/orphan-worktrees" 2>&1
  "$root/hygiene/reap.sh" branches --repo "$repo" --stale-days 0 --apply >"$fixture/logs/orphan-branches" 2>&1
  ! git -C "$repo" worktree list --porcelain | grep -Fq "worktree $junk" && git -C "$repo" show-ref --verify --quiet refs/heads/ag-orphan-unique && [ -d "$unique" ]
}

duplicate-contract-report() {
  local repo sha
  repo=$(make_repo duplicate); sha=$(lane "$repo" ag-duplicate lanes/d.txt d)
  printf 'commit: %s fixture\nverify: true\nresult: clean\nresult: NO-GO\nsecret-scan: clean\nremaining: none\n' "$sha" > "$fixture/duplicate.md"
  "$root/gate/land.sh" --branch ag-duplicate --report "$fixture/duplicate.md" --repo "$repo" --no-push >"$fixture/logs/duplicate" 2>&1 && return 1
  has "$fixture/logs/duplicate" 'LAND step=completion-guard status=fail'
}

secret-mid-batch() {
  local repo before a b c token
  repo=$(make_repo secret); before=$(git -C "$repo" rev-parse main); a=$(lane "$repo" ag-secret-good-a a.txt a); token="gh"; token="${token}p_$(printf 'x%.0s' $(seq 1 36))"; b=$(lane "$repo" ag-secret-bad secret.txt "$token"); c=$(lane "$repo" ag-secret-good-c c.txt c)
  report "$fixture/s1.md" "$a"; report "$fixture/s2.md" "$b"; report "$fixture/s3.md" "$c"
  "$root/gate/land-batch.sh" --branches ag-secret-good-a,ag-secret-bad,ag-secret-good-c --reports "$fixture/s1.md,$fixture/s2.md,$fixture/s3.md" --repo "$repo" --no-push >"$fixture/logs/secret-batch" 2>&1 && return 1
  [ "$(git -C "$repo" rev-parse main)" = "$before" ] && has "$fixture/logs/secret-batch" 'BATCH step=secret-scan branch=ag-secret-bad status=fail'
}

disk-pressure-nudge() {
  local db fakebin outbox log keeper
  db="$fixture/disk.db"; fakebin="$fixture/disk-bin"; outbox="$fixture/disk.nudges"; log="$fixture/disk.log"; mkdir -p "$fakebin"
  # shellcheck disable=SC2016 # The shim expands these when watchdog executes it.
  printf '#!/usr/bin/env bash\ncase "$1" in has-session) exit 0;; list-panes) echo "$TMUX_FAKE_PID";; esac\n' > "$fakebin/tmux"
  printf '#!/usr/bin/env bash\necho "Filesystem 1024-blocks Used Available Capacity Mounted on"; echo "/dev/fake 100 95 5 95%% /"\n' > "$fakebin/df"
  chmod +x "$fakebin/tmux" "$fakebin/df"; cli "$db" lease acquire watchdog orchestrator 30000 >/dev/null; printf 'owner=watchdog\ntoken=1\n' > "$fixture/disk.lease"; sleep 60 & keeper=$!
  PATH="$fakebin:$PATH" TMUX_FAKE_PID="$keeper" ORCH_STATE_DB="$db" ORCH_LEASE_FILE="$fixture/disk.lease" ORCH_RUNTIME_DIR="$fixture/disk-runtime" ORCH_WATCHDOG_LOG="$log" ORCH_MISSION_CLI="$root/core/mission-cli.ts" ORCH_WATCHDOG_NOW_MS=10000 DISK_ALERT_PCT=80 FLEET_NUDGE_REPEAT_MS=1000 NUDGE_OUTBOX_FILE="$outbox" NUDGE_RATE_FILE="$fixture/disk.rate" "$root/orchestrator/watchdog.sh"
  PATH="$fakebin:$PATH" TMUX_FAKE_PID="$keeper" ORCH_STATE_DB="$db" ORCH_LEASE_FILE="$fixture/disk.lease" ORCH_RUNTIME_DIR="$fixture/disk-runtime" ORCH_WATCHDOG_LOG="$log" ORCH_MISSION_CLI="$root/core/mission-cli.ts" ORCH_WATCHDOG_NOW_MS=10500 DISK_ALERT_PCT=80 FLEET_NUDGE_REPEAT_MS=1000 NUDGE_OUTBOX_FILE="$outbox" NUDGE_RATE_FILE="$fixture/disk.rate" "$root/orchestrator/watchdog.sh"
  kill "$keeper" 2>/dev/null || true
  [ "$(grep -Fc 'NUDGE disk-pressure' "$outbox")" -eq 1 ] && [ "$(grep -Fc 'WATCHDOG disk-pressure' "$log")" -eq 2 ]
}

lease-fencing-under-restart() {
  local db a b
  db="$fixture/lease.db"; a=$(cli "$db" lease acquire owner-a lane/fence 1 | sed -n 's/.*token=\([0-9]*\).*/\1/p'); poll_reap "$db" >/dev/null; b=$(cli "$db" lease acquire owner-b lane/fence 30000 | sed -n 's/.*token=\([0-9]*\).*/\1/p')
  cli "$db" lease renew owner-a lane/fence "$a" >"$fixture/logs/fence-stale" 2>&1 && return 1
  [ "$b" -gt "$a" ] && has "$fixture/logs/fence-stale" 'lease is stale or not owned'
}

ten-wide-with-mixed-fate() {
  local repo db mission i sha landed=0 origin_before origin_after token branches=0 worktrees=0 fate
  repo=$(make_repo ten); db="$fixture/ten.db"; mission=$(cli "$db" mission create ten-wide | sed -n 's/^MISSION id=\([^ ]*\).*/\1/p'); cli "$db" mission transition "$mission" running >/dev/null
  for i in $(seq 1 10); do
    sha=$(lane "$repo" "ag-ten-$i" "lanes/$i.txt" "$i")
    report "$fixture/ten-$i.md" "$sha"
    cli "$db" lane create "$mission" "ten-$i" >/dev/null
    cli "$db" lane transition "ten-$i" running >/dev/null
  done
  # six clean lanes land; every other fate is deliberately refused/recovered.
  for i in 1 2 3 4 5 6; do "$root/gate/land.sh" --branch "ag-ten-$i" --report "$fixture/ten-$i.md" --repo "$repo" >"$fixture/logs/ten-$i" 2>&1 && landed=$((landed + 1)); done
  "$root/gate/land.sh" --branch ag-ten-7 --report "$fixture/no-such-report.md" --repo "$repo" --no-push >"$fixture/logs/ten-7" 2>&1 && return 1
  token="gh"; token="${token}p_$(printf 'x%.0s' $(seq 1 36))"; git -C "$repo" checkout -q ag-ten-8; printf '%s\n' "$token" > "$repo/secret.txt"; git -C "$repo" add secret.txt && git -C "$repo" commit -m '[CODER] secret fate' >/dev/null; git -C "$repo" checkout -q main; report "$fixture/ten-8.md" "$(git -C "$repo" rev-parse ag-ten-8)"
  "$root/gate/land.sh" --branch ag-ten-8 --report "$fixture/ten-8.md" --repo "$repo" --no-push >"$fixture/logs/ten-8" 2>&1 && return 1
  git -C "$repo" checkout -q ag-ten-9; printf conflict > "$repo/base.txt"; git -C "$repo" add base.txt && git -C "$repo" commit -m '[CODER] conflict fate' >/dev/null; git -C "$repo" checkout -q main; printf main-change > "$repo/base.txt"; git -C "$repo" add base.txt && git -C "$repo" commit -m '[ORCH] divergent base' >/dev/null; git -C "$repo" push origin main >/dev/null; report "$fixture/ten-9.md" "$(git -C "$repo" rev-parse ag-ten-9)"
  "$root/gate/land.sh" --branch ag-ten-9 --report "$fixture/ten-9.md" --repo "$repo" --no-push >"$fixture/logs/ten-9" 2>&1 && return 1
  # shellcheck disable=SC2016 # PPID belongs to the disposable verifier shell.
  printf 'commit: %s fixture\nverify: kill -9 "$PPID"\nresult: clean\nsecret-scan: clean\nremaining: none\n' "$(git -C "$repo" rev-parse ag-ten-10)" > "$fixture/ten-10.md"
  # The crash-injected no-push land must not publish its half-completed merge.
  origin_before=$(origin_main "$repo")
  crash_injected ten-wide-lane-10 "$fixture/logs/ten-10" "$root/gate/land.sh" --branch ag-ten-10 --report "$fixture/ten-10.md" --repo "$repo" --no-push --run-verify
  git -C "$repo" merge --abort >/dev/null 2>&1 || true; git -C "$repo" worktree prune
  origin_after=$(origin_main "$repo")
  for i in $(seq 1 6); do cli "$db" lane transition "ten-$i" succeeded >/dev/null; done
  for i in 7 8 9 10; do cli "$db" lane transition "ten-$i" failed >/dev/null; done
  cli "$db" mission transition "$mission" failed >/dev/null
  for i in $(seq 1 10); do git -C "$repo" branch -D "ag-ten-$i" >/dev/null 2>&1 || true; done
  branches=$(git -C "$repo" for-each-ref --format='%(refname)' 'refs/heads/ag-ten-*' | wc -l | tr -d ' ')
  worktrees=$(git -C "$repo" worktree list --porcelain | grep -c '^worktree ' || true)
  # `status` deliberately hides only `succeeded` (core/mission-cli.ts), because a
  # failed lane must survive a restart in view -- fenced by "status exposes
  # persisted failures after restart" in core/mission-cli.test.ts. So the six
  # clean lanes are proven terminal by their absence and the four refused ones by
  # their presence in `failed`. Pinning the exact split is strictly stronger than
  # the old bare `lanes+leases == 0` count: a lane stranded in `running` and a
  # lane wrongly recorded `succeeded` both fail here and neither did before.
  fate=$(cli "$db" status | bun -e 'const s = JSON.parse(await Bun.stdin.text()); const visible = s.lanes.map((l) => `${l.id}:${l.state}`).sort().join(","); console.log(`leases=${s.leases.length} lanes=${visible}`)')
  check landed-count [ "$landed" -eq 6 ] &&
    check origin-advanced-under-crash [ "$origin_before" = "$origin_after" ] &&
    check lane-7-not-guarded has "$fixture/logs/ten-7" 'completion-guard' &&
    check lane-8-secret-not-caught has "$fixture/logs/ten-8" 'secret-scan' &&
    check lane-9-conflict-not-refused has "$fixture/logs/ten-9" 'LAND step=merge status=fail' &&
    check merge-head-left-behind no_merge_head "$repo" &&
    check lane-branches-leaked [ "$branches" -eq 0 ] &&
    check worktrees-leaked [ "$worktrees" -eq 1 ] &&
    check mixed-fate-not-recorded [ "$fate" = 'leases=0 lanes=ten-10:failed,ten-7:failed,ten-8:failed,ten-9:failed' ]
}

: > "$report_file"
run dead-lane-no-report
run crash-mid-landing
run conflict-in-batch
run orphan-worktree
run duplicate-contract-report
run secret-mid-batch
run disk-pressure-nudge
run lease-fencing-under-restart
run ten-wide-with-mixed-fate
say "CHAOS total=$total pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
