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
Usage: reap.sh <branches|remote-branches|worktrees|meteorite-refs> [options]

Options:
  --repo PATH           Git repository (default: current directory)
  --main BRANCH         Default/main branch, always protected (default: main)
  --protect NAME        Additional protected branch name; repeatable
  --stale-days DAYS     Report unmerged branches older than DAYS (default: 30)
  --dispositions PATH   Override the branch-disposition exceptions file
  --protected-file PATH ADD another protected-branches list; never replaces
                         the default one (see below)
  --apply               Perform the narrowly defined mutations
  --remote NAME         Remote swept by remote-branches and meteorite-refs,
                         and enumerated by branches (default: origin)
  --max-age-seconds N   Minimum meteorite-ref age (default: 86400)
  --with-worktrees      `branches` may remove a provably TERMINAL worktree in
                         order to delete the branch it holds (worktree first).
                         Without it, any worktree refuses its branch, as before.
  --terminal            `worktrees` may remove provably TERMINAL worktrees, not
                         only prune orphaned metadata. Classification is always
                         reported; this flag is what allows the removal.
  --liveness-cmd CMD    Installation-specific liveness probe, run as
                         `CMD <worktree-path> <branch>` immediately before every
                         removal. Exit 0 means the lane is LIVE and the worktree
                         is refused; exit 1 means terminal; ANY other exit, or a
                         command that cannot be run, is UNKNOWN and refuses.
  --proc-root PATH      Root of the proc filesystem used by the process probe
                         (default: /proc). Unreadable means UNKNOWN, not empty.
  -h, --help            Show this help without changing anything

All commands are dry-run by default. A branch is deleted under --apply only
when it is not protected, not held by any worktree (see --with-worktrees), and
either provably carried by the main branch (land_assert_reap_safe) or
explicitly dispositioned. Everything else is report-only, unconditionally.

A worktree is TERMINAL only when every one of these holds, re-measured at the
moment of removal and never once at the start of the sweep: it is not the main
worktree; it is not locked; its directory exists and is clean including
untracked files; it has no in-progress rebase/merge/cherry-pick/revert/bisect;
no process anywhere on the host has a working directory inside it; and
--liveness-cmd, if given, says the lane is not running. Anything unreadable or
unmeasurable is UNKNOWN, and UNKNOWN refuses.

The default protected-branches list (instance/hygiene-protected-branches.txt,
or PROTECT_BRANCHES_FILE) and, if given, --protected-file must each be
readable, even if empty of names beyond comments: `branches` refuses to run
at all if either cannot be read. An unreadable protect list is never treated
as an empty one -- see load_protected_file in this script. --protected-file
is additive only: it can only add protected names on top of the default
list, never remove or replace it, so a caller cannot silently drop
protection by pointing it at an empty file.
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
remote="origin"
max_age_seconds=86400
with_worktrees=false
remove_terminal=false
liveness_cmd=""
proc_root="/proc"
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
    --remote) remote="${2:?--remote requires a name}"; shift 2 ;;
    --max-age-seconds) max_age_seconds="${2:?--max-age-seconds requires a number}"; shift 2 ;;
    --with-worktrees) with_worktrees=true; shift ;;
    --terminal) remove_terminal=true; shift ;;
    --liveness-cmd) liveness_cmd="${2:?--liveness-cmd requires a command}"; shift 2 ;;
    --proc-root) proc_root="${2:?--proc-root requires a path}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done
[[ "$stale_days" =~ ^[0-9]+$ ]] || die "--stale-days must be a non-negative integer"
[[ "$max_age_seconds" =~ ^[0-9]+$ ]] || die "--max-age-seconds must be a non-negative integer"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
own_root="$(cd "$script_dir/.." && pwd)"
# shellcheck source=gate/land-lib.sh
source "$own_root/gate/land-lib.sh"

git_repo() {
  repo="$(cd "$repo" && pwd)"
  git -C "$repo" rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "not a git repository: $repo"
}

