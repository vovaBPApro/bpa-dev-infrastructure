#!/usr/bin/env bash
set -euo pipefail
unset BUN_BIN

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
# shellcheck source=gate/land-lib.sh
source "$root/gate/land-lib.sh"
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT

git init --initial-branch=main "$fixture/repo" >/dev/null
git -C "$fixture/repo" config user.email meteorite@example.test
git -C "$fixture/repo" config user.name Meteorite
mkdir -p "$fixture/repo/bootstrap" "$fixture/repo/instructions" "$fixture/repo/runtime" "$fixture/repo/meteorite"
cp "$root/meteorite/budget.sh" "$fixture/repo/meteorite/budget.sh"
cp "$root/meteorite/stage-budgets.tsv" "$fixture/repo/meteorite/stage-budgets.tsv"
printf 'good\n' >"$fixture/repo/bootstrap/install.sh"
printf 'docs\n' >"$fixture/repo/instructions/readme.md"
printf 'behavior\n' >"$fixture/repo/runtime/behavior.sh"
printf 'runtime reads behavior.md\n' >"$fixture/repo/runtime/loader.sh"
git -C "$fixture/repo" add .
git -C "$fixture/repo" commit -m base >/dev/null
git -C "$fixture/repo" checkout -b ag-broken >/dev/null
printf 'deliberately broken\n' >"$fixture/repo/bootstrap/install.sh"
git -C "$fixture/repo" commit -am broken >/dev/null
git -C "$fixture/repo" checkout main >/dev/null
LAND_DEFAULT_BRANCH=main
land_meteorite_required "$fixture/repo" ag-broken

git -C "$fixture/repo" checkout -b ag-docs >/dev/null
printf 'docs only\n' >"$fixture/repo/instructions/readme.md"
git -C "$fixture/repo" commit -am docs >/dev/null
git -C "$fixture/repo" checkout main >/dev/null
if ! land_meteorite_required "$fixture/repo" ag-docs; then
  echo 'Markdown change unexpectedly skipped meteorite' >&2
  exit 1
fi

git -C "$fixture/repo" checkout -b ag-rename >/dev/null
git -C "$fixture/repo" mv runtime/behavior.sh runtime/behavior.md
git -C "$fixture/repo" commit -m rename >/dev/null
git -C "$fixture/repo" checkout main >/dev/null
land_meteorite_required "$fixture/repo" ag-rename

git -C "$fixture/repo" checkout -b ag-markdown-behavior >/dev/null
printf 'changed behavior\n' >"$fixture/repo/runtime/behavior.md"
git -C "$fixture/repo" add runtime/behavior.md
git -C "$fixture/repo" commit -m markdown-behavior >/dev/null
git -C "$fixture/repo" checkout main >/dev/null
land_meteorite_required "$fixture/repo" ag-markdown-behavior

mkdir "$fixture/no-docker"
if PATH="$fixture/no-docker" land_run_meteorite "$fixture/repo" "$(git -C "$fixture/repo" rev-parse ag-broken)" \
    >"$fixture/unavailable.out" 2>&1; then
  echo 'missing Docker unexpectedly passed meteorite gate' >&2
  exit 1
fi
grep -Fq 'LAND meteorite blocker=docker-binary-unavailable' "$fixture/unavailable.out"

# Deliberately broken rebuild fixture: Docker is available, but the candidate's
# own prover rejects the bootstrap change. The gate helper must propagate that
# refusal instead of treating prover availability as proof.
mkdir -p "$fixture/fake-bin"
cat >"$fixture/fake-bin/docker" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  info) test "${FAKE_DOCKER_DAEMON:-up}" = up ;;
  ps)
    count=1
    if [[ -n "${FAKE_DOCKER_PS_COUNT_FILE:-}" ]]; then
      [[ ! -f "$FAKE_DOCKER_PS_COUNT_FILE" ]] || count=$(( $(cat "$FAKE_DOCKER_PS_COUNT_FILE") + 1 ))
      printf '%s\n' "$count" >"$FAKE_DOCKER_PS_COUNT_FILE"
    fi
    [[ "${FAKE_DOCKER_MODE:-}" != first-ps-fail || "$count" -ne 1 ]] || exit 42
    [[ "${FAKE_DOCKER_MODE:-}" != final-ps-fail || "$count" -ne 2 ]] || exit 42
    [[ -n "${FAKE_DOCKER_STATE:-}" && -f "$FAKE_DOCKER_STATE" ]] && printf 'orphan-container\n' || true
    ;;
  rm)
    [[ "${FAKE_DOCKER_MODE:-}" != rm-fail ]] || exit 42
    if [[ "${FAKE_DOCKER_MODE:-}" != remaining-container && -n "${FAKE_DOCKER_STATE:-}" ]]; then
      rm -f "$FAKE_DOCKER_STATE"
    fi
    ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$fixture/fake-bin/docker"
