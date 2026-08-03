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
if FAKE_DOCKER_DAEMON=down PATH="$fixture/fake-bin:/usr/bin:/bin" land_run_meteorite "$fixture/repo" \
    "$(git -C "$fixture/repo" rev-parse ag-broken)" >"$fixture/daemon.out" 2>&1; then
  echo 'dead Docker daemon unexpectedly passed meteorite gate' >&2; exit 1
fi
grep -Fq 'LAND meteorite blocker=docker-daemon-unavailable' "$fixture/daemon.out"

if PATH="$fixture/fake-bin:/usr/bin:/bin" land_run_meteorite "$fixture/repo" \
    "$(git -C "$fixture/repo" rev-parse ag-broken)" >"$fixture/missing-prover.out" 2>&1; then
  echo 'missing candidate prover unexpectedly passed meteorite gate' >&2; exit 1
fi
grep -Fq 'LAND meteorite blocker=candidate-prover-unavailable' "$fixture/missing-prover.out"

cat >"$fixture/repo/meteorite/prove-candidate.sh" <<'EOF'
#!/usr/bin/env bash
echo 'deliberately broken bootstrap fixture' >&2
exit 42
EOF
chmod +x "$fixture/repo/meteorite/prove-candidate.sh"
if TMPDIR="$fixture/missing/report-dir" PATH="$fixture/fake-bin:/usr/bin:/bin" land_run_meteorite "$fixture/repo" \
    "$(git -C "$fixture/repo" rev-parse ag-broken)" >"$fixture/allocation.out" 2>&1; then
  echo 'failed report allocation unexpectedly passed meteorite gate' >&2; exit 1
fi
grep -Fq 'LAND meteorite blocker=report-allocation-failed' "$fixture/allocation.out"

if PATH="$fixture/fake-bin:/usr/bin:/bin" land_run_meteorite "$fixture/repo" \
    "$(git -C "$fixture/repo" rev-parse ag-broken)" >"$fixture/broken.out" 2>&1; then
  echo 'deliberately broken rebuild unexpectedly passed meteorite gate' >&2
  exit 1
fi
grep -Fq 'deliberately broken bootstrap fixture' "$fixture/broken.out"
grep -Fq 'LAND meteorite blocker=rebuild-proof-failed' "$fixture/broken.out"

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
- test-prerequisites: PASS
- full-test-suite: PASS
- unit-drift: PASS
REPORT
EOF
  chmod +x "$fixture/repo/meteorite/prove-candidate.sh"
}

candidate_sha="$(git -C "$fixture/repo" rev-parse ag-broken)"
printf '#!/usr/bin/env bash\nexit 0\n' >"$fixture/repo/meteorite/prove-candidate.sh"
chmod +x "$fixture/repo/meteorite/prove-candidate.sh"
if PATH="$fixture/fake-bin:/usr/bin:/bin" land_run_meteorite "$fixture/repo" "$candidate_sha" >"$fixture/stub.out" 2>&1; then
  echo 'reportless exit-zero prover unexpectedly passed' >&2; exit 1
fi
grep -Fq 'LAND meteorite blocker=rebuild-proof-evidence-invalid' "$fixture/stub.out"

write_clean_report_prover "$candidate_sha" 0000000000000000000000000000000000000000
if PATH="$fixture/fake-bin:/usr/bin:/bin" land_run_meteorite "$fixture/repo" "$candidate_sha" >"$fixture/wrong-sha.out" 2>&1; then
  echo 'wrong-SHA report unexpectedly passed' >&2; exit 1
fi
grep -Fq 'LAND meteorite blocker=rebuild-proof-evidence-invalid' "$fixture/wrong-sha.out"

printf '#!/usr/bin/env bash\nprintf "%%s" "- result: clean" >"$METEORITE_REPORT"\n' >"$fixture/repo/meteorite/prove-candidate.sh"
chmod +x "$fixture/repo/meteorite/prove-candidate.sh"
if PATH="$fixture/fake-bin:/usr/bin:/bin" land_run_meteorite "$fixture/repo" "$candidate_sha" >"$fixture/truncated.out" 2>&1; then
  echo 'truncated report unexpectedly passed' >&2; exit 1
fi
grep -Fq 'LAND meteorite blocker=rebuild-proof-evidence-invalid' "$fixture/truncated.out"

printf '#!/usr/bin/env bash\nsleep 2\n' >"$fixture/repo/meteorite/prove-candidate.sh"
chmod +x "$fixture/repo/meteorite/prove-candidate.sh"
if LAND_METEORITE_TIMEOUT_SECONDS=1 PATH="$fixture/fake-bin:/usr/bin:/bin" land_run_meteorite "$fixture/repo" "$candidate_sha" >"$fixture/timeout.out" 2>&1; then
  echo 'hung prover unexpectedly passed' >&2; exit 1
fi
grep -Fq 'LAND meteorite blocker=rebuild-proof-timeout' "$fixture/timeout.out"

write_clean_report_prover "$candidate_sha" "$candidate_sha"
PATH="$fixture/fake-bin:/usr/bin:/bin" land_run_meteorite "$fixture/repo" "$candidate_sha" >"$fixture/clean.out" 2>&1
grep -Fq "LAND meteorite status=pass sha=$candidate_sha" "$fixture/clean.out"
printf 'meteorite gate regression: PASS\n'
