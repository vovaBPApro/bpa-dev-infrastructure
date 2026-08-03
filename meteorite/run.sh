#!/usr/bin/env bash
# Clean-machine infrastructure rebuild proof for Hard Floor 5.
#
# Expensive by design: this installs prerequisites in a fresh ubuntu:24.04
# container, clones the public repository without mounting or copying host
# files, runs bootstrap, and executes the complete source suite. It is NOT in
# the default `bun test` sweep. Run it explicitly with:
#   bun run test:meteorite
# Changes to this file, bootstrap/install.sh, bootstrap/check-unit-drift.sh, or
# the rebuild contract require that command as landing evidence.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image="${METEORITE_IMAGE:-ubuntu:24.04}"
report="${METEORITE_REPORT:-$repo_root/reports/meteorite-latest.md}"
keep="${METEORITE_KEEP:-0}"
ref=""
repo_url="${METEORITE_REPO_URL:-}"
cid=""
tested_sha="UNMEASURED"
result="NO-GO"
blocker="runner did not reach a measured stage"
stages=()

usage() {
  cat <<'EOF'
Usage: meteorite/run.sh [--ref <git-ref>] [--repo-url <url>]

The default ref is the current origin/main SHA. The default URL is the tracked
origin remote; public GitHub SSH syntax is converted to its credential-free
HTTPS equivalent. Environment: METEORITE_REPORT, METEORITE_IMAGE,
METEORITE_REPO_URL, METEORITE_KEEP.
EOF
}

