#!/usr/bin/env bash
# Discover and run every test suite in the tree, then prove the discovery was
# complete.
#
# WHY THIS EXISTS
# ---------------
# CI used to name four shell suites by hand. A suite that nobody added to that
# list never ran, and a check nobody executes is indistinguishable from a check
# that passes. So suites are discovered by glob here, never enumerated, and the
# run ends with a coverage guard that fails if a suite exists in the tree but
# produced no result row. The guard is the point; the globs are plumbing.
#
# USAGE
#   .github/scripts/run-suites.sh partition   # every tracked suite has a group
#   .github/scripts/run-suites.sh checks      # repo-level checkers
#   .github/scripts/run-suites.sh bun         # *.test.ts
#   .github/scripts/run-suites.sh shell       # *.test.sh outside soak/
#   .github/scripts/run-suites.sh soak        # soak/*.test.sh (slow, nightly)
#
# A suite never silently disappears. It either runs, or it is recorded SKIP with
# a named unmet requirement, and both counts land in the job summary. A SKIP is
# still a gate that did not execute, so any SKIP fails the run (see skip_gate).
# SUITES_ALLOW_SKIP=1 waives that exit — for underprovisioned local machines
# only; ci.yml never sets it, so PR, push and nightly are all fail-closed.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT" || exit 1

GROUP="${1:-}"
SUITE_TIMEOUT="${SUITE_TIMEOUT:-600}"
SANDBOX="${SUITE_SANDBOX:-$(mktemp -d "${TMPDIR:-/tmp}/bpa-suites.XXXXXX")}"
# Scratch run log inside a mktemp sandbox, deliberately NOT given one of the
# durable-state extensions (json/db/lock/lease/tsv/...) that
# tools/state-contract/check.ts sweeps for: it is a per-run scratch file with no
# reader outside this script, and naming it like durable state would put a
# transient into a registry that exists to track real reader/writer contracts.
RESULTS="$SANDBOX/suite-results.txt"
DOCKER_CALL_LOG="$SANDBOX/docker-calls.log"
CLAUDE_TRUST_CONFIG="$SANDBOX/home/claude-trusted-workdir-config"
LOG_DIR="$SANDBOX/logs"
mkdir -p "$LOG_DIR"
: > "$RESULTS"
: > "$DOCKER_CALL_LOG"

# ── Group globs ────────────────────────────────────────────────────────────
# Every tracked *.test.sh / *.test.ts must fall into exactly one group or into
# UNASSIGNED_OK below. `partition` enforces that; nothing here is a hand list of
# individual suites.
group_members() {
  case "$1" in
    bun)   git ls-files '*.test.ts' | grep -v '^migration-prep/' ;;
    shell) git ls-files '*.test.sh' | grep -v '^migration-prep/' | grep -v '^soak/' ;;
    soak)  git ls-files 'soak/*.test.sh' ;;
    # Repo-level checkers. Globbed for the same reason the suites are: a new
    # tools/<thing>/check.ts must not need a human to remember this file.
    checks) git ls-files 'tools/*/check.ts' ;;
    *)     return 1 ;;
  esac
}

# Checkers that need an argument. A checker absent from this table runs bare.
checker_command() {
  case "$1" in
    tools/state-contract/check.ts) printf 'bun %s .' "$1" ;;
    *)                             printf 'bun %s' "$1" ;;
  esac
}

# Suites deliberately outside CI, each with a reason. `partition` fails if one
# of these paths stops existing, so the list cannot rot into a lie.
UNASSIGNED_OK=(
  "migration-prep/reference-daemon/templates/daemon/relay.test.ts|frozen donor copy kept for migration parity diffing, not this repo's runtime"
  "migration-prep/reference-daemon/templates/daemon/server.test.ts|frozen donor copy kept for migration parity diffing, not this repo's runtime"
  "migration-prep/reference-daemon/templates/daemon/test/orchestrator-turnend-relay.test.sh|frozen donor copy kept for migration parity diffing, not this repo's runtime"
  "migration-prep/reference-daemon/tools/claude-telegram-daemon/test/orchestrator-turnend-relay.test.sh|frozen donor copy kept for migration parity diffing, not this repo's runtime"
)