candidate_sha="$(git -C "$fixture/repo" rev-parse ag-broken)"
main_sha="$(git -C "$fixture/repo" rev-parse main)"
if FAKE_DOCKER_DAEMON=down PATH="$fixture/fake-bin:/usr/bin:/bin" land_run_meteorite "$fixture/repo" \
    "$candidate_sha" "$main_sha" >"$fixture/daemon.out" 2>&1; then
  echo 'dead Docker daemon unexpectedly passed meteorite gate' >&2; exit 1
fi
grep -Fq 'LAND meteorite blocker=docker-daemon-unavailable' "$fixture/daemon.out"

if PATH="$fixture/fake-bin:/usr/bin:/bin" land_run_meteorite "$fixture/repo" \
    "$candidate_sha" "$main_sha" >"$fixture/missing-prover.out" 2>&1; then
  echo 'missing candidate prover unexpectedly passed meteorite gate' >&2; exit 1
fi
grep -Fq 'LAND meteorite blocker=trusted-prover-unavailable' "$fixture/missing-prover.out"

cat >"$fixture/repo/meteorite/prove-candidate.sh" <<'EOF'
#!/usr/bin/env bash
echo 'deliberately broken bootstrap fixture' >&2
exit 42
EOF
chmod +x "$fixture/repo/meteorite/prove-candidate.sh"
git -C "$fixture/repo" add meteorite/prove-candidate.sh
git -C "$fixture/repo" commit -m trusted-broken-prover >/dev/null
broken_prover_sha="$(git -C "$fixture/repo" rev-parse HEAD)"
if TMPDIR="$fixture/missing/report-dir" PATH="$fixture/fake-bin:/usr/bin:/bin" land_run_meteorite "$fixture/repo" \
    "$candidate_sha" "$broken_prover_sha" >"$fixture/allocation.out" 2>&1; then
  echo 'failed report allocation unexpectedly passed meteorite gate' >&2; exit 1
fi
grep -Fq 'LAND meteorite blocker=report-allocation-failed' "$fixture/allocation.out"

if PATH="$fixture/fake-bin:/usr/bin:/bin" land_run_meteorite "$fixture/repo" \
    "$candidate_sha" "$broken_prover_sha" >"$fixture/broken.out" 2>&1; then
  echo 'deliberately broken rebuild unexpectedly passed meteorite gate' >&2
  exit 1
fi
grep -Fq 'deliberately broken bootstrap fixture' "$fixture/broken.out"
grep -Fq 'LAND meteorite blocker=rebuild-proof-failed' "$fixture/broken.out"

# Trust boundary: enforcement introduced by a candidate is deliberately not
# active at its own landing; gate/land.sh has already sourced the pre-merge
# library. Once this gate is trusted, it may only use a budget present in that
# same independently trusted pre-merge tree. It must never fall back to the
# next candidate checkout (or to the gate caller's working tree).
git -C "$fixture/repo" rm meteorite/budget.sh meteorite/stage-budgets.tsv >/dev/null
cat >"$fixture/repo/meteorite/prove-candidate.sh" <<'EOF'
#!/usr/bin/env bash
touch "$UNTRUSTED_PROVER_MARKER"
exit 0
EOF
git -C "$fixture/repo" add meteorite/prove-candidate.sh
git -C "$fixture/repo" commit -m trusted-tree-without-budget-policy >/dev/null
legacy_trusted_sha="$(git -C "$fixture/repo" rev-parse HEAD)"
if UNTRUSTED_PROVER_MARKER="$fixture/legacy-prover-ran" PATH="$fixture/fake-bin:/usr/bin:/bin" \
    land_run_meteorite "$fixture/repo" "$candidate_sha" "$legacy_trusted_sha" \
      >"$fixture/legacy-trusted.out" 2>&1; then
  echo 'trusted tree without budget policy unexpectedly passed meteorite gate' >&2; exit 1
