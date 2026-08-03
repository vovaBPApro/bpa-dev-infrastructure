#!/usr/bin/env bash
# Portable fleet entry point: compose, gate, isolate, and launch one agent lane.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DEFAULT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck disable=SC1091
source "$REPO_DEFAULT/orchestrator/lib.sh"

usage() {
  cat <<'EOF'
Usage: launch-lane.sh --name NAME --role ROLE --task-file FILE [options]

Required:
  --name NAME          Lane name (letters, digits, dots, underscores, hyphens)
  --role ROLE          coder, reviewer, orchestrator, or manager
  --task-file FILE     Markdown task body appended to the composed role pack

Options:
  --repo DIR           Source repository (default: repository containing this script)
  --lanes-dir DIR      Worktree/artifact root (default: ${XDG_CACHE_HOME:-$HOME/.cache}/infra-lanes)
  --base REF           Worktree start ref (default: origin/main)
  --branch BRANCH      Lane branch (default: ag-NAME)
  --agent-command FILE One-argv-entry-per-line command file
                       (blank lines and # comments in column 1 are ignored)
                       (default: AGENT_COMMAND_FILE or instance/lane-agent-command.conf)
  --runtime-config FILE Installation facts: lane user, group, home, and lanes root
                       (default: LANE_RUNTIME_CONFIG or instance/lane-runtime.conf)
EOF
}

die() { printf 'launch-lane: %s\n' "$*" >&2; exit 2; }

name=""; role=""; task_file=""; repo="$REPO_DEFAULT"
lanes_dir=""; runtime_config="${LANE_RUNTIME_CONFIG:-}"
base="origin/main"; branch=""; agent_command_file="${AGENT_COMMAND_FILE:-}"
while (($#)); do
  case "$1" in
    --name) name="${2:-}"; shift 2 ;;
    --role) role="${2:-}"; shift 2 ;;
    --task-file) task_file="${2:-}"; shift 2 ;;
    --repo) repo="${2:-}"; shift 2 ;;
    --lanes-dir) lanes_dir="${2:-}"; shift 2 ;;
    --base) base="${2:-}"; shift 2 ;;
    --branch) branch="${2:-}"; shift 2 ;;
    --agent-command) agent_command_file="${2:-}"; shift 2 ;;
    --runtime-config) runtime_config="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die '--name is missing or invalid'
case "$role" in coder|reviewer|orchestrator|manager) ;; *) die '--role is missing or invalid' ;; esac
[[ -f "$task_file" && -r "$task_file" ]] || die "task file missing or unreadable: $task_file"
repo="$(cd "$repo" && pwd)"
runtime_config="${runtime_config:-$repo/instance/lane-runtime.conf}"
[[ -f "$runtime_config" && -r "$runtime_config" ]] || die "runtime config missing or unreadable: $runtime_config"
lane_user=""; lane_group=""; lane_home=""; configured_lanes_dir=""
while IFS='=' read -r key value || [[ -n "$key$value" ]]; do
  [[ -z "$key" || "$key" == \#* ]] && continue
  case "$key" in
    lane_user) lane_user="$value" ;;
    lane_group) lane_group="$value" ;;
    lane_home) lane_home="$value" ;;
    lanes_dir) configured_lanes_dir="$value" ;;
    *) die "unknown runtime config key: $key" ;;
  esac
done <"$runtime_config"
[[ "$lane_user" =~ ^[a-z_][a-z0-9_-]*$ ]] || die 'runtime config has invalid lane_user'
[[ "$lane_group" =~ ^[a-z_][a-z0-9_-]*$ ]] || die 'runtime config has invalid lane_group'
[[ "$lane_home" == /* && "$configured_lanes_dir" == /* ]] || die 'runtime config paths must be absolute'
lane_uid="$(id -u "$lane_user" 2>/dev/null || true)"
[[ -n "$lane_uid" && "$lane_uid" != 0 ]] || die "lane user is missing or privileged: $lane_user"
getent group "$lane_group" >/dev/null || die "lane group is missing: $lane_group"
[[ -d "$lane_home" ]] || die "lane home is missing: $lane_home"
((EUID == 0)) || die 'lane launcher requires root to establish the requested uid and ownership'
lanes_dir="${lanes_dir:-$configured_lanes_dir}"
[[ -d "$lanes_dir" ]] || die "lanes root is missing: $lanes_dir"
command -v setpriv >/dev/null || die 'setpriv is unavailable; cannot verify lane privilege boundary'
setpriv --reuid="$lane_user" --regid="$lane_group" --clear-groups -- \
  test -x "$lanes_dir" || die "lanes root is not traversable by lane user: $lanes_dir"
agent_command_file="${agent_command_file:-$repo/instance/lane-agent-command.conf}"
[[ -f "$agent_command_file" && -r "$agent_command_file" ]] || die "agent command file missing or unreadable: $agent_command_file"
[[ -x "$BUN_BIN" ]] || die 'Bun is unavailable; install it with bootstrap/install.sh or set BUN_BIN'
command -v systemd-run >/dev/null || die 'systemd-run is unavailable; lane launch requires systemd'

agent_argv=()
while IFS= read -r arg || [[ -n "$arg" ]]; do
  [[ -z "$arg" || "$arg" == \#* ]] && continue
  agent_argv+=("$arg")
done <"$agent_command_file"
((${#agent_argv[@]})) || die "agent command file is empty: $agent_command_file"
if [[ "${agent_argv[0]}" == */* ]]; then
  [[ -x "${agent_argv[0]}" ]] || die "agent executable is unavailable: ${agent_argv[0]}"