# ── Requirements ───────────────────────────────────────────────────────────
# A suite that cannot run must say so by name. Requirements are evaluated at run
# time, so the same table yields zero skips on a fully provisioned runner and a
# loud, counted skip anywhere else. The skip is honest degradation, not a pass:
# skip_gate turns any SKIP into a failing run unless SUITES_ALLOW_SKIP=1.
requirements_for() {
  local suite="$1" reqs=""
  # Suites that drive a real tmux server (each on its own private -L socket).
  if grep -q 'tmux -L' "$suite" 2>/dev/null; then
    reqs+=" tmux"
  fi
  # Suites that boot daemon/server.ts, which imports grammy/zod.
  if grep -qE 'daemon/(server|relay|control)\.ts' "$suite" 2>/dev/null; then
    reqs+=" daemon-deps"
  fi
  case "$suite" in
    # Pulls and runs koalaman/shellcheck in a container.
    bootstrap/bootstrap.test.sh) reqs+=" docker" ;;
  esac
  printf '%s' "${reqs# }"
}

requirement_met() {
  case "$1" in
    tmux)        command -v tmux >/dev/null 2>&1 ;;
    docker)      command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 ;;
    daemon-deps) [[ -d "$REPO_ROOT/daemon/node_modules" ]] ;;
    *)           return 1 ;;
  esac
}

requirement_reason() {
  case "$1" in
    tmux)        printf 'tmux binary not installed (suite drives a real tmux server)' ;;
    docker)      printf 'no working docker daemon (suite runs a container)' ;;
    daemon-deps) printf 'daemon/node_modules missing (run: bun install in daemon/)' ;;
    *)           printf 'unknown requirement: %s' "$1" ;;
  esac
}

# ── Hermetic environment ───────────────────────────────────────────────────
# The operator's live orchestrator exports ORCH_*/TELEGRAM_* into any shell it
# spawns. A suite inheriting ORCH_STATE_DB or ORCH_RUNTIME_DIR would acquire,
# renew or displace the *live* lease. Every one of those names is dropped.
build_env() {
  local -n out="$1"
  out=()
  local name
  while read -r name; do
    [[ -n "$name" ]] && out+=(-u "$name")
  done < <(env | sed -n 's/^\(ORCH_[A-Za-z0-9_]*\)=.*/\1/p;s/^\(TELEGRAM_[A-Za-z0-9_]*\)=.*/\1/p;s/^\(INFRA_[A-Za-z0-9_]*\)=.*/\1/p' | sort -u)
  out+=(
    "HOME=$SANDBOX/home"
    "XDG_CONFIG_HOME=$SANDBOX/home/.config"
    "XDG_STATE_HOME=$SANDBOX/home/.local/state"
    "XDG_CACHE_HOME=$SANDBOX/home/.cache"
    "PATH=$SANDBOX/bin:$PATH"
    "DOCKER_CALL_LOG=$DOCKER_CALL_LOG"
    # Points the trust preflight at the scratch config written by
    # prepare_sandbox. A suite that needs a different verdict overrides this
    # per-invocation, which is exactly what claude-mcp-channel.test.sh does.
    "CLAUDE_CONFIG_FILE=$CLAUDE_TRUST_CONFIG"
    # No suite may enter the watchdog's disk-pressure branch by accident. The
    # comparison is `pct >= DISK_ALERT_PCT`, so 101 is unreachable. Suites that
    # exercise disk pressure on purpose set their own value and still win.
    "DISK_ALERT_PCT=101"
  )
}

