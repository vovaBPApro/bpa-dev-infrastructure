#!/usr/bin/env bash
# Manage disposable product-repository clones and isolated coder worktrees.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="$SCRIPT_DIR/repos.conf"
REPOS_DIR="$SCRIPT_DIR/repos"
LANES_DIR="$SCRIPT_DIR/lanes"

failures=0

usage() {
  printf 'usage: %s {sync|lane <repo> <lane-name>|reap <lane-name>|ls}\n' "$0" >&2
  exit 64
}

valid_name() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]
}

default_branch() {
  local repo=$1 ref branch
  ref="$(git -C "$repo" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)"
  if [[ -n "$ref" ]]; then
    printf '%s\n' "${ref#origin/}"
    return
  fi
  branch="$(git -C "$repo" branch --show-current)"
  if [[ -n "$branch" ]]; then
    printf '%s\n' "$branch"
    return
  fi
  printf 'cannot determine default branch for %s\n' "$repo" >&2
  return 1
}

read_config() {
  local line name url
  [[ -f "$CONFIG" ]] || { printf 'missing config: %s\n' "$CONFIG" >&2; return 1; }
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%%#*}"
    [[ -z "${line//[[:space:]]/}" ]] && continue
    if [[ "$line" != *=* ]]; then
      printf 'invalid config line: %s\n' "$line" >&2
      return 1
    fi
    name="${line%%=*}"
    url="${line#*=}"
    if ! valid_name "$name" || [[ -z "$url" ]]; then
      printf 'invalid repository entry: %s\n' "$line" >&2
      return 1
    fi
    printf '%s\t%s\n' "$name" "$url"
  done < "$CONFIG"
}

sync_repo() {
  local name=$1 url=$2 repo branch
  repo="$REPOS_DIR/$name"
  if [[ ! -e "$repo" ]]; then
    printf 'sync %s: cloning\n' "$name"
    if ! git clone "$url" "$repo"; then
      printf 'FAIL %s: clone failed\n' "$name" >&2
      return 1
    fi
    return 0
  fi
  if [[ ! -d "$repo/.git" ]]; then
    printf 'FAIL %s: target exists but is not a repository\n' "$name" >&2
    return 1
  fi
  if [[ -n "$(git -C "$repo" status --porcelain)" ]]; then
    printf 'FAIL %s: dirty worktree; refusing to clobber local state\n' "$name" >&2
    return 1
  fi
  if ! git -C "$repo" fetch --prune origin; then
    printf 'FAIL %s: fetch failed\n' "$name" >&2
    return 1
  fi
  branch="$(default_branch "$repo")" || return 1
  if ! git -C "$repo" show-ref --verify --quiet "refs/remotes/origin/$branch"; then
    printf 'FAIL %s: origin/%s is missing\n' "$name" "$branch" >&2
    return 1
  fi
  if ! git -C "$repo" merge-base --is-ancestor HEAD "origin/$branch"; then
    printf 'FAIL %s: local HEAD diverged from origin/%s; refusing to clobber local state\n' "$name" "$branch" >&2
    return 1
  fi
  if ! git -C "$repo" switch "$branch"; then
    printf 'FAIL %s: cannot switch to default branch %s\n' "$name" "$branch" >&2
    return 1
  fi
  if ! git -C "$repo" merge --ff-only "origin/$branch"; then
    printf 'FAIL %s: fast-forward failed\n' "$name" >&2
    return 1
  fi
  printf 'sync %s: up to date\n' "$name"
}

sync() {
  local entries name url
  mkdir -p "$REPOS_DIR"
  if ! entries="$(read_config)"; then
    return 1
  fi
  [[ -n "$entries" ]] || return 0
  while IFS=$'\t' read -r name url; do
    if ! sync_repo "$name" "$url"; then
      failures=1
    fi
  done <<< "$entries"
  return "$failures"
}

