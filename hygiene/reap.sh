#!/usr/bin/env bash
# Conservative repository hygiene: report first, mutate only with --apply.
#
# Ported from v2-deprecated (`git show v2-deprecated:hygiene/reap.sh`) after that
# line accumulated 1372 branches, 1393 worktrees, and 6382 cache directories
# (14 GB, growing ~3.5 GB/day) because the script existed and nothing ran it.
# See instance/workboard.md row V3-1.4 and hygiene/reap.test.ts, which is the
# executor -- the landing gate runs every tracked *.test.ts on every candidate,
# so this script cannot go inert the same way again without a landing failing.
#
# Safety hardening over the donor, none of it a weakening:
#   - "merged" is no longer just `merge-base --is-ancestor`. It reuses
#     gate/land-lib.sh's land_assert_reap_safe, which additionally accepts a
#     branch whose commits are patch-id-equivalent to something already on the
#     target (a squash/cherry-pick landing is not a fast-forward ancestor but
#     is just as safe to delete), and which refuses outright when a branch is
#     remote-only, has a dirty worktree, or cannot be fully inspected.
#   - a branch held by *any* live worktree is refused unconditionally, clean
#     or not. The donor force-removed the worktree and then deleted the
#     branch (`git worktree remove --force`); that is a guess this script no
#     longer makes. A blind periodic sweep does not get to assume a worktree
#     it knows nothing about is abandoned -- that assumption is what
#     gate/land.sh is allowed to make about the one branch it just landed,
#     immediately after landing it, not what this script may assume about
#     branches it has never seen before.
#   - the default branch plus every name in --protect / PROTECT_BRANCHES and
#     the optional instance/hygiene-protected-branches.txt is refused
#     unconditionally, regardless of merge status. This is where install
#     specifics (this repo's `v2-deprecated`, `v3`) live, per CLAUDE.md: the
#     mechanism stays generic, instance/ absorbs the this-installation facts.
#   - an unmerged branch is never deleted unless it is *explicitly*
#     dispositioned in instance/hygiene-branch-dispositions.txt (one
#     `<branch> <reason>` line, same convention as
#     instance/decisions/ported-exceptions.txt). Absence of a disposition is
#     report-only, forever, not a timeout that eventually deletes it.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: reap.sh <branches|worktrees> [options]

Options:
  --repo PATH           Git repository (default: current directory)
  --main BRANCH         Default/main branch, always protected (default: main)
  --protect NAME        Additional protected branch name; repeatable
  --stale-days DAYS     Report unmerged branches older than DAYS (default: 30)
  --dispositions PATH   Override the branch-disposition exceptions file
  --protected-file PATH Override the protected-branches list file
  --apply               Perform the narrowly defined mutations
  -h, --help            Show this help without changing anything

All commands are dry-run by default. A branch is deleted under --apply only
when it is not protected, not held by any worktree, and either provably
carried by the main branch (land_assert_reap_safe) or explicitly dispositioned.
Everything else is report-only, unconditionally.

The protected-branches list (default: instance/hygiene-protected-branches.txt)
must be readable, even if empty of names beyond comments: `branches` refuses
to run at all if it cannot be read. An unreadable protect list is never
treated as an empty one -- see load_protected in this script.
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
dispositions_path=""
protected_path=""
extra_protect=()
while (($#)); do
  case "$1" in
    --repo) repo="${2:?--repo requires a path}"; shift 2 ;;
    --main) main_branch="${2:?--main requires a branch}"; shift 2 ;;
    --protect) extra_protect+=("${2:?--protect requires a branch name}"); shift 2 ;;
    --stale-days) stale_days="${2:?--stale-days requires a number}"; shift 2 ;;
    --dispositions) dispositions_path="${2:?--dispositions requires a path}"; shift 2 ;;
    --protected-file) protected_path="${2:?--protected-file requires a path}"; shift 2 ;;
    --apply) apply=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done
[[ "$stale_days" =~ ^[0-9]+$ ]] || die "--stale-days must be a non-negative integer"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
own_root="$(cd "$script_dir/.." && pwd)"
# shellcheck source=gate/land-lib.sh
source "$own_root/gate/land-lib.sh"

git_repo() {
  repo="$(cd "$repo" && pwd)"
  git -C "$repo" rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "not a git repository: $repo"
}

