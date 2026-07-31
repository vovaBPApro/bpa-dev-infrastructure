#!/usr/bin/env bash
# Land a lane branch into the canonical checkout, refusing the mistakes that
# actually happened during the 2026-07-31 fleet run.
#
# Why this exists: the orchestrator ran `git merge` three separate times while
# its shell was inside a LANE WORKTREE. Git happily "merged" the branch into
# itself, reported success, and main never moved — so work was almost reported as
# landed when it was not. It was caught only by re-reading the resulting SHA.
# A second recurring fault: piping git into `tail` inside an `&&` chain, which
# replaces git's exit status with tail's, so a failed merge or push reports
# success.
#
# This script makes both impossible: it verifies it is running in the canonical
# repository (not a worktree), captures the SHA before and after, and FAILS if
# the tip did not actually move.
#
# Usage: orchestrator/fleet/land-branch.sh <branch> [--repo <path>] [--no-push]
set -euo pipefail

BRANCH="${1:-}"
REPO="${REPO:-/root/bpa-dev-infrastructure}"
PUSH=true
shift || true
while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo) REPO="${2:?--repo needs a path}"; shift 2 ;;
    --no-push) PUSH=false; shift ;;
    *) echo "ERROR: unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ -n "$BRANCH" ] || { echo "usage: land-branch.sh <branch> [--repo <path>] [--no-push]" >&2; exit 2; }

cd "$REPO"

# 1. Refuse to run from a linked worktree. `git rev-parse --git-dir` returns a
#    path under .git/worktrees/ when inside one; the canonical checkout returns
#    a plain .git. This is the check that would have caught all three incidents.
git_dir=$(git rev-parse --git-dir)
case "$git_dir" in
  *".git/worktrees/"*)
    echo "REFUSED: $REPO is a linked worktree, not the canonical checkout." >&2
    echo "         Merging here silently no-ops and main never moves." >&2
    exit 3 ;;
esac

current=$(git rev-parse --abbrev-ref HEAD)
[ "$current" = "main" ] || { echo "REFUSED: HEAD is '$current', expected 'main'" >&2; exit 3; }
[ "$(git status --porcelain)" = "" ] || { echo "REFUSED: working tree is dirty" >&2; exit 3; }

before=$(git rev-parse HEAD)

# 2. No pipes. Exit status is git's own.
if ! git merge --ff-only "$BRANCH"; then
  echo "MERGE FAILED (not fast-forward) — rebase '$BRANCH' onto main first" >&2
  exit 1
fi

after=$(git rev-parse HEAD)
if [ "$before" = "$after" ]; then
  echo "REFUSED: merge reported success but HEAD did not move ($before)." >&2
  echo "         Nothing landed. Do not report this branch as landed." >&2
  exit 4
fi

echo "MERGED $BRANCH: $before -> $after"

if [ "$PUSH" = true ]; then
  if ! git push origin main; then
    echo "PUSH FAILED — the merge is local only; do not report it as landed" >&2
    exit 1
  fi
  git fetch -q origin main
  remote=$(git rev-parse origin/main)
  [ "$remote" = "$after" ] || { echo "REFUSED: origin/main ($remote) != local ($after)" >&2; exit 4; }
  echo "PUSHED: origin/main = $after"
fi
