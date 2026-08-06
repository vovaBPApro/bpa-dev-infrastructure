#!/usr/bin/env bash
# Publish an exact local candidate just long enough for the isolated meteorite
# container to clone it from the tracked remote. This is the executable
# pre-landing evidence path for changes to the rebuild mechanism.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ref=""
remote="origin"
cleanup_complete=false
preflight=false
donor_branch="v2-deprecated"
donor_sha=""
donor_source=""

usage() {
  printf 'Usage: meteorite/prove-candidate.sh --ref <40-character-commit-sha>\n'
  printf '       meteorite/prove-candidate.sh --preflight\n'
}

# Resolve the donor branch this proof dereferences WITHOUT assuming a local
# branch ref for it. A clone -- which is precisely what a rebuilt host starts
# from -- carries only remote-tracking refs, so the original unqualified
# `v2-deprecated^{commit}` aborted with a bare `fatal:`; gate/land-lib.sh could
# only surface that as the generic `blocker=rebuild-proof-failed`, which named
# neither the missing ref nor the `git branch v2-deprecated origin/v2-deprecated`
# that a human had to type to get past it (workboard V3-5.27, measured
# 2026-08-06 landing ag-v3-5.25-r3 from a fresh clone).
#
# The proof is NOT weakened. The donor must still exist somewhere tracked; all
# three tiers ask a tracked location and the third MATERIALIZES the remote branch
# rather than inventing it. Absence from all three is still a hard refusal -- and
# now a refusal that names the branch and every place it was looked for.
resolve_donor() {
  local branch="$1" resolved
  if resolved=$(git -C "$repo_root" rev-parse --verify --quiet "refs/heads/$branch^{commit}"); then
    donor_sha="$resolved"; donor_source="refs/heads/$branch"; return 0
  fi
  if resolved=$(git -C "$repo_root" rev-parse --verify --quiet "refs/remotes/$remote/$branch^{commit}"); then
    donor_sha="$resolved"; donor_source="refs/remotes/$remote/$branch"; return 0
  fi
  # Last tier: a single-branch or otherwise narrowed clone has no remote-tracking
  # ref either. Fetch the one branch into its remote-tracking position; if the
  # remote does not carry it, this fails and so does the resolution.
  if git -C "$repo_root" fetch --quiet "$remote" "+refs/heads/$branch:refs/remotes/$remote/$branch" >/dev/null 2>&1 &&
     resolved=$(git -C "$repo_root" rev-parse --verify --quiet "refs/remotes/$remote/$branch^{commit}"); then
    donor_sha="$resolved"; donor_source="refs/remotes/$remote/$branch (materialized by fetch)"; return 0
  fi
  return 1
}

require_donor() {
  if resolve_donor "$donor_branch"; then
    return 0
  fi
  printf 'ERROR: meteorite donor branch unresolvable: %s\n' "$donor_branch" >&2
  printf '       missing: refs/heads/%s, refs/remotes/%s/%s, and refs/heads/%s on remote %s\n' \
    "$donor_branch" "$remote" "$donor_branch" "$donor_branch" "$remote" >&2
  return 1
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
    --preflight) preflight=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'ERROR: unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

# Preflight answers exactly one question -- can every ref this proof
# dereferences be resolved here, materializing what is materializable -- and
# answers it with no publication, no container, and no --ref. It is what
# gate/land.sh calls so that a missing donor costs a named refusal before the
# landing mutates anything, instead of a bare `fatal:` inside the prover.
if [[ "$preflight" == true ]]; then
  require_donor || exit 2
  printf '[meteorite-preflight] donor=%s sha=%s resolved-from=%s\n' "$donor_branch" "$donor_sha" "$donor_source"
  exit 0
fi

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
require_donor || exit 2
donor_ref="refs/meteorite-candidates/$publication_id/$donor_branch"
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
