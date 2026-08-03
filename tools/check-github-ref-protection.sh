#!/usr/bin/env bash
set -euo pipefail

# Verify the aggregate `protected` flag returned by GitHub's branch endpoint.
# GitHub documents that flag as protection from classic branch protection or
# applicable rulesets. This checker does not claim to inspect individual rules.

die() {
  printf 'NO-GO github-ref-protection reason=%s\n' "$1" >&2
  exit 2
}

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || die "git-root-unavailable"
spec=${GITHUB_REF_PROTECTION_SPEC:-"$repo_root/instance/github-protected-refs.tsv"}
[[ -r "$spec" ]] || die "spec-unreadable path=$spec"
[[ -s "$spec" ]] || die "spec-empty path=$spec"

token=${GITHUB_TOKEN:-${GH_TOKEN:-}}
[[ -n "$token" ]] || die "credential-missing set=GITHUB_TOKEN-or-GH_TOKEN"

remote=$(git -C "$repo_root" remote get-url origin 2>/dev/null) || die "origin-remote-unavailable"
case "$remote" in
  git@github.com:*) slug=${remote#git@github.com:} ;;
  https://github.com/*) slug=${remote#https://github.com/} ;;
  ssh://git@github.com/*) slug=${remote#ssh://git@github.com/} ;;
  *) die "origin-remote-not-github remote=$remote" ;;
esac
slug=${slug%.git}
[[ "$slug" == */* && "$slug" != */*/* ]] || die "origin-repository-unparseable"

tmp_body=$(mktemp)
trap 'rm -f "$tmp_body"' EXIT
seen=0
while IFS=$'\t' read -r ref reason || [[ -n "${ref:-}${reason:-}" ]]; do
  [[ -n "${ref:-}" ]] || continue
  [[ "$ref" == \#* ]] && continue
  [[ -n "${reason:-}" ]] || die "spec-row-invalid ref=$ref"
  [[ "$ref" =~ ^[A-Za-z0-9._/-]+$ ]] || die "spec-ref-unsupported ref=$ref"
  ((seen += 1))
  encoded_ref=${ref//\//%2F}
  : >"$tmp_body"
  if ! status=$(curl --silent --show-error --output "$tmp_body" --write-out '%{http_code}' \
    --header "Authorization: Bearer $token" \
    --header 'Accept: application/vnd.github+json' \
    --header 'X-GitHub-Api-Version: 2022-11-28' \
    "https://api.github.com/repos/$slug/branches/$encoded_ref"); then
    die "api-network-error ref=$ref"
  fi
  case "$status" in
    200) ;;
    404) die "ref-absent ref=$ref" ;;
    *) die "api-error ref=$ref status=$status" ;;
  esac
  compact=$(tr -d '[:space:]' <"$tmp_body") || die "api-response-unreadable ref=$ref"
  if [[ "$compact" == *'"protected":true'* ]]; then
    printf 'OK github-ref-protection ref=%s present=true protected=true\n' "$ref"
  elif [[ "$compact" == *'"protected":false'* ]]; then
    die "ref-unprotected ref=$ref"
  else
    die "api-response-unparseable ref=$ref"
  fi
done <"$spec"

((seen > 0)) || die "spec-has-no-refs"
printf 'OK github-ref-protection refs=%d\n' "$seen"