prepare_sandbox() {
  mkdir -p "$SANDBOX/home/.claude" "$SANDBOX/home/.codex" "$SANDBOX/bin"

  # Directory trust. launch.sh refuses to start a CLI in an untrusted work dir
  # because the TUI would stall on the trust prompt in a headless pane. A CI
  # runner has no trusted-project record, so give it one.
  #
  # ORCH_SKIP_TRUST_CHECK=1 is NOT usable as the blanket answer:
  # orchestrator/claude-mcp-channel.test.sh asserts BOTH sides of that preflight
  # — that an untrusted dir fails loudly AND that the skip flag bypasses it — so
  # forcing the flag on would make the suite unable to observe the failing side.
  # A scratch config that genuinely marks the repo trusted leaves the preflight
  # real and lets the suite drive both branches itself.
  #
  # It is reached through CLAUDE_CONFIG_FILE rather than by writing the CLI's
  # real config basename into the sandbox home. Two reasons, both load-bearing:
  # the env var is the documented override launch.sh already honours, and
  # writing that basename here would make this harness look like a writer of the
  # operator's actual CLI config to tools/state-contract/check.ts. It is not one
  # — it mints a throwaway.
  printf '{"projects":{"%s":{"hasTrustDialogAccepted":true}}}\n' "$REPO_ROOT" \
    > "$CLAUDE_TRUST_CONFIG"
  printf '[projects."%s"]\ntrust_level = "trusted"\n' "$REPO_ROOT" \
    > "$SANDBOX/home/.codex/config.toml"

  # Docker remediation fence. Watchdog-class code reads real `df` and, on a host
  # over threshold, may reach for a docker prune. On a shared machine that
  # destroys the operator's images. Every docker call is logged, and the prune
  # family is refused rather than silently allowed — a refusal is a loud test
  # failure, which is the correct outcome for an unshimmed remediation path.
  cat > "$SANDBOX/bin/docker" <<'SHIM'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${DOCKER_CALL_LOG:-/dev/null}"
for arg in "$@"; do
  case "$arg" in
    prune|rmi)
      printf 'CI-FENCE: refusing destructive docker call (%s): %s\n' "$arg" "$*" >&2
      printf 'REFUSED %s\n' "$*" >> "${DOCKER_CALL_LOG:-/dev/null}"
      exit 90
      ;;
  esac
done
exec /usr/bin/docker "$@"
SHIM
  chmod +x "$SANDBOX/bin/docker"
}

