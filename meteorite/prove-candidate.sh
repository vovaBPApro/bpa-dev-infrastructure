#!/usr/bin/env bash
# Publish an exact local candidate just long enough for the isolated meteorite
# container to clone it from the tracked remote. This is the executable
# pre-landing evidence path for changes to the rebuild mechanism.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ref=""
remote="origin"
cleanup_complete=false

usage() {
  printf 'Usage: meteorite/prove-candidate.sh --ref <40-character-commit-sha>\n'
}

while (($#)); do
  case "$1" in
    --ref)
      if (($# < 2)) || [[ -z "$2" ]]; then
        printf 'ERROR: --ref requires a value\n' >&2
        exit 2
      fi
      ref="$2"
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'ERROR: unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ ! "$ref" =~ ^[0-9a-fA-F]{40}$ ]]; then
  printf 'ERROR: --ref must be a 40-character commit SHA\n' >&2
  exit 2
fi
ref="${ref,,}"
if [[ "$(git -C "$repo_root" rev-parse "$ref^{commit}")" != "$ref" ]]; then
  printf 'ERROR: candidate SHA is not a local commit: %s\n' "$ref" >&2
  exit 2
fi

remote_url="$(git -C "$repo_root" remote get-url "$remote")"
case "$remote_url" in
  git@github.com:*) clone_url="https://github.com/${remote_url#git@github.com:}" ;;
  ssh://git@github.com/*) clone_url="https://github.com/${remote_url#ssh://git@github.com/}" ;;
  https://*) clone_url="$remote_url" ;;
  *) printf 'ERROR: tracked origin has no credential-free clone URL\n' >&2; exit 2 ;;
esac
created_at="${METEORITE_CREATED_AT:-$(date +%s)}"
[[ "$created_at" =~ ^[0-9]+$ ]] || { printf 'ERROR: METEORITE_CREATED_AT must be epoch seconds\n' >&2; exit 2; }
publication_id="${created_at}-$$-${ref}"
temp_ref="refs/meteorite-candidates/$publication_id/candidate"
donor_sha="$(git -C "$repo_root" rev-parse 'v2-deprecated^{commit}')"
donor_ref="refs/meteorite-candidates/$publication_id/v2-deprecated"
published_refs=("$temp_ref" "$donor_ref")

revise_report_for_leak() {
  local leaked="$1" state_home report tmp
  state_home="${XDG_STATE_HOME:-${HOME:?HOME must be set when XDG_STATE_HOME is unset}/.local/state}"
  report="${METEORITE_REPORT:-$state_home/bpa-dev-infrastructure/evidence/meteorite-latest.md}"
  [[ -f "$report" ]] || return 0
  tmp="$(mktemp "$(dirname "$report")/.meteorite-cleanup.XXXXXX")" || return 1
  awk -v leaked="$leaked" '
    /^- result: / { print "- result: NO-GO"; next }
    /^- blocker: / { print "- blocker: published meteorite ref cleanup failed: " leaked; next }
    { print }
  ' "$report" > "$tmp" && mv "$tmp" "$report"
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  "$cleanup_complete" && exit "$status"
  local published_ref
  for published_ref in "${published_refs[@]}"; do
    if git -C "$repo_root" push "$remote" ":$published_ref"; then
      printf '[meteorite-publish] cleanup: removed %s\n' "$published_ref"
    else
      printf '[meteorite-publish] cleanup: NO-GO removing %s\n' "$published_ref" >&2
      revise_report_for_leak "$published_ref" || printf '[meteorite-publish] cleanup: NO-GO revising report\n' >&2
      status=1
    fi
  done
  cleanup_complete=true
  exit "$status"
}
trap cleanup EXIT INT TERM

for publish_ref in "$temp_ref" "$donor_ref"; do
  if git -C "$repo_root" ls-remote --exit-code "$remote" "$publish_ref" >/dev/null 2>&1; then
    printf 'ERROR: temporary ref already exists; refusing to overwrite: %s\n' "$publish_ref" >&2
    exit 1
  fi
done

printf '[meteorite-publish] mechanism: temporary tracked-remote ref %s\n' "$temp_ref"
git -C "$repo_root" push "$remote" "$ref:$temp_ref"
git -C "$repo_root" push "$remote" "$donor_sha:$donor_ref"
METEORITE_REPO_URL="$clone_url" \
METEORITE_DONOR_SHA="$donor_sha" \
METEORITE_DONOR_REF="$donor_ref" \
METEORITE_SOURCE_MECHANISM="temporary tracked-remote refs $temp_ref and $donor_ref" \
  bash "$repo_root/meteorite/run.sh" --ref "$ref"