lane() {
  local repo_name=$1 lane_name=$2 repo branch lane_path
  valid_name "$repo_name" && valid_name "$lane_name" || { printf 'invalid repo or lane name\n' >&2; return 1; }
  repo="$REPOS_DIR/$repo_name"
  lane_path="$LANES_DIR/$lane_name"
  [[ -d "$repo/.git" ]] || { printf 'repository is not synced: %s\n' "$repo_name" >&2; return 1; }
  [[ ! -e "$lane_path" ]] || { printf 'lane already exists: %s\n' "$lane_name" >&2; return 1; }
  branch="$(default_branch "$repo")" || return 1
  git -C "$repo" fetch --prune origin
  if ! git -C "$repo" merge-base --is-ancestor HEAD "origin/$branch"; then
    printf 'repository %s is diverged; run sync after resolving local state\n' "$repo_name" >&2
    return 1
  fi
  if git -C "$repo" show-ref --verify --quiet "refs/heads/ag-$lane_name"; then
    printf 'lane branch already exists: ag-%s\n' "$lane_name" >&2
    return 1
  fi
  mkdir -p "$LANES_DIR"
  git -C "$repo" worktree add -b "ag-$lane_name" "$lane_path" "origin/$branch"
  printf 'lane %s: %s (ag-%s)\n' "$lane_name" "$repo_name" "$lane_name"
}

find_lane_repo() {
  local lane_path=$1 repo record worktree
  for repo in "$REPOS_DIR"/*; do
    [[ -d "$repo/.git" ]] || continue
    while IFS= read -r record; do
      case "$record" in
        worktree\ *)
          worktree="${record#worktree }"
          [[ "$worktree" == "$lane_path" ]] && { printf '%s\n' "$repo"; return 0; }
          ;;
      esac
    done < <(git -C "$repo" worktree list --porcelain)
  done
  return 1
}

reap() {
  local lane_name=$1 lane_path repo branch base unmerged
  valid_name "$lane_name" || { printf 'invalid lane name\n' >&2; return 1; }
  lane_path="$LANES_DIR/$lane_name"
  [[ -d "$lane_path" ]] || { printf 'lane does not exist: %s\n' "$lane_name" >&2; return 1; }
  repo="$(find_lane_repo "$lane_path")" || { printf 'cannot identify owner repository for lane: %s\n' "$lane_name" >&2; return 1; }
  branch="$(git -C "$lane_path" branch --show-current)"
  [[ -n "$branch" ]] || { printf 'lane has detached HEAD: %s\n' "$lane_name" >&2; return 1; }
  base="$(default_branch "$repo")" || return 1
  if ! git -C "$repo" merge-base --is-ancestor "$branch" "origin/$base"; then
    printf 'REFUSE %s: branch %s is not merged into origin/%s\n' "$lane_name" "$branch" "$base" >&2
    unmerged="$(git -C "$repo" log --oneline "origin/$base..$branch")"
    printf '%s\n' "$unmerged" >&2
    return 1
  fi
  git -C "$repo" worktree remove "$lane_path"
  git -C "$repo" branch -d "$branch"
  printf 'reaped %s (%s)\n' "$lane_name" "$branch"
}

list() {
  local repo repo_name sha state lane_path branch base ahead
  for repo in "$REPOS_DIR"/*; do
    [[ -d "$repo/.git" ]] || continue
    repo_name="$(basename "$repo")"
    sha="$(git -C "$repo" rev-parse HEAD)"
    state=clean
    [[ -z "$(git -C "$repo" status --porcelain)" ]] || state=dirty
    printf 'repo\t%s\t%s\t%s\n' "$repo_name" "$sha" "$state"
  done
  for lane_path in "$LANES_DIR"/*; do
    [[ -d "$lane_path/.git" || -f "$lane_path/.git" ]] || continue
    repo="$(find_lane_repo "$lane_path")" || continue
    branch="$(git -C "$lane_path" branch --show-current)"
    base="$(default_branch "$repo")"
    ahead="$(git -C "$repo" rev-list --count "origin/$base..$branch")"
    printf 'lane\t%s\t%s\t%s\t%s\n' "$(basename "$lane_path")" "$(basename "$repo")" "$branch" "$ahead"
  done
}

case "${1:-}" in
  sync) [[ $# -eq 1 ]] || usage; sync ;;
  lane) [[ $# -eq 3 ]] || usage; lane "$2" "$3" ;;
  reap) [[ $# -eq 2 ]] || usage; reap "$2" ;;
  ls) [[ $# -eq 1 ]] || usage; list ;;
  *) usage ;;
esac