# ── Execution ──────────────────────────────────────────────────────────────
record() { printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" >> "$RESULTS"; }

run_suite() {
  local suite="$1" runner="$2" reqs req start end rc dur log
  reqs="$(requirements_for "$suite")"
  for req in $reqs; do
    if ! requirement_met "$req"; then
      record "$suite" SKIP 0 "$(requirement_reason "$req")"
      printf 'SKIP  %-56s %s\n' "$suite" "$(requirement_reason "$req")"
      # return 0 here is per-suite bookkeeping only: the loop must keep going so
      # every skip gets named, and skip_gate then fails the whole run on any
      # SKIP row. This is NOT a green path.
      return 0
    fi
  done

  local -a envargs
  build_env envargs
  log="$LOG_DIR/${suite//\//__}.log"
  start=$(date +%s)
  env "${envargs[@]}" timeout -s KILL "$SUITE_TIMEOUT" \
    bash -c "cd $(printf '%q' "$REPO_ROOT") && $runner" > "$log" 2>&1
  rc=$?
  end=$(date +%s)
  dur=$(( end - start ))
  if (( rc == 0 )) && grep -q '^NOT-APPLICABLE ' "$log"; then
    local na_reason
    na_reason="$(grep '^NOT-APPLICABLE ' "$log" | paste -sd ';' -)"
    record "$suite" NOT-APPLICABLE "$dur" "$na_reason"
    printf 'N/A   %-56s %s\n' "$suite" "$na_reason"
  elif (( rc == 0 )); then
    record "$suite" PASS "$dur" ''
    printf 'PASS  %-56s %ss\n' "$suite" "$dur"
  else
    record "$suite" FAIL "$dur" "exit $rc"
    printf 'FAIL  %-56s %ss exit=%s\n' "$suite" "$dur" "$rc"
    printf '───── %s ─────\n' "$suite"
    tail -60 "$log"
    printf '───── end %s ─────\n' "$suite"
  fi
}

# ── Coverage guard ─────────────────────────────────────────────────────────
# The actual deliverable. Re-discovers the group after the run and fails if any
# member produced no row, so a suite can never become invisible by being missed,
# renamed, or dropped out of the loop.
coverage_guard() {
  local group="$1" missing=0 suite
  while read -r suite; do
    [[ -z "$suite" ]] && continue
    if ! cut -f1 "$RESULTS" | grep -qxF "$suite"; then
      printf 'COVERAGE-GUARD FAIL: %s exists in the tree but was never executed or skipped\n' "$suite" >&2
      missing=$(( missing + 1 ))
    fi
  done < <(group_members "$group")
  if (( missing > 0 )); then
    printf 'COVERAGE-GUARD: %d suite(s) in group "%s" produced no result row\n' "$missing" "$group" >&2
    return 1
  fi
  printf 'COVERAGE-GUARD ok: every suite in group "%s" produced a result row\n' "$group"
  return 0
}

# ── Skip gate ──────────────────────────────────────────────────────────────
# A SKIP row proves a suite was seen, not that it ran. Green-on-SKIP would let a
# tracked, assigned suite sit unexecuted forever behind an unmet requirement, so
# after every group run any SKIP fails the gate. The skips stay named and
# counted first — the degradation is honest, it just no longer passes.
# SUITES_ALLOW_SKIP=1 (never set in ci.yml) waives the exit for local machines
# that legitimately lack tmux/docker/daemon deps.
skip_gate() {
  local skips
  skips=$(awk -F'\t' '$2=="SKIP"' "$RESULTS" | wc -l)
  (( skips == 0 )) && return 0
  awk -F'\t' '$2=="SKIP" {printf "SKIP-GATE: %s — %s\n", $1, $4}' "$RESULTS" >&2
  if [[ "${SUITES_ALLOW_SKIP:-}" == "1" ]]; then
    printf 'SKIP-GATE waived: %d skip(s) tolerated because SUITES_ALLOW_SKIP=1 (local underprovisioned run only — CI never sets this)\n' "$skips" >&2
    return 0
  fi
  printf 'SKIP-GATE FAIL: %d suite(s) skipped; a skipped suite is an unexecuted gate. Provision the requirement or set SUITES_ALLOW_SKIP=1 for a local run.\n' "$skips" >&2
  return 1
}

# ── Partition check ────────────────────────────────────────────────────────
# Guards the other direction: a suite that belongs to no group would never be
# discovered by any job. Also fails on a stale UNASSIGNED_OK entry.
partition_check() {
  local rc=0 suite entry path reason
  local assigned="$SANDBOX/assigned.txt"
  { group_members bun; group_members shell; group_members soak; } | sort -u > "$assigned"

  while read -r suite; do
    [[ -z "$suite" ]] && continue
    if grep -qxF "$suite" "$assigned"; then continue; fi
    local excused=0
    for entry in "${UNASSIGNED_OK[@]}"; do
      path="${entry%%|*}"
      reason="${entry#*|}"
      if [[ "$path" == "$suite" ]]; then
        printf 'EXCLUDED %-72s %s\n' "$suite" "$reason"
        excused=1
        break
      fi
    done
    if (( excused == 0 )); then
      printf 'PARTITION FAIL: %s belongs to no CI group and is not in UNASSIGNED_OK\n' "$suite" >&2
      rc=1
    fi
  done < <(git ls-files '*.test.sh' '*.test.ts' | sort -u)

  for entry in "${UNASSIGNED_OK[@]}"; do
    path="${entry%%|*}"
    if [[ ! -f "$path" ]]; then
      printf 'PARTITION FAIL: UNASSIGNED_OK names %s, which no longer exists — drop the stale entry\n' "$path" >&2
      rc=1
    fi
  done

  printf 'partition: %s tracked suites, %s assigned to a CI group, %s excluded with a reason\n' \
    "$(git ls-files '*.test.sh' '*.test.ts' | wc -l)" \
    "$(wc -l < "$assigned")" \
    "${#UNASSIGNED_OK[@]}"
  return "$rc"
}

# ── Job summary ────────────────────────────────────────────────────────────
emit_summary() {
  local group="$1" guard_rc="$2"
  local pass fail skip not_applicable total docker_calls refused
  pass=$(awk -F'\t' '$2=="PASS"' "$RESULTS" | wc -l)
  fail=$(awk -F'\t' '$2=="FAIL"' "$RESULTS" | wc -l)
  skip=$(awk -F'\t' '$2=="SKIP"' "$RESULTS" | wc -l)
  not_applicable=$(awk -F'\t' '$2=="NOT-APPLICABLE"' "$RESULTS" | wc -l)
  total=$(wc -l < "$RESULTS")
  docker_calls=$(wc -l < "$DOCKER_CALL_LOG")
  refused=$(grep -c '^REFUSED' "$DOCKER_CALL_LOG" 2>/dev/null || true)

  {
    printf '## suite group `%s`\n\n' "$group"
    printf '| result | count |\n|---|---|\n'
    printf '| executed | %s |\n' "$(( pass + fail ))"
    printf '| passed | %s |\n' "$pass"
    printf '| **failed** | **%s** |\n' "$fail"
    printf '| **skipped** | **%s** |\n' "$skip"
    printf '| not applicable | %s |\n' "$not_applicable"
    printf '| discovered | %s |\n' "$total"
    printf '| coverage guard | %s |\n\n' "$( ((guard_rc==0)) && printf 'ok' || printf 'FAILED' )"
    if (( skip > 0 )); then
      printf '### skipped, with reason\n\n| suite | reason |\n|---|---|\n'
      awk -F'\t' '$2=="SKIP" {printf "| `%s` | %s |\n", $1, $4}' "$RESULTS"
      printf '\n'
    fi
    if (( not_applicable > 0 )); then
      printf '### not applicable, with reason\n\n| suite | reason |\n|---|---|\n'
      awk -F'\t' '$2=="NOT-APPLICABLE" {printf "| `%s` | %s |\n", $1, $4}' "$RESULTS"
      printf '\n'
    fi
    if (( fail > 0 )); then
      printf '### failed\n\n| suite | seconds | exit |\n|---|---|---|\n'
      awk -F'\t' '$2=="FAIL" {printf "| `%s` | %s | %s |\n", $1, $3, $4}' "$RESULTS"
      printf '\n'
    fi
    printf '### slowest\n\n| suite | seconds |\n|---|---|\n'
    awk -F'\t' '$2=="PASS" || $2=="FAIL"' "$RESULTS" | sort -t"$(printf '\t')" -k3 -rn | head -8 \
      | awk -F'\t' '{printf "| `%s` | %s |\n", $1, $3}'
    printf '\n**wall clock:** %ss\n\n' "$(( $(date +%s) - START_TS ))"
    printf '**docker fence:** %s call(s) observed, %s refused as destructive\n\n' \
      "$docker_calls" "${refused:-0}"
  } | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
}

# ── Main ───────────────────────────────────────────────────────────────────
START_TS=$(date +%s)

case "$GROUP" in
  partition)
    partition_check
    exit $?
    ;;
  checks)
    prepare_sandbox
    while read -r checker; do
      [[ -z "$checker" ]] && continue
      run_suite "$checker" "$(checker_command "$checker")"
    done < <(group_members checks)
    coverage_guard checks
    guard_rc=$?
    emit_summary checks "$guard_rc"
    (( guard_rc != 0 )) && exit 1
    awk -F'\t' '$2=="FAIL"' "$RESULTS" | grep -q . && exit 1
    skip_gate || exit 1
    exit 0
    ;;
  bun|shell|soak)
    prepare_sandbox
    while read -r suite; do
      [[ -z "$suite" ]] && continue
      case "$suite" in
        *.test.ts) run_suite "$suite" "bun test $(printf '%q' "$suite")" ;;
        # Invoked through bash, not ./, so a suite that lost its +x bit still
        # runs instead of vanishing behind a 126.
        *.test.sh) run_suite "$suite" "bash $(printf '%q' "$suite")" ;;
      esac
    done < <(group_members "$GROUP")
    coverage_guard "$GROUP"
    guard_rc=$?
    emit_summary "$GROUP" "$guard_rc"
    (( guard_rc != 0 )) && exit 1
    awk -F'\t' '$2=="FAIL"' "$RESULTS" | grep -q . && exit 1
    skip_gate || exit 1
    exit 0
    ;;
  *)
    printf 'usage: %s {partition|checks|bun|shell|soak}\n' "$0" >&2
    exit 2
    ;;
esac