else
  agent_argv[0]="$(command -v "${agent_argv[0]}" 2>/dev/null || true)"
  [[ -x "${agent_argv[0]}" ]] || die 'configured agent executable is unavailable'
fi

branch="${branch:-ag-$name}"
worktree="$lanes_dir/$name"
pack_dir="$lanes_dir/pack-$name"
prompt="$lanes_dir/lane-$name.prompt.md"
log="$lanes_dir/lane-$name.log"
unit="lane-$name"
tmp_root="$lanes_dir/tmp"
tmp_dir="$tmp_root/$name"

for artifact in "$worktree" "$pack_dir" "$prompt" "$log" "$tmp_dir"; do
  if [[ -e "$artifact" || -L "$artifact" ]]; then
    die "lane artifact already exists for $name: $artifact"
  fi
done

# The pack directory is both the first artifact and the per-name reservation.
# mkdir is the single atomic winner decision; it also rejects dangling links.
if ! mkdir "$pack_dir"; then
  die "lane artifact already exists for $name: $pack_dir"
fi
launch_complete=false
worktree_created=false
cleanup_failed_launch() {
  "$launch_complete" && return
  if "$worktree_created"; then
    git -C "$repo" worktree remove --force "$worktree" >/dev/null 2>&1 || true
    git -C "$repo" branch -D "$branch" >/dev/null 2>&1 || true
  fi
  rm -f -- "$prompt" "$log"
  rm -rf -- "$pack_dir" "$tmp_dir"
}
trap cleanup_failed_launch EXIT

"$BUN_BIN" "$repo/tools/instructions/compose.ts" --role "$role" --repo "$repo" --out "$pack_dir" >/dev/null
mkdir -p "$pack_dir/runtime/daemon" "$pack_dir/runtime/gate"
cp "$repo/daemon/mask-stream.ts" "$repo/daemon/secret-masker.ts" "$pack_dir/runtime/daemon/"
cp "$repo/gate/land-lib.sh" "$pack_dir/runtime/gate/land-lib.sh"
{
  cat "$pack_dir/preamble.md"
  printf '\n---\n\n'
  cat "$task_file"
  printf '\n'
} >"$prompt"

# Validate the materialized marker before creating a worktree, temporary
# directory, or transient unit.
BUN_BIN="$BUN_BIN" bash "$repo/orchestrator/dispatch-lane.sh" "$prompt" >/dev/null

git -C "$repo" worktree add -b "$branch" "$worktree" "$base" -q
worktree_created=true
worktree_git_dir="$(git -C "$worktree" rev-parse --absolute-git-dir)"
common_git_dir="$(git -C "$worktree" rev-parse --path-format=absolute --git-common-dir)"
mkdir -p "$tmp_root" "$tmp_dir"
chmod 0700 "$tmp_root"
chmod 0700 "$tmp_dir"
chown -R "$lane_user:$lane_group" "$worktree" "$pack_dir" "$prompt" "$tmp_root"
# A linked worktree keeps its index and HEAD below the common repository. The
# lane owns only its administrative directory. Git object storage and refs are
# deliberately group-shared: all lanes use one mutually trusted uid/group, so
# this boundary protects the parent checkout files, not sibling Git metadata.
chown -R "$lane_user:$lane_group" "$worktree_git_dir"
for shared_git_dir in "$common_git_dir/objects" "$common_git_dir/refs"; do
  if [[ -d "$shared_git_dir" ]]; then
    chgrp -R "$lane_group" "$shared_git_dir"
    find "$shared_git_dir" -type d -exec chmod g+rws {} +
    find "$shared_git_dir" -type f -exec chmod g+r {} +
  fi
done
if [[ -d "$common_git_dir/logs" ]]; then
  chgrp -R "$lane_group" "$common_git_dir/logs"
  find "$common_git_dir/logs" -type d -exec chmod g+rws {} +
  find "$common_git_dir/logs" -type f -exec chmod g+rw {} +
fi
touch "$log"
chown "$lane_user:$lane_group" "$log"
chmod 0600 "$prompt" "$log"
systemctl reset-failed "$unit" >/dev/null 2>&1 || true

unit_path="$(dirname "$BUN_BIN"):$(dirname "${agent_argv[0]}"):/usr/local/bin:/usr/bin:/bin"
# All command elements remain positional parameters; no configured value is
# evaluated as shell source. Agent stdout reaches disk only through mask-stream.
# shellcheck disable=SC2016
if ! systemd-run --collect --unit "$unit" --uid="$lane_user" --gid="$lane_group" \
  --property=IPAddressDeny=localhost \
  --property=IPAddressAllow=127.0.0.53 \
  --setenv="HOME=$lane_home" --setenv="TMPDIR=$tmp_dir" --setenv="PATH=$unit_path" \
  --setenv="GIT_CONFIG_COUNT=1" --setenv="GIT_CONFIG_KEY_0=safe.directory" \
  --setenv="GIT_CONFIG_VALUE_0=$worktree" \
  --working-directory="$worktree" \
  /bin/bash -o pipefail -c 'prompt=$1; bun=$2; masker=$3; log=$4; shift 4; "$@" "$(cat "$prompt")" 2>&1 | "$bun" "$masker" >>"$log"' \
  _ "$prompt" "$BUN_BIN" "$pack_dir/runtime/daemon/mask-stream.ts" "$log" "${agent_argv[@]}" >/dev/null; then
  printf 'launch-lane: unit launch failed; cleaned lane artifacts: %s\n' "$name" >&2
  exit 1
fi

launch_complete=true
printf 'launched %s\nworktree: %s\nbranch: %s\nlog: %s\n' "$unit" "$worktree" "$branch" "$log"
