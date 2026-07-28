#!/usr/bin/env bash
# Conservative repository hygiene: report first, mutate only with --apply.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: reap.sh <branches|worktrees|disk> [options]

Options:
  --repo PATH          Git repository (default: current directory)
  --main BRANCH        Main branch for merge checks (default: main)
  --stale-days DAYS    Report unmerged branches/logs older than DAYS (default: 30)
  --root PATH          Root to inspect for disk junk; repeatable (disk only)
  --apply              Perform the narrowly defined mutations
  -h, --help           Show this help without changing anything

All commands are dry-run by default. Unmerged branches are always report-only.
EOF
}

die() { echo "ERROR: $*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }

command_name="${1:-}"
if [[ -z "$command_name" || "$command_name" == "-h" || "$command_name" == "--help" ]]; then usage; exit 0; fi
shift

repo="$PWD"
main_branch="main"
stale_days=30
apply=false
roots=()
while (($#)); do
  case "$1" in
    --repo) repo="${2:?--repo requires a path}"; shift 2 ;;
    --main) main_branch="${2:?--main requires a branch}"; shift 2 ;;
    --stale-days) stale_days="${2:?--stale-days requires a number}"; shift 2 ;;
    --root) roots+=("${2:?--root requires a path}"); shift 2 ;;
    --apply) apply=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done
[[ "$stale_days" =~ ^[0-9]+$ ]] || die "--stale-days must be a non-negative integer"

git_repo() {
  repo="$(cd "$repo" && pwd)"
  git -C "$repo" rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "not a git repository: $repo"
}

reap_branches() {
  git_repo
  git -C "$repo" show-ref --verify --quiet "refs/heads/$main_branch" || die "main branch not found: $main_branch"
  local branch timestamp age now worktree
  now="$(date +%s)"
  while IFS= read -r branch; do
    [[ "$branch" == "$main_branch" ]] && continue
    if git -C "$repo" merge-base --is-ancestor "$branch" "$main_branch"; then
      worktree="$(git -C "$repo" worktree list --porcelain | awk -v wanted="refs/heads/$branch" '
        $1 == "worktree" { path=$2 }
        $1 == "branch" && $2 == wanted { print path; exit }
      ')"
      say "merged branch: $branch${worktree:+ (worktree: $worktree)}"
      if "$apply"; then
        if [[ -n "$worktree" && "$worktree" != "$repo" ]]; then
          say "removing worktree: $worktree"
          git -C "$repo" worktree remove --force "$worktree"
        fi
        say "deleting merged branch: $branch"
        git -C "$repo" branch -d "$branch"
      fi
    else
      timestamp="$(git -C "$repo" log -1 --format=%ct "$branch")"
      age=$(( (now - timestamp) / 86400 ))
      if (( age >= stale_days )); then
        say "unmerged stale branch (report-only): $branch (${age}d old)"
      fi
    fi
  done < <(git -C "$repo" for-each-ref --format='%(refname:short)' refs/heads)
}

reap_worktrees() {
  git_repo
  local output
  output="$(git -C "$repo" worktree prune --dry-run --verbose 2>&1 || true)"
  if [[ -n "$output" ]]; then
    while IFS= read -r line; do say "orphaned worktree metadata: $line"; done <<< "$output"
  else
    say "no orphaned worktrees"
  fi
  if "$apply" && [[ -n "$output" ]]; then
    git -C "$repo" worktree prune --verbose
  fi
}

reap_disk() {
  if ((${#roots[@]} == 0)); then roots=("$repo"); fi
  local root item
  for root in "${roots[@]}"; do
    [[ -d "$root" ]] || die "disk root is not a directory: $root"
    root="$(cd "$root" && pwd)"
    say "disk consumer: $(du -sh "$root" | awk '{print $1}') $root"
    while IFS= read -r -d '' item; do
      say "known junk (__pycache__): $item"
      if "$apply"; then rm -rf -- "$item"; fi
    done < <(find "$root" -type d -name __pycache__ -print0)
    while IFS= read -r -d '' item; do
      say "known junk (old log): $item"
      if "$apply"; then rm -f -- "$item"; fi
    done < <(find "$root" -type f -name '*.log' -mtime "+$stale_days" -print0)
    while IFS= read -r -d '' item; do
      say "known junk (tmp-worktrees): $item"
      if "$apply"; then rm -rf -- "$item"; fi
    done < <(find "$root" -type d -name tmp-worktrees -print0)
  done
}

case "$command_name" in
  branches) reap_branches ;;
  worktrees) reap_worktrees ;;
  disk) reap_disk ;;
  *) usage >&2; die "unknown subcommand: $command_name" ;;
esac