# Protected-branch set: the default branch, every --protect flag, and every
# non-comment, non-blank line of instance/hygiene-protected-branches.txt (this
# script's own repo, not necessarily --repo -- the list is a fact about this
# installation, not about whatever fixture is being swept).
#
# FAIL CLOSED, deliberately: an unreadable protect list is never treated as an
# empty one. "I could not read the protect list" and "the protect list is
# empty" are different facts, and collapsing them silently is the single
# worst failure mode this script has -- in this repository it is the
# difference between refusing to run and deleting `v2-deprecated` or `v3`,
# the only copies of the host rebuild path and the current line. There is
# deliberately no bypass flag: if a caller genuinely has nothing to protect,
# the fix is an explicit, present, empty (comments-only) file at the resolved
# path, not a missing one.
declare -A protected_set=()
load_protected() {
  protected_set["$main_branch"]=1
  local name
  for name in "${extra_protect[@]}"; do protected_set["$name"]=1; done
  local list_path="${protected_path:-${PROTECT_BRANCHES_FILE:-$own_root/instance/hygiene-protected-branches.txt}}"
  # Require a regular, readable file -- not just `-r`. A directory at this
  # path is also "-r" true (root can list it) but `read ... < "$list_path"`
  # fails with EISDIR *inside* the while loop, which does not trip `set -e`
  # (a while-condition's exit status is exempt), so the loop would silently
  # behave exactly like an empty file: the same fail-open outcome as an
  # unreadable path, one step removed. Reject it here instead.
  if [[ ! -f "$list_path" || ! -r "$list_path" ]]; then
    die "protected-branches list is not a readable regular file: $list_path -- refusing to reap with an unverifiable protect list (this is not the same as an empty list; create the file, even comments-only, or pass --protected-file explicitly)"
  fi
  while IFS= read -r name; do
    name="${name%%#*}"
    name="${name#"${name%%[![:space:]]*}"}"
    name="${name%"${name##*[![:space:]]}"}"
    [[ -n "$name" ]] && protected_set["$name"]=1
  done < "$list_path"
}
is_protected() { [[ -n "${protected_set["$1"]:-}" ]]; }

# Explicit disposition lookup, same shape as
# instance/decisions/ported-exceptions.txt: `<branch> <reason>` per line.
disposition_reason() {
  local branch="$1"
  local list_path="${dispositions_path:-${DISPOSITIONS_FILE:-$own_root/instance/hygiene-branch-dispositions.txt}}"
  [[ -r "$list_path" ]] || return 1
  local line
  while IFS= read -r line; do
    case "$line" in
      ''|'#'*) continue ;;
    esac
    local name="${line%% *}"
    if [[ "$name" == "$branch" ]]; then
      local reason="${line#"$name"}"
      reason="${reason#"${reason%%[![:space:]]*}"}"
      [[ -n "$reason" ]] || return 1
      printf '%s\n' "$reason"
      return 0
    fi
  done < "$list_path"
  return 1
}

worktree_for_branch() {
  local branch="$1" worktree_list="$2"
  awk -v wanted="refs/heads/$branch" '
    $1 == "worktree" { path=$2 }
    $1 == "branch" && $2 == wanted { print path; exit }
  ' <<< "$worktree_list"
}

reap_branches() {
  git_repo
  git -C "$repo" show-ref --verify --quiet "refs/heads/$main_branch" || die "main branch not found: $main_branch"
  load_protected
  local main_sha branch worktree_list worktree timestamp age now safety_out reason
  main_sha="$(git -C "$repo" rev-parse "refs/heads/$main_branch")"
  now="$(date +%s)"
  worktree_list="$(git -C "$repo" worktree list --porcelain)"
  while IFS= read -r branch; do
    if is_protected "$branch"; then
      say "protected branch, refusing: $branch"
      continue
    fi
    worktree="$(worktree_for_branch "$branch" "$worktree_list")"
    if [[ -n "$worktree" ]]; then
      say "held by live worktree, refusing: $branch (worktree: $worktree)"
      continue
    fi
    # Coupling: this is the same land_assert_reap_safe gate/land.sh:270 calls
    # right after a landing merges its one lane branch. A future change to
    # that function changes this script's merge-safety judgment too, in both
    # directions -- see the matching note at its definition in
    # gate/land-lib.sh.
    if safety_out="$(land_assert_reap_safe "$repo" "$branch" "$main_sha" HYGIENE 2>&1)"; then
      say "$safety_out"
      say "merged branch: $branch"
      if "$apply"; then
        say "deleting merged branch: $branch"
        git -C "$repo" branch -D "$branch"
      fi
      continue
    fi
    if reason="$(disposition_reason "$branch")"; then
      say "dispositioned branch: $branch: $reason"
      if "$apply"; then
        say "deleting dispositioned branch: $branch"
        git -C "$repo" branch -D "$branch"
      fi
      continue
    fi
    say "$safety_out"
    timestamp="$(git -C "$repo" log -1 --format=%ct "$branch")"
    age=$(( (now - timestamp) / 86400 ))
    if (( age >= stale_days )); then
      say "unmerged stale branch (report-only, no disposition): $branch (${age}d old)"
    else
      say "unmerged branch (report-only, no disposition): $branch (${age}d old)"
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

case "$command_name" in
  branches) reap_branches ;;
  worktrees) reap_worktrees ;;
  *) usage >&2; die "unknown subcommand: $command_name" ;;
esac
