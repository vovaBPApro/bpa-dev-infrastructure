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
mkdir -p "$fixture/repo/bootstrap" "$fixture/repo/instructions"
printf 'good\n' >"$fixture/repo/bootstrap/install.sh"
printf 'docs\n' >"$fixture/repo/instructions/readme.md"
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
if land_meteorite_required "$fixture/repo" ag-docs; then
  echo 'documentation-only change unexpectedly required meteorite' >&2
  exit 1
fi

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
test "${1:-}" = info
EOF
chmod +x "$fixture/fake-bin/docker"
cat >"$fixture/repo/meteorite/prove-candidate.sh" <<'EOF'
#!/usr/bin/env bash
echo 'deliberately broken bootstrap fixture' >&2
exit 42
EOF
chmod +x "$fixture/repo/meteorite/prove-candidate.sh"
if PATH="$fixture/fake-bin:/usr/bin:/bin" land_run_meteorite "$fixture/repo" \
    "$(git -C "$fixture/repo" rev-parse ag-broken)" >"$fixture/broken.out" 2>&1; then
  echo 'deliberately broken rebuild unexpectedly passed meteorite gate' >&2
  exit 1
fi
grep -Fq 'deliberately broken bootstrap fixture' "$fixture/broken.out"
grep -Fq 'LAND meteorite blocker=rebuild-proof-failed' "$fixture/broken.out"
printf 'meteorite gate regression: PASS\n'