fi
grep -Fq 'LAND meteorite blocker=trusted-budget-unavailable' "$fixture/legacy-trusted.out"
test ! -e "$fixture/legacy-prover-ran" || {
  echo 'prover ran before its trusted budget policy was available' >&2; exit 1;
}
cp "$root/meteorite/budget.sh" "$fixture/repo/meteorite/budget.sh"
cp "$root/meteorite/stage-budgets.tsv" "$fixture/repo/meteorite/stage-budgets.tsv"
git -C "$fixture/repo" add meteorite
git -C "$fixture/repo" commit -m restore-trusted-budget-policy >/dev/null

write_clean_report_prover() {
  local requested_sha="$1" tested_sha="$2"
  cat >"$fixture/repo/meteorite/prove-candidate.sh" <<EOF
#!/usr/bin/env bash
cat >"\$METEORITE_REPORT" <<'REPORT'
- requested SHA: \`$requested_sha\`
- tested SHA: \`$tested_sha\`
- result: clean
- blocker: none
## Stages
- container-start: PASS
- prerequisites: PASS
- clone: PASS
- sha-verification: PASS
- bootstrap-test-prerequisites: PASS
- bootstrap-dry-run: PASS
- bootstrap-install: PASS
- bootstrap-verify-source: PASS
- whisper: PASS
- test-prerequisites: PASS
- full-test-suite: PASS
- unit-drift: PASS
REPORT
EOF
  chmod +x "$fixture/repo/meteorite/prove-candidate.sh"
  git -C "$fixture/repo" add meteorite/prove-candidate.sh
  git -C "$fixture/repo" commit -m trusted-report-prover >/dev/null
  trusted_prover_sha="$(git -C "$fixture/repo" rev-parse HEAD)"
}

# The candidate forges a perfect report and runs nothing. The gate executes the
# trusted pre-merge prover instead, so candidate-authored evidence is irrelevant.
write_clean_report_prover "$candidate_sha" 0000000000000000000000000000000000000000
printf '#!/usr/bin/env bash\nexit 0\n' >"$fixture/repo/meteorite/prove-candidate.sh"
chmod +x "$fixture/repo/meteorite/prove-candidate.sh"
if PATH="$fixture/fake-bin:/usr/bin:/bin" land_run_meteorite "$fixture/repo" "$candidate_sha" "$trusted_prover_sha" >"$fixture/stub.out" 2>&1; then
  echo 'reportless exit-zero prover unexpectedly passed' >&2; exit 1
fi
grep -Fq 'LAND meteorite blocker=rebuild-proof-evidence-invalid' "$fixture/stub.out"

if PATH="$fixture/fake-bin:/usr/bin:/bin" land_run_meteorite "$fixture/repo" "$candidate_sha" "$trusted_prover_sha" >"$fixture/wrong-sha.out" 2>&1; then
  echo 'wrong-SHA report unexpectedly passed' >&2; exit 1
fi
grep -Fq 'LAND meteorite blocker=rebuild-proof-evidence-invalid' "$fixture/wrong-sha.out"

printf '#!/usr/bin/env bash\nprintf "%%s" "- result: clean" >"$METEORITE_REPORT"\n' >"$fixture/repo/meteorite/prove-candidate.sh"
chmod +x "$fixture/repo/meteorite/prove-candidate.sh"
git -C "$fixture/repo" add meteorite/prove-candidate.sh
git -C "$fixture/repo" commit -m trusted-truncated-prover >/dev/null
trusted_prover_sha="$(git -C "$fixture/repo" rev-parse HEAD)"
if PATH="$fixture/fake-bin:/usr/bin:/bin" land_run_meteorite "$fixture/repo" "$candidate_sha" "$trusted_prover_sha" >"$fixture/truncated.out" 2>&1; then
  echo 'truncated report unexpectedly passed' >&2; exit 1
fi
grep -Fq 'LAND meteorite blocker=rebuild-proof-evidence-invalid' "$fixture/truncated.out"

cat >"$fixture/repo/meteorite/prove-candidate.sh" <<'EOF'
#!/usr/bin/env bash
trap '' TERM
(
  trap '' TERM
  exec 9>"$SURVIVOR_LOCK_FILE"
  flock -x 9
  touch "$SURVIVOR_READY_FILE"
  while :; do sleep 1; done
) &
printf '%s\n' "$!" >"$SURVIVOR_PID_FILE"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [[ ! -e "$SURVIVOR_READY_FILE" ]] || break
  sleep 0.01
done
[[ -e "$SURVIVOR_READY_FILE" ]] || exit 98
touch "$FAKE_DOCKER_STATE"
wait
EOF
chmod +x "$fixture/repo/meteorite/prove-candidate.sh"
git -C "$fixture/repo" add meteorite/prove-candidate.sh
git -C "$fixture/repo" commit -m trusted-sleeping-prover >/dev/null
trusted_prover_sha="$(git -C "$fixture/repo" rev-parse HEAD)"
if SURVIVOR_PID_FILE="$fixture/survivor.pid" SURVIVOR_LOCK_FILE="$fixture/survivor.lock" \
    SURVIVOR_READY_FILE="$fixture/survivor.ready" FAKE_DOCKER_STATE="$fixture/container.state" \
    LAND_METEORITE_TIMEOUT_SECONDS=1 LAND_METEORITE_KILL_AFTER_SECONDS=1 \
    PATH="$fixture/fake-bin:/usr/bin:/bin" land_run_meteorite "$fixture/repo" "$candidate_sha" \
      "$trusted_prover_sha" >"$fixture/timeout.out" 2>&1; then
  echo 'hung prover unexpectedly passed' >&2; exit 1
fi
grep -Fq 'LAND meteorite blocker=rebuild-proof-timeout' "$fixture/timeout.out"
grep -Fq 'LAND meteorite budget=1s source=override env=LAND_METEORITE_TIMEOUT_SECONDS tracked=1590s' "$fixture/timeout.out"
grep -Fq 'LAND meteorite kill-after=1s source=override env=LAND_METEORITE_KILL_AFTER_SECONDS' "$fixture/timeout.out"
test ! -e "$fixture/container.state" || { echo 'timed-out meteorite container survived cleanup' >&2; exit 1; }
test -e "$fixture/survivor.ready" || { echo 'survivor rehearsal never held its lock' >&2; exit 1; }
if ! flock -n "$fixture/survivor.lock" true; then
  echo 'timed-out prover child still holds a kernel lock after process-group kill' >&2
  exit 1
fi
survivor_pid=$(cat "$fixture/survivor.pid")
if kill -0 "$survivor_pid" 2>/dev/null; then
  # A container whose PID 1 does not reap orphans retains a dead child as Z.
  # kill -0 answers true for that PID even though the process has no code or
  # file descriptors and cannot hold the lock above. Only a non-zombie is a
  # survivor; unreadable process state fails this rehearsal closed under -e.
  survivor_state=$(awk '{ print $3 }' "/proc/$survivor_pid/stat")
  if [[ "$survivor_state" != Z ]]; then
    echo "timed-out prover child survived process-group kill: $survivor_pid state=$survivor_state" >&2
    exit 1
  fi
fi

write_clean_report_prover "$candidate_sha" "$candidate_sha"

assert_cleanup_blocked() {
  local mode="$1" state count output
  state="$fixture/$mode.container"
  count="$fixture/$mode.ps-count"
  output="$fixture/$mode.out"
  rm -f "$state" "$count"
  if [[ "$mode" == rm-fail || "$mode" == remaining-container ]]; then
    touch "$state"
  fi
  if FAKE_DOCKER_MODE="$mode" FAKE_DOCKER_STATE="$state" FAKE_DOCKER_PS_COUNT_FILE="$count" \
      PATH="$fixture/fake-bin:/usr/bin:/bin" land_run_meteorite "$fixture/repo" \
        "$candidate_sha" "$trusted_prover_sha" >"$output" 2>&1; then
    echo "$mode unexpectedly passed meteorite container cleanup" >&2
    exit 1
  fi
  grep -Fq 'LAND meteorite blocker=container-cleanup-failed' "$output"
}

# Every observation and mutation in the cleanup sequence is fail-closed. The
# final-ps-fail control is the rejected r1 shape: no output, exit 42, after the
# first enumeration succeeded. Testing only `-n "$(docker ps ...)"` discarded
# that exit status and produced a false green.
assert_cleanup_blocked first-ps-fail
assert_cleanup_blocked rm-fail
assert_cleanup_blocked remaining-container
assert_cleanup_blocked final-ps-fail

PATH="$fixture/fake-bin:/usr/bin:/bin" land_run_meteorite "$fixture/repo" "$candidate_sha" "$trusted_prover_sha" >"$fixture/clean.out" 2>&1
grep -Fq 'LAND meteorite budget=1590s source=tracked config=meteorite/stage-budgets.tsv' "$fixture/clean.out"
grep -Fq 'LAND meteorite kill-after=10s source=default' "$fixture/clean.out"
grep -Fq "LAND meteorite status=pass sha=$candidate_sha" "$fixture/clean.out"
printf 'meteorite gate regression: PASS\n'
