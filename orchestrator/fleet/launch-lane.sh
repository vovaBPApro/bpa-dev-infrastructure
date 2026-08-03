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
EOF
}

die() { printf 'launch-lane: %s\n' "$*" >&2; exit 2; }

name=""; role=""; task_file=""; repo="$REPO_DEFAULT"
lanes_dir="${XDG_CACHE_HOME:-$HOME/.cache}/infra-lanes"
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
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die '--name is missing or invalid'
case "$role" in coder|reviewer|orchestrator|manager) ;; *) die '--role is missing or invalid' ;; esac
[[ -f "$task_file" && -r "$task_file" ]] || die "task file missing or unreadable: $task_file"
repo="$(cd "$repo" && pwd)"
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
report="$lanes_dir/$name.report.md"
status="$lanes_dir/lane-$name.status"
unit="lane-$name"
tmp_root="${TMPDIR:-/tmp}/infra-lane-tmp-$UID"
tmp_dir="$tmp_root/$name"

mkdir -p "$lanes_dir"
for artifact in "$worktree" "$pack_dir" "$prompt" "$log" "$report" "$status" "$tmp_dir"; do
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
  rm -f -- "$prompt" "$log" "$report" "$status"
  rm -rf -- "$pack_dir" "$tmp_dir"
}
trap cleanup_failed_launch EXIT

"$BUN_BIN" "$repo/tools/instructions/compose.ts" --role "$role" --repo "$repo" --out "$pack_dir" >/dev/null
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
mkdir -p "$tmp_root" "$tmp_dir"
chmod 0711 "$tmp_root"
chmod 0700 "$tmp_dir"
systemctl reset-failed "$unit" >/dev/null 2>&1 || true

unit_path="$(dirname "$BUN_BIN"):$(dirname "${agent_argv[0]}"):/usr/local/bin:/usr/bin:/bin"
# All command elements remain positional parameters; no configured value is
# evaluated as shell source. Agent stdout reaches disk only through mask-stream.
# shellcheck disable=SC2016
if ! systemd-run --collect --unit "$unit" \
  --property=IPAddressDeny=localhost \
  --property=IPAddressAllow=127.0.0.53 \
  --setenv="HOME=$HOME" --setenv="TMPDIR=$tmp_dir" --setenv="PATH=$unit_path" \
  --setenv="LANE_REPORT_PATH=$report" \
  --working-directory="$worktree" \
  /bin/bash -o pipefail -c '
    prompt=$1; bun=$2; masker=$3; log=$4; report=$5; status=$6; gate=$7; repo=$8; branch=$9
    shift 9
    set +e
    "$@" "$(cat "$prompt")" 2>&1 | "$bun" "$masker" >>"$log"
    pipeline_status=("${PIPESTATUS[@]}")
    agent_status=${pipeline_status[0]}
    mask_status=${pipeline_status[1]}
    if ((agent_status != 0)); then
      printf "state: failed\nreason: payload-exit\nexit: %s\nreport: %s\n" "$agent_status" "$report" >"$status"
      exit "$agent_status"
    fi
    if ((mask_status != 0)); then
      printf "state: failed\nreason: log-masker-exit\nexit: %s\nreport: %s\n" "$mask_status" "$report" >"$status"
      exit "$mask_status"
    fi
    "$gate" --report "$report" --repo "$repo" --branch "$branch" >>"$log" 2>&1
    guard_status=$?
    if ((guard_status == 0 || guard_status == 3)); then
      printf "state: terminal\nreason: report-valid\nexit: %s\nreport: %s\n" "$guard_status" "$report" >"$status"
      exit 0
    fi
    printf "state: failed\nreason: report-invalid\nexit: %s\nreport: %s\n" "$guard_status" "$report" >"$status"
    exit "$guard_status"
  ' _ "$prompt" "$BUN_BIN" "$repo/daemon/mask-stream.ts" "$log" "$report" "$status" \
  "$repo/gate/lane-exit.sh" "$repo" "$branch" "${agent_argv[@]}" >/dev/null; then
  printf 'launch-lane: unit launch failed; cleaned lane artifacts: %s\n' "$name" >&2
  exit 1
fi

launch_complete=true
printf 'launched %s\nworktree: %s\nbranch: %s\nlog: %s\nreport: %s\nstatus: %s\n' \
  "$unit" "$worktree" "$branch" "$log" "$report" "$status"
