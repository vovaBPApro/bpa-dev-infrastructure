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
  --service-config FILE Service-user facts (default: instance/lane-service-user.conf)
EOF
}

die() { printf 'launch-lane: %s\n' "$*" >&2; exit 2; }

original_args=("$@")
name=""; role=""; task_file=""; repo="$REPO_DEFAULT"
lanes_dir="${XDG_CACHE_HOME:-$HOME/.cache}/infra-lanes"
base="origin/main"; branch=""; agent_command_file="${AGENT_COMMAND_FILE:-}"
service_config="${LANE_SERVICE_CONFIG:-$REPO_DEFAULT/instance/lane-service-user.conf}"
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
    --service-config) service_config="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ -f "$service_config" && -r "$service_config" ]] || die "service-user config missing or unreadable: $service_config"
# This is tracked administrator configuration, not lane-controlled input.
# shellcheck disable=SC1090
source "$service_config"
: "${LANE_SERVICE_USER:?service-user config lacks LANE_SERVICE_USER}"
: "${LANE_SERVICE_HOME:?service-user config lacks LANE_SERVICE_HOME}"
: "${LANE_PROVIDER:?service-user config lacks LANE_PROVIDER}"
getent passwd "$LANE_SERVICE_USER" >/dev/null || die "service user is absent: $LANE_SERVICE_USER"
service_uid="$(id -u "$LANE_SERVICE_USER")"
service_gid="$(id -g "$LANE_SERVICE_USER")"
[[ "$(loginctl show-user "$LANE_SERVICE_USER" -p Linger --value 2>/dev/null || true)" == yes ]] ||
  die "linger is off for service user: $LANE_SERVICE_USER"
case "$LANE_PROVIDER" in
  codex) credential="$LANE_SERVICE_HOME/.codex/auth.json" ;;
  claude) credential="$LANE_SERVICE_HOME/.claude/.credentials.json" ;;
  *) die "unsupported lane provider: $LANE_PROVIDER" ;;
esac
[[ -f "$credential" && -r "$credential" ]] || die "provider credentials are missing: $credential"
[[ "$(stat -c %a "$credential")" == 600 ]] || die "provider credentials must have mode 0600: $credential"
[[ "$(stat -c %u "$credential")" == "$service_uid" ]] || die "provider credentials have wrong owner: $credential"

# A root-started v3 delegates the whole operation before creating artifacts.
# In the intended installed shape this branch is skipped: orchestrator and lane
# already share the service uid and HOME.
if [[ "$EUID" -ne "$service_uid" ]]; then
  [[ "$EUID" -eq 0 ]] || die "launcher uid does not match service user: $LANE_SERVICE_USER"
  exec setpriv --reuid="$service_uid" --regid="$service_gid" --init-groups \
    env -u SUDO_UID -u SUDO_GID -u SUDO_USER HOME="$LANE_SERVICE_HOME" USER="$LANE_SERVICE_USER" LOGNAME="$LANE_SERVICE_USER" XDG_RUNTIME_DIR="/run/user/$service_uid" \
    LANE_SERVICE_CONFIG="$service_config" BUN_BIN="$BUN_BIN" \
    "$SCRIPT_DIR/launch-lane.sh" "${original_args[@]}"
fi
[[ "$HOME" == "$LANE_SERVICE_HOME" ]] || die "HOME does not match service user home: $LANE_SERVICE_HOME"

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
systemctl --user reset-failed "$unit" >/dev/null 2>&1 || true

unit_path="$(dirname "$BUN_BIN"):$(dirname "${agent_argv[0]}"):/usr/local/bin:/usr/bin:/bin"
# All command elements remain positional parameters; no configured value is
# evaluated as shell source. Agent stdout reaches disk only through mask-stream.
# shellcheck disable=SC2016
if ! systemd-run --user --collect --unit "$unit" \
  --property=IPAddressDeny=localhost \
  --property=IPAddressAllow=127.0.0.53 \
  --setenv="TMPDIR=$tmp_dir" --setenv="PATH=$unit_path" \
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
    # This gate runs inside callers such as gate/land.sh, which deliberately
    # export their own trusted BUN_BIN. The nested gate must resolve its own
    # interpreter instead of tripping the land_resolve_bun caller-override guard.
    env -u BUN_BIN "$gate" --report "$report" --repo "$repo" --branch "$branch" >>"$log" 2>&1
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
