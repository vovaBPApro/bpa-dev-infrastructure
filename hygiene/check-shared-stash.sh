#!/usr/bin/env bash
# Reject a repository-global stash when sibling worktrees make its ownership
# ambiguous. A single-worktree repository may retain its ordinary stash use.
set -euo pipefail

repo="${1:-.}"

if ! repo_root=$(git -C "$repo" rev-parse --show-toplevel 2>/dev/null); then
  echo "SHARED-STASH status=fail detail=not-a-git-worktree repo=$repo" >&2
  exit 2
fi

if ! worktree_list=$(git -C "$repo_root" worktree list --porcelain); then
  echo "SHARED-STASH status=fail detail=worktree-inventory-unmeasured repo=$repo_root" >&2
  exit 2
fi

worktree_count=$(awk '$1 == "worktree" { count++ } END { print count + 0 }' <<< "$worktree_list")
if ((worktree_count < 1)); then
  echo "SHARED-STASH status=fail detail=worktree-inventory-empty repo=$repo_root" >&2
  exit 2
fi

if ((worktree_count > 1)) && git -C "$repo_root" show-ref --verify --quiet refs/stash; then
  echo "SHARED-STASH status=fail worktrees=$worktree_count hazard=refs/stash-is-repo-global; lanes must use a scratch commit (git commit --no-verify, then git reset --soft HEAD^) instead" >&2
  exit 1
fi

echo "SHARED-STASH status=clean worktrees=$worktree_count"
