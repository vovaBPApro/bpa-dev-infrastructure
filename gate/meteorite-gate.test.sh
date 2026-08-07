#!/usr/bin/env bash
set -euo pipefail

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
# shellcheck source=gate/land-lib.sh
source "$root/gate/land-lib.sh"
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT

git init --initial-branch=main "$fixture/repo" >/dev/null
git -C "$fixture/repo" config user.email meteorite@example.test
git -C "$fixture/repo" config user.name Meteorite
mkdir -p "$fixture/repo/bootstrap" "$fixture/repo/instructions" "$fixture/repo/runtime"
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
mkdir -p "$fixture/fake-bin" "$fixture/repo/meteorite"
cat >"$fixture/fake-bin/docker" <<'EOF'
#!/usr/bin/env bash
test "${1:-}" = info && test "${FAKE_DOCKER_DAEMON:-up}" = up
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

# The stage contract the gate reads out of the trusted tree. It has one home --
# `required_stages` in meteorite/run.sh -- so the fixture supplies a runner that
# declares one, exactly as the real prover tree does. Writing it is not
# incidental setup: the list written here is what the report below is judged
# against, which is the property this file exists to check.
write_runner_contract() {
  local stage
  {
    printf '#!/usr/bin/env bash\n'
    printf '# Fixture runner. Only its contract is read by the gate.\n'
    printf 'required_stages=(\n'
    for stage in "$@"; do printf '  %s\n' "$stage"; done
    printf ')\n'
  } >"$fixture/repo/meteorite/run.sh"
}

full_contract=(
  container-start prerequisites clone sha-verification
  bootstrap-test-prerequisites bootstrap-dry-run bootstrap-install
  bootstrap-verify-source whisper test-prerequisites full-test-suite
  unit-drift orchestrator-live
)
write_runner_contract "${full_contract[@]}"

cat >"$fixture/repo/meteorite/prove-candidate.sh" <<'EOF'
#!/usr/bin/env bash
echo 'deliberately broken bootstrap fixture' >&2
exit 42
EOF
chmod +x "$fixture/repo/meteorite/prove-candidate.sh"
git -C "$fixture/repo" add meteorite/prove-candidate.sh meteorite/run.sh
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

# A prover that writes a report naming exactly the stages it is told to name.
# The reported list and the contract list are supplied SEPARATELY on purpose:
# the defect this pair of arguments exists to catch is the two disagreeing.
write_clean_report_prover() {
  local requested_sha="$1" tested_sha="$2"
  shift 2
  local reported=("$@") stage
  {
    printf '#!/usr/bin/env bash\n'
    printf 'cat >"$METEORITE_REPORT" <<%s\n' "'REPORT'"
    printf -- '- requested SHA: `%s`\n' "$requested_sha"
    printf -- '- tested SHA: `%s`\n' "$tested_sha"
    printf -- '- result: clean\n'
    printf -- '- blocker: none\n'
    printf '## Stages\n'
    for stage in "${reported[@]}"; do printf -- '- %s: PASS\n' "$stage"; done
    printf 'REPORT\n'
  } >"$fixture/repo/meteorite/prove-candidate.sh"
  chmod +x "$fixture/repo/meteorite/prove-candidate.sh"
  git -C "$fixture/repo" add meteorite/prove-candidate.sh meteorite/run.sh
  git -C "$fixture/repo" commit -m trusted-report-prover >/dev/null
  trusted_prover_sha="$(git -C "$fixture/repo" rev-parse HEAD)"
}

# The candidate forges a perfect report and runs nothing. The gate executes the
# trusted pre-merge prover instead, so candidate-authored evidence is irrelevant.
write_clean_report_prover "$candidate_sha" 0000000000000000000000000000000000000000 "${full_contract[@]}"
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

printf '#!/usr/bin/env bash\nsleep 2\n' >"$fixture/repo/meteorite/prove-candidate.sh"
chmod +x "$fixture/repo/meteorite/prove-candidate.sh"
git -C "$fixture/repo" add meteorite/prove-candidate.sh
git -C "$fixture/repo" commit -m trusted-sleeping-prover >/dev/null
trusted_prover_sha="$(git -C "$fixture/repo" rev-parse HEAD)"
if LAND_METEORITE_TIMEOUT_SECONDS=1 PATH="$fixture/fake-bin:/usr/bin:/bin" land_run_meteorite "$fixture/repo" "$candidate_sha" "$trusted_prover_sha" >"$fixture/timeout.out" 2>&1; then
  echo 'hung prover unexpectedly passed' >&2; exit 1