while (($#)); do
  case "$1" in
    --ref|--repo-url)
      option="$1"
      if (($# < 2)) || [[ -z "$2" ]]; then
        printf 'ERROR: %s requires a value\n' "$option" >&2
        exit 2
      fi
      if [[ "$option" == "--ref" ]]; then ref="$2"; else repo_url="$2"; fi
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'ERROR: unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

record() { stages+=("$1|$2"); }

write_report() {
  local dir tmp entry
  dir="$(dirname "$report")"
  mkdir -p "$dir"
  tmp="$(mktemp "$dir/.meteorite-latest.XXXXXX")" || return 1
  {
    printf '# Infrastructure meteorite report\n\n'
    printf -- '- tested SHA: `%s`\n' "$tested_sha"
    printf -- '- container image: `%s`\n' "$image"
    printf -- '- result: %s\n' "$result"
    printf -- '- blocker: %s\n\n' "$blocker"
    printf '## Stages\n\n'
    for entry in "${stages[@]}"; do
      printf -- '- %s: %s\n' "${entry%%|*}" "${entry#*|}"
    done
    printf '\n## Explicitly not proven\n\n'
    printf -- '- unit activation — bootstrap stage 1 renders or activates no systemd units.\n'
    printf -- '- watchdog arm — bootstrap stage 1 has no watchdog arm/disarm boundary.\n'
    printf -- '- Telegram transport — no credential is supplied and no authenticated transport is started.\n'
  } > "$tmp"
  mv "$tmp" "$report"
}

teardown() {
  local status=$?
  if [[ -n "$cid" ]]; then
    if [[ "$keep" == "1" ]]; then
      printf '[meteorite] METEORITE_KEEP=1; container retained: %s\n' "$cid"
    else
      docker stop -t 5 "$cid" >/dev/null 2>&1 || true
      docker rm -f "$cid" >/dev/null 2>&1 || true
    fi
  fi
  write_report || printf 'ERROR: could not write report: %s\n' "$report" >&2
  return "$status"
}
trap teardown EXIT

fail() {
  local stage="$1" message="$2"
  record "$stage" "NO-GO"
  blocker="$message"
  printf '[meteorite] NO-GO %s: %s\n' "$stage" "$message" >&2
  return 1
}

if ! command -v git >/dev/null 2>&1; then
  fail "preflight" "git not found on PATH" || true
  exit 1
fi
if ! command -v docker >/dev/null 2>&1; then
  fail "preflight" "docker not found on PATH" || true
  exit 1
fi
if [[ -z "$ref" ]]; then
  ref="$(git -C "$repo_root" rev-parse origin/main 2>/dev/null)" || {
    fail "ref-resolution" "cannot resolve origin/main" || true
    exit 1
  }
fi
if [[ -z "$repo_url" ]]; then
  repo_url="$(git -C "$repo_root" remote get-url origin 2>/dev/null)" || {
    fail "remote-resolution" "cannot read the tracked origin URL" || true
    exit 1
  }
fi
case "$repo_url" in
  git@github.com:*) repo_url="https://github.com/${repo_url#git@github.com:}" ;;
  ssh://git@github.com/*) repo_url="https://github.com/${repo_url#ssh://git@github.com/}" ;;
esac
if [[ ! "$ref" =~ ^[A-Za-z0-9._/@:+-]+$ ]]; then
  fail "argument-validation" "ref contains unsupported characters" || true
  exit 2
fi
if [[ ! "$repo_url" =~ ^[A-Za-z0-9._~:/@%+=,-]+$ ]]; then
  fail "argument-validation" "repository URL contains unsupported characters" || true
  exit 2
fi

run_exec_stage() {
  local stage="$1" command="$2"
  printf '[meteorite] stage: %s\n' "$stage"
  if docker exec "$cid" bash -lc "$command"; then
    record "$stage" "PASS"
    if [[ "$stage" == "clone" ]]; then
      tested_sha="$(docker exec "$cid" git -C /work/source rev-parse HEAD 2>/dev/null)" || {
        fail "sha-verification" "source checkout SHA could not be measured"
        return 1
      }
    fi
    return 0
  fi
  fail "$stage" "$stage command failed"
}

if ! cid="$(docker run -d --rm "$image" sleep infinity)"; then
  fail "container-start" "docker could not start $image" || true
  exit 1
fi
if [[ -z "$cid" ]]; then
  fail "container-start" "docker returned an empty container id" || true
  exit 1
fi
record "container-start" "PASS"

commands=(
  "prerequisites|apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl git gettext-base tmux unzip util-linux"
  "clone|git clone --no-checkout '$repo_url' /work/source && git -C /work/source fetch --depth 1 origin '$ref' && git -C /work/source checkout --detach FETCH_HEAD && git -C /work/source branch meteorite-target HEAD"
  "bootstrap-dry-run|cd /work/source && bash bootstrap/install.sh --dry-run"
  "bootstrap-install|cd /work/source && INSTALL_ROOT=/work/install REPO_URL=/work/source REPO_BRANCH=meteorite-target ENV_FILE=/work/config/orchestrator.env BUN_BIN=/root/.bun/bin/bun RUNTIME_DIR=/work/runtime INFRA_STATE_DB=/work/runtime/state.db bash bootstrap/install.sh"
  "bootstrap-verify-source|cd /work/source && INSTALL_ROOT=/work/install ENV_FILE=/work/config/orchestrator.env BUN_BIN=/root/.bun/bin/bun RUNTIME_DIR=/work/runtime INFRA_STATE_DB=/work/runtime/state.db bash bootstrap/install.sh --verify-source"
  "full-test-suite|cd /work/install && PATH=/root/.bun/bin:\$PATH /root/.bun/bin/bun test"
  "unit-drift|install -d /work/rendered-units && for template in /work/install/bootstrap/units/*.in /work/install/instance/units/*.in; do test -f \"\$template\" || continue; envsubst < \"\$template\" > \"/work/rendered-units/\$(basename \"\${template%.in}\")\"; done && cd /work/install && SYSTEMD_SYSTEM_DIR=/work/rendered-units bash bootstrap/check-unit-drift.sh"
)

for entry in "${commands[@]}"; do
  stage="${entry%%|*}"
  command="${entry#*|}"
  if ! run_exec_stage "$stage" "$command"; then
    exit 1
  fi
done

installed_sha="$(docker exec "$cid" git -C /work/install rev-parse HEAD 2>/dev/null)" || {
  fail "sha-verification" "installed checkout SHA could not be measured" || true
  exit 1
}
if [[ "$installed_sha" != "$tested_sha" ]]; then
  fail "sha-verification" "installed SHA $installed_sha differs from fetched SHA $tested_sha" || true
  exit 1
fi
record "sha-verification" "PASS"
result="clean"
blocker="none"
printf '[meteorite] clean: %s\n' "$tested_sha"