# Protected-branch set: the default branch, every --protect flag, every
# non-comment, non-blank line of instance/hygiene-protected-branches.txt (this
# script's own repo, not necessarily --repo -- the list is a fact about this
# installation, not about whatever fixture is being swept), and, if given,
# every non-comment, non-blank line of --protected-file.
#
# FAIL CLOSED, deliberately: an unreadable protect list is never treated as an
# empty one. "I could not read the protect list" and "the protect list is
# empty" are different facts, and collapsing them silently is the single
# worst failure mode this script has -- in this repository it is the
# difference between refusing to run and deleting `v2-deprecated` or `v3`,
# the only copies of the host rebuild path and the current line.
#
# --protected-file is UNION-ONLY, never a replacement for the default list.
# A caller may only ADD protections, never remove one by pointing at a
# different (or empty) file: a legitimate, readable, empty override file
# would otherwise pass every check and silently drop every default
# protection, which is functionally an undocumented bypass flag even though
# no flag was named "bypass". There is still no way to opt out of the
# default list at all -- if a caller genuinely has nothing to add beyond it,
# the fix is to simply not pass --protected-file.
declare -A protected_set=()
load_protected_file() {
  local list_path="$1" name
  # Require a regular, readable file -- not just `-r`. A directory at this
  # path is also "-r" true (root can list it) but `read ... < "$list_path"`
  # fails with EISDIR *inside* the while loop, which does not trip `set -e`
  # (a while-condition's exit status is exempt), so the loop would silently
  # behave exactly like an empty file: the same fail-open outcome as an
  # unreadable path, one step removed. Reject it here instead.
  if [[ ! -f "$list_path" || ! -r "$list_path" ]]; then
    die "protected-branches list is not a readable regular file: $list_path -- refusing to reap with an unverifiable protect list (this is not the same as an empty list; create the file, even comments-only, or pass --protected-file explicitly)"
  fi
  # `read -r name || [[ -n "$name" ]]`, not a bare `read -r name`: `read`
  # returns nonzero at EOF even on a line it successfully populated, so a
  # file whose last line has no trailing newline (a `printf` append, or an
  # editor that doesn't force one) would otherwise make the loop CONDITION
  # false before the body ever runs for that line -- silently dropping the
  # last name from protected_set with no error, no crash, exit 0. That is
  # not "fails closed", it is a protected branch quietly losing protection,
  # which is worse: `v3` reproducibly deleted this way. `|| [[ -n "$name" ]]`
  # keeps the loop going for exactly one more (partial, final) iteration when
  # `read` hit EOF but still captured content.
  while IFS= read -r name || [[ -n "$name" ]]; do
    name="${name%%#*}"
    name="${name#"${name%%[![:space:]]*}"}"
    name="${name%"${name##*[![:space:]]}"}"
    # `if ... fi`, deliberately not `[[ ... ]] && ...`: an untaken `&&`
    # right-hand side makes the LEFT side's failure the exit status of the
    # whole expression, which (as the loop body's last statement, under
    # `set -e`, called as a bare statement) silently kills the entire script
    # the moment a trailing blank or comment line is the last line read --
    # exactly the class of defect this file exists to prevent, just aimed at
    # itself. `if` with no branch taken always returns 0.
    if [[ -n "$name" ]]; then
      protected_set["$name"]=1
    fi
  done < "$list_path"
}
load_protected() {
  protected_set["$main_branch"]=1
  local name
  for name in "${extra_protect[@]}"; do protected_set["$name"]=1; done
  local default_list="${PROTECT_BRANCHES_FILE:-$own_root/instance/hygiene-protected-branches.txt}"
  load_protected_file "$default_list"
  if [[ -n "$protected_path" ]]; then
    load_protected_file "$protected_path"
  fi
}
is_protected() { [[ -n "${protected_set["$1"]:-}" ]]; }

# Explicit disposition lookup, same shape as
# instance/decisions/ported-exceptions.txt: `<branch> <reason>` per line.
disposition_reason() {
  local branch="$1"
  local list_path="${dispositions_path:-${DISPOSITIONS_FILE:-$own_root/instance/hygiene-branch-dispositions.txt}}"
  [[ -r "$list_path" ]] || return 1
  local line
  # Same `|| [[ -n "$line" ]]` fix as load_protected_file, for the same
  # reason: a disposition on the last, unterminated line of the file would
  # otherwise be silently invisible to `read`. Lower severity here than the
  # protect-list case -- a missed disposition fails TOWARD safety (the
  # branch stays report-only forever instead of being deleted), not away
  # from it -- but the same fix keeps the two loops honest with each other.
  while IFS= read -r line || [[ -n "$line" ]]; do
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

# --- terminal-worktree machinery -------------------------------------------
#
# Why this exists at all: before it, `worktrees` pruned only ORPHANED metadata
# (`git worktree prune`), so a terminal lane whose directory still existed kept
# its branch checked out forever, and git refuses to delete a checked-out
# branch. The reaper would run, exit 0, print "no orphaned worktrees", and
# remove nothing -- reporting success while being structurally unable to do the
# job. That deadlock, not neglect, is why this repository reached 80 branches
# and 71 worktrees.
#
# Everything below classifies a worktree as TERMINAL or refuses. There is no
# third answer: unreadable, unmeasurable and "the probe itself failed" are all
# refusals, because the cost of a wrong "terminal" is deleting work nobody has
# a copy of, and the cost of a wrong "live" is one more sweep.

# Is any process on the host working inside this directory?
#   0 = nothing inside; 1 = a process is inside; 2 = UNKNOWN.
# Both 1 and 2 refuse at every call site. A pid that vanishes between the glob
# and the readlink is genuinely gone and ignored; a pid that is STILL THERE
# whose cwd we could not read is ambiguity, and ambiguity is never absence.
processes_inside() {
  local path="$1" real pid entry target proc_state unknown_pid=""
  real="$(cd "$path" 2>/dev/null && pwd -P)" || { printf 'worktree-path-unresolvable\n'; return 2; }
  [[ -n "$real" ]] || { printf 'worktree-path-unresolvable\n'; return 2; }
  if [[ ! -d "$proc_root" || ! -r "$proc_root" ]]; then
    printf 'proc-root-unreadable=%s\n' "$proc_root"
    return 2
  fi
  for entry in "$proc_root"/[0-9]*; do
    pid="${entry##*/}"
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    [[ -d "$entry" ]] || continue
    # Plain readlink, not `readlink -f`: /proc/<pid>/cwd is already the
    # kernel's fully-resolved path, and `-f` FAILS outright when the directory
    # has been deleted -- which would turn "a process is sitting in a deleted
    # worktree" into an unreadable-cwd UNKNOWN for no reason.
    if ! target="$(readlink "$entry/cwd" 2>/dev/null)" || [[ -z "$target" ]]; then
      # An unreadable cwd is only ambiguous if the process could HAVE one.
      # Measured on this host: a zombie's /proc/<pid>/cwd readlink fails
      # outright, while a kernel thread's resolves to "/". A reaper that called
      # every zombie "unknown" would refuse every worktree on any busy host and
      # look exactly like a working fail-closed guard while never reaping
      # anything -- the same report-success-do-nothing failure this whole
      # change exists to remove. So: gone or reaped-but-not-waited is ignored;
      # anything else genuinely unreadable stays UNKNOWN.
      if ! proc_state="$(cat "$entry/stat" 2>/dev/null)"; then continue ; fi
      # comm (field 2) is parenthesised and may itself contain spaces and ')',
      # so everything after the LAST ') ' is fixed-position; state is first
      # there. Same parse as orchestrator/proc-identity.sh, for the same reason.
      proc_state="${proc_state##*) }"
      [[ "${proc_state%% *}" == "Z" ]] && continue
      unknown_pid="$pid"
      continue
    fi
    target="${target% (deleted)}"
    if [[ "$target" == "$real" || "$target" == "$real"/* ]]; then
      printf 'process-working-inside pid=%s cwd=%s\n' "$pid" "$target"
      return 1
    fi
  done
  if [[ -n "$unknown_pid" ]]; then
    printf 'process-cwd-unreadable pid=%s\n' "$unknown_pid"
    return 2
  fi
  return 0
}

# Prints NOTHING and returns 0 when the worktree is provably terminal;
# otherwise prints the single decisive reason and returns 1.
#
# Every caller must call this again IMMEDIATELY BEFORE the removal it
# authorizes, never once at the top of a sweep: lanes finish -- and lanes
# START -- while a sweep is running, so a verdict computed at plan time is a
# statement about a repository that no longer exists by the time it is used.
worktree_is_terminal() {
  local path="$1" branch="$2" worktree_list="$3"
  local main_worktree status_out git_dir marker probe rc=0
  main_worktree="$(awk '$1 == "worktree" { print $2; exit }' <<< "$worktree_list")"
  if [[ "$path" == "$main_worktree" ]]; then printf 'main-worktree\n'; return 1; fi
  if awk -v want="$path" '
        $1 == "worktree" { p = $2 }
        $1 == "locked" && p == want { found = 1 }
        END { exit found ? 0 : 1 }' <<< "$worktree_list"; then
    printf 'locked\n'; return 1
  fi
  if [[ ! -d "$path" ]]; then printf 'directory-missing (orphan metadata; prune handles this)\n'; return 1; fi
  if ! status_out="$(git -C "$path" status --porcelain --untracked-files=normal 2>&1)"; then
    printf 'status-unreadable\n'; return 1
  fi
  if [[ -n "$status_out" ]]; then printf 'dirty-worktree\n'; return 1; fi
  if ! git_dir="$(git -C "$path" rev-parse --absolute-git-dir 2>/dev/null)"; then
    printf 'git-dir-unreadable\n'; return 1
  fi
  for marker in rebase-merge rebase-apply MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD BISECT_LOG; do
    if [[ -e "$git_dir/$marker" ]]; then printf 'operation-in-progress=%s\n' "$marker"; return 1; fi
  done
  probe="$(processes_inside "$path")" || rc=$?
  if (( rc != 0 )); then printf '%s\n' "${probe:-process-probe-failed}"; return 1; fi
  if [[ -n "$liveness_cmd" ]]; then
    # `"$@"` appended so the probe may carry its own flags. Exit 0 means the
    # lane IS running (a liveness check that PASSES found something alive), so
    # 0 is the refusal here; 1 is the only value that permits removal, and
    # every other value -- including 127, "no such command" -- is UNKNOWN.
    rc=0
    bash -c "$liveness_cmd \"\$@\"" _ "$path" "$branch" >/dev/null 2>&1 || rc=$?
    case "$rc" in
      0) printf 'liveness-cmd reports the lane is RUNNING\n'; return 1 ;;
      1) : ;;
      *) printf 'liveness-cmd exit=%s (UNKNOWN, refusing)\n' "$rc"; return 1 ;;
    esac
  fi
  return 0
}

# Re-measures and then removes. Never `git worktree remove --force`: the
# unforced form independently refuses a dirty tree, which is a second,
# git-owned layer under our own dirty check rather than a duplicate of it.
remove_terminal_worktree() {
  local path="$1" branch="$2" fresh_list reason rc=0
  fresh_list="$(git -C "$repo" worktree list --porcelain)"
  reason="$(worktree_is_terminal "$path" "$branch" "$fresh_list")" || rc=$?
  if (( rc != 0 )); then
    say "worktree stopped being terminal between classification and removal, refusing: $path ($reason)"
    return 1
  fi
  say "removing terminal worktree: $path"
  if git -C "$repo" worktree remove "$path" >/dev/null 2>&1; then
    say "removed terminal worktree: $path"
    return 0
  fi
  say "git refused to remove the worktree, retaining: $path"
  return 1
}

# --- deletion primitives ----------------------------------------------------
#
# There is deliberately no `git branch -D` anywhere in this script. A `-d`
# refusal is EVIDENCE, not an obstacle: it usually means the premise is wrong
# -- most often a stale origin/* ref -- so the response is to fetch and
# re-measure, never to force. `-D` is what turns a reaper into a
# work-destroyer, and it is the one command this tool must never learn.
#
# `git update-ref -d <ref> <sha>` appears below and is NOT a disguised `-D`.
# `-d` judges merged-ness against the CURRENT HEAD; this script has already
# judged it against $main_branch with land_assert_reap_safe, which is strictly
# stronger (it also accepts a squash- or cherry-pick-landed branch, which is
# carried but not an ancestor) -- or the operator has dispositioned the branch
# by hand, which is a judgement `-d` has no way to see at all. Naming the exact
# expected sha makes the delete a compare-and-swap that FAILS if the branch
# moved since it was measured; `-D` would happily delete the newer tip.
delete_local_branch() {
  local branch="$1" label="$2" proven="$3" sha out
  sha="$(git -C "$repo" rev-parse "refs/heads/$branch")"
  if out="$(git -C "$repo" branch -d "$branch" 2>&1)"; then
    say "deleted $label: $branch ($sha)"
    return 0
  fi
  say "git refused -d for $branch, re-measuring rather than forcing"
  if git -C "$repo" remote get-url "$remote" >/dev/null 2>&1; then
    git -C "$repo" fetch --prune --quiet "$remote" 2>/dev/null ||
      say "fetch from $remote failed; re-measuring against local state only: $branch"
  fi
  if [[ "$(git -C "$repo" rev-parse "refs/heads/$branch")" != "$sha" ]]; then
    say "branch moved while being reaped, retaining: $branch"
    return 1
  fi
  if out="$(git -C "$repo" branch -d "$branch" 2>&1)"; then
    say "deleted $label after re-measuring: $branch ($sha)"
    return 0
  fi
  if [[ -z "$proven" ]]; then
    say "retaining branch, safety not independently proven: $branch (git: ${out##*$'\n'})"
    return 1
  fi
  say "git -d judges against HEAD; deleting the exact measured ref instead ($proven): $branch"
  if git -C "$repo" update-ref -d "refs/heads/$branch" "$sha" 2>/dev/null; then
    say "deleted $label: $branch ($sha)"
    return 0
  fi
  say "exact-ref delete refused, retaining: $branch"
  return 1
}

delete_remote_branch() {
  local branch="$1" sha="$2" label="$3"
  # --force-with-lease pins the exact tip measured moments ago: anything pushed
  # to that branch in between makes the remote REFUSE the delete instead of
  # racing it away. On a delete refspec this is the only compare-and-swap git
  # offers, and without it a remote delete is unconditional by construction.
  if git -C "$repo" push --force-with-lease="refs/heads/$branch:$sha" "$remote" --delete "$branch" >/dev/null 2>&1; then
    say "deleted $label: $remote/$branch ($sha)"
    return 0
  fi
  say "remote refused the delete (tip moved since it was measured?), retaining: $remote/$branch"
  return 1
}

# The content half of gate/land-lib.sh's land_assert_reap_safe, for revisions
# that have NO local branch ref -- exactly the remote-only case that function
# refuses by design (detail=remote-only). Same two tests, same meaning:
# `git cherry` compares stable patch ids, so a commit replayed or squashed onto
# main is carried even when the tip is not an ancestor; a `+` means the branch
# still holds a patch with no equivalent on the target. Coupling note: if that
# function's content test changes, change this with it.
#   0 = carried by target; 1 = holds unique content; 2 = could not be measured.
content_carried() {
  local candidate="$1" target="$2" cherry_output unique_merges
  cherry_output="$(git -C "$repo" cherry "$target" "$candidate" 2>/dev/null)" || return 2
  unique_merges="$(git -C "$repo" rev-list --merges "$target..$candidate" 2>/dev/null)" || return 2
  if [[ "$cherry_output" == *"+ "* ]]; then return 1; fi
  if [[ -n "$unique_merges" ]]; then return 1; fi
  return 0
}

remote_heads_bounded() {
  # A hygiene sweep runs from a timer; an unreachable remote must fail, not
  # hang forever holding the lock.
  if command -v timeout >/dev/null 2>&1; then
    timeout 30 git -C "$repo" ls-remote --heads "$remote"
  else
    git -C "$repo" ls-remote --heads "$remote"
  fi
}

reap_branches() {
  git_repo
  git -C "$repo" show-ref --verify --quiet "refs/heads/$main_branch" || die "main branch not found: $main_branch"
  load_protected
  local main_sha branch worktree_list worktree timestamp age now safety_out reason
  local held_worktree rc
  main_sha="$(git -C "$repo" rev-parse "refs/heads/$main_branch")"
  now="$(date +%s)"
  worktree_list="$(git -C "$repo" worktree list --porcelain)"
  while IFS= read -r branch; do
    if is_protected "$branch"; then
      say "protected branch, refusing: $branch"
      continue
    fi
    held_worktree=""
    worktree="$(worktree_for_branch "$branch" "$worktree_list")"
    if [[ -n "$worktree" ]]; then
      # Default, unchanged: ANY worktree refuses its branch outright. Removing
      # a worktree is a second destructive act on top of a branch delete, so it
      # stays behind an explicit flag rather than arriving with an upgrade.
      if ! "$with_worktrees"; then
        say "held by live worktree, refusing: $branch (worktree: $worktree)"
        continue
      fi
      rc=0
      reason="$(worktree_is_terminal "$worktree" "$branch" "$worktree_list")" || rc=$?
      if (( rc != 0 )); then
        say "held by live worktree, refusing: $branch (worktree: $worktree, $reason)"
        continue
      fi
      say "terminal worktree holds branch: $branch (worktree: $worktree)"
      held_worktree="$worktree"
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
        # Worktree FIRST: git will not delete a checked-out branch, so the
        # order is not cosmetic -- it is the whole reason the branch was
        # unreapable. If the worktree cannot be removed, the branch is not
        # touched either.
        if [[ -n "$held_worktree" ]] && ! remove_terminal_worktree "$held_worktree" "$branch"; then
          say "leaving branch in place because its worktree survived: $branch"
          continue
        fi
        say "deleting merged branch: $branch"
        delete_local_branch "$branch" "merged branch" "carried-by=$main_sha" || true
      fi
      continue
    fi
    if reason="$(disposition_reason "$branch")"; then
      say "dispositioned branch: $branch: $reason"
      if "$apply"; then
        if [[ -n "$held_worktree" ]] && ! remove_terminal_worktree "$held_worktree" "$branch"; then
          say "leaving branch in place because its worktree survived: $branch"
          continue
        fi
        say "deleting dispositioned branch: $branch"
        delete_local_branch "$branch" "dispositioned branch" "operator disposition" || true
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
  report_remote_only_branches
}

# `branches` walks refs/heads and NOTHING ELSE. A branch that exists only on the
# remote has no local ref, so it is invisible to this sweep -- invisible to the
# count as well as to the reaper. An inventory that quietly covers half the
# repository reads exactly like a complete one, which is how a previous sweep
# reported 19 branches of unknown state when the true number was larger. So the
# boundary is stated out loud on every run, whether it can be enumerated or not.
report_remote_only_branches() {
  local heads sha ref branch count=0 rc=0
  if ! git -C "$repo" remote get-url "$remote" >/dev/null 2>&1; then
    say "remote inventory: no remote '$remote' configured -- this sweep covered refs/heads ONLY"
    return 0
  fi
  heads="$(remote_heads_bounded 2>/dev/null)" || rc=$?
  if (( rc != 0 )); then
    say "remote inventory: UNAVAILABLE from '$remote' -- this sweep covered refs/heads ONLY, and remote-only branches are neither counted nor reaped"
    return 0
  fi
  while read -r sha ref; do
    [[ -n "${ref:-}" ]] || continue
    branch="${ref#refs/heads/}"
    git -C "$repo" show-ref --verify --quiet "refs/heads/$branch" && continue
    say "remote-only branch, invisible to refs/heads: $remote/$branch"
    count=$((count + 1))
  done < <(printf '%s\n' "$heads")
  say "remote-only branches: $count (out of scope for 'branches'; use: reap.sh remote-branches --remote $remote)"
}

reap_remote_branches() {
  git_repo
  git -C "$repo" remote get-url "$remote" >/dev/null 2>&1 || die "no such remote: $remote"
  load_protected
  # Fetch before measuring anything. Every judgement below is made against refs
  # refreshed seconds ago, never against whatever refs/remotes/* happened to be
  # lying around -- a stale origin/* ref is the single most common reason a
  # branch looks unmerged (or, far worse, looks merged) when it is not.
  git -C "$repo" fetch --prune --quiet "$remote" ||
    die "cannot fetch $remote; refusing to reap remote branches on stale measurements"
  local main_ref="refs/remotes/$remote/$main_branch"
  git -C "$repo" show-ref --verify --quiet "$main_ref" || die "main branch not found on remote: $remote/$main_branch"
  local main_sha heads worktree_list sha ref branch worktree reason rc
  main_sha="$(git -C "$repo" rev-parse "$main_ref")"
  heads="$(remote_heads_bounded)" || die "cannot enumerate branches on remote: $remote"
  worktree_list="$(git -C "$repo" worktree list --porcelain)"
  while read -r sha ref; do
    [[ -n "${ref:-}" ]] || continue
    branch="${ref#refs/heads/}"
    if is_protected "$branch"; then
      say "protected remote branch, refusing: $remote/$branch"
      continue
    fi
    # A branch belonging to a RUNNING lane is refused even when its content is
    # carried: the lane is still writing, and its next commit is work that the
    # measurement a moment ago cannot possibly have covered.
    worktree="$(worktree_for_branch "$branch" "$worktree_list")"
    if [[ -n "$worktree" ]]; then
      rc=0
      reason="$(worktree_is_terminal "$worktree" "$branch" "$worktree_list")" || rc=$?
      if (( rc != 0 )); then
        say "remote branch held by a live lane, refusing: $remote/$branch (worktree: $worktree, $reason)"
        continue
      fi
    fi
    rc=0
    content_carried "$sha" "$main_sha" || rc=$?
    case "$rc" in
      0)
        say "merged remote branch: $remote/$branch (carried-by=$main_sha)"
        if "$apply"; then
          say "deleting merged remote branch: $remote/$branch"
          delete_remote_branch "$branch" "$sha" "merged remote branch" || true
        fi
        ;;
      1)
        if reason="$(disposition_reason "$branch")"; then
          say "dispositioned remote branch: $remote/$branch: $reason"
          if "$apply"; then
            say "deleting dispositioned remote branch: $remote/$branch"
            delete_remote_branch "$branch" "$sha" "dispositioned remote branch" || true
          fi
        else
          say "unmerged remote branch (report-only, no disposition): $remote/$branch"
        fi
        ;;
      *)
        say "remote branch could not be measured, refusing: $remote/$branch"
        ;;
    esac
  done < <(printf '%s\n' "$heads")
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
  report_worktrees
}

# Classification is ALWAYS reported, on every run, flag or no flag: the point of
# the tool is that its inventory is honest even when it is not permitted to act.
# Removal happens only with --apply --terminal.
report_worktrees() {
  local worktree_list main_worktree path branch reason rc
  worktree_list="$(git -C "$repo" worktree list --porcelain)"
  main_worktree="$(awk '$1 == "worktree" { print $2; exit }' <<< "$worktree_list")"
  while IFS=$'\t' read -r path branch; do
    [[ -n "${path:-}" ]] || continue
    [[ "$path" == "$main_worktree" ]] && continue
    rc=0
    reason="$(worktree_is_terminal "$path" "$branch" "$worktree_list")" || rc=$?
    if (( rc != 0 )); then
      say "live worktree, refusing: $path (branch: ${branch:-detached}, $reason)"
      continue
    fi
    say "terminal worktree: $path (branch: ${branch:-detached})"
    if "$apply" && "$remove_terminal"; then
      remove_terminal_worktree "$path" "$branch" || true
    elif "$apply"; then
      say "not removing without --terminal: $path"
    fi
  done < <(awk '
    $1 == "worktree" { if (path != "") print path "\t" branch; path = $2; branch = "" }
    $1 == "branch" { sub(/^refs\/heads\//, "", $2); branch = $2 }
    END { if (path != "") print path "\t" branch }
  ' <<< "$worktree_list")
}

reap_meteorite_refs() {
  git_repo
  local now ref created_at age remote_output output=() invalid=false
  now="$(date +%s)"
  remote_output="$(git -C "$repo" ls-remote --refs "$remote" 'refs/meteorite-candidates/*')" || die "cannot enumerate reserved meteorite namespace on remote: $remote"
  while IFS= read -r ref || [[ -n "$ref" ]]; do
    [[ -n "$ref" ]] || continue
    if [[ ! "$ref" =~ ^refs/meteorite-candidates/([0-9]+)-[0-9]+-[0-9a-fA-F]{40}/(candidate|v2-deprecated)$ ]]; then
      say "invalid meteorite ref, refusing unmeasured cleanup: $ref"
      invalid=true
      continue
    fi
    created_at="${BASH_REMATCH[1]}"
    (( created_at <= now )) || { say "future-dated meteorite ref, refusing: $ref"; invalid=true; continue; }
    age=$((now - created_at))
    if (( age < max_age_seconds )); then
      say "active meteorite ref, retaining: $ref (${age}s old)"
      continue
    fi
    say "orphaned meteorite ref: $ref (${age}s old)"
    output+=("$ref")
  done < <(printf '%s\n' "$remote_output" | awk '{print $2}')
  "$invalid" && die "reserved meteorite namespace contains unparseable refs"
  if "$apply"; then
    for ref in "${output[@]}"; do
      git -C "$repo" push "$remote" ":$ref"
      say "deleted orphaned meteorite ref: $ref"
    done
  fi
}

case "$command_name" in
  branches) reap_branches ;;
  remote-branches) reap_remote_branches ;;
  worktrees) reap_worktrees ;;
  meteorite-refs) reap_meteorite_refs ;;
  *) usage >&2; die "unknown subcommand: $command_name" ;;
esac