fi
grep -Fq 'LAND meteorite blocker=rebuild-proof-timeout' "$fixture/timeout.out"

# ── The backstop's stage list is the runner's, not a second copy ───────────
#
# RED BEFORE: with the list hard-coded in land-lib.sh this case PASSED. That
# copy had drifted to name neither `whisper` nor `orchestrator-live`, so a
# prover exiting 0 over a report missing both was ACCEPTED -- a hole exactly
# where the newest gate is, in the one check whose whole job is to catch a
# prover that exits 0 over a short report. Measured by the r3 review:
# "GATE-VERDICT: ACCEPTED a meteorite report with NO orchestrator-live and NO
# whisper stage". Now the contract is read from the trusted tree, so the report
# is judged against the list the runner actually enforces.
short_report=(
  container-start prerequisites clone sha-verification
  bootstrap-test-prerequisites bootstrap-dry-run bootstrap-install
  bootstrap-verify-source test-prerequisites full-test-suite unit-drift
)
write_clean_report_prover "$candidate_sha" "$candidate_sha" "${short_report[@]}"
if PATH="$fixture/fake-bin:/usr/bin:/bin" land_run_meteorite "$fixture/repo" "$candidate_sha" "$trusted_prover_sha" >"$fixture/drifted.out" 2>&1; then
  echo 'a report missing whisper and orchestrator-live unexpectedly passed' >&2; exit 1
fi
grep -Fq 'LAND meteorite blocker=rebuild-proof-evidence-invalid' "$fixture/drifted.out"

# The same report passes when the runner's contract is the shorter list: the
# gate is reading the contract, not a list of its own. Without this half the
# case above would also pass against a backstop that simply required more.
write_runner_contract "${short_report[@]}"
write_clean_report_prover "$candidate_sha" "$candidate_sha" "${short_report[@]}"
PATH="$fixture/fake-bin:/usr/bin:/bin" land_run_meteorite "$fixture/repo" "$candidate_sha" "$trusted_prover_sha" >"$fixture/shorter-contract.out" 2>&1
grep -Fq "LAND meteorite status=pass sha=$candidate_sha" "$fixture/shorter-contract.out"

# A prover tree that declares no contract is not a prover. Fail closed rather
# than fall back to a list typed into the gate -- the fallback IS the defect.
printf '#!/usr/bin/env bash\n# a runner with no contract at all\n' >"$fixture/repo/meteorite/run.sh"
write_clean_report_prover "$candidate_sha" "$candidate_sha" "${full_contract[@]}"
if PATH="$fixture/fake-bin:/usr/bin:/bin" land_run_meteorite "$fixture/repo" "$candidate_sha" "$trusted_prover_sha" >"$fixture/no-contract.out" 2>&1; then
  echo 'a prover tree declaring no stage contract unexpectedly passed' >&2; exit 1
fi
grep -Fq 'LAND meteorite blocker=trusted-prover-contract-unreadable' "$fixture/no-contract.out"

# The real runner's contract is readable by the real extractor. This is the
# check that keeps the two files from drifting apart in the other direction: a
# rename or a reformat of `required_stages=(` in meteorite/run.sh silently
# empties the list the gate judges against, and that would fail closed on every
# landing -- loudly, but only at landing time.
tracked_contract="$(land_meteorite_required_stages "$root/meteorite/run.sh" | tr '\n' ' ')"
for stage in orchestrator-live whisper full-test-suite container-start; do
  case " $tracked_contract " in
    *" $stage "*) ;;
    *) echo "the tracked meteorite runner's contract does not yield $stage: '$tracked_contract'" >&2; exit 1 ;;
  esac
done

write_runner_contract "${full_contract[@]}"
write_clean_report_prover "$candidate_sha" "$candidate_sha" "${full_contract[@]}"
PATH="$fixture/fake-bin:/usr/bin:/bin" land_run_meteorite "$fixture/repo" "$candidate_sha" "$trusted_prover_sha" >"$fixture/clean.out" 2>&1
grep -Fq "LAND meteorite status=pass sha=$candidate_sha" "$fixture/clean.out"
printf 'meteorite gate regression: PASS\n'
