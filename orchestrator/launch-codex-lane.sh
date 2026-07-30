#!/usr/bin/env bash
# Dispatch-tail launcher for one bounded Codex coder lane.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib.sh"

AUTH_PREFLIGHT="${ORCH_AUTH_PREFLIGHT:-$SCRIPT_DIR/preflight-cli-auth.sh}"
CODEX_MODEL="${ORCH_CODEX_MODEL:-${ORCH_MODEL:-gpt-5.6-sol}}"
CODEX_REASONING_EFFORT="${ORCH_CODEX_REASONING_EFFORT:-high}"
LOCK_TIMEOUT_SEC="${ORCH_LANE_LOCK_TIMEOUT_SEC:-30}"

usage() {
  cat <<'EOF'
Usage: launch-codex-lane.sh --lane <lane-id> [--evidence-dir <dir>] [--worktree <dir>]
                            [--timeout-sec <n>] [--dry-run] <prompt-file>
EOF
}

refuse() {
  printf 'REFUSE codex-lane %s\n' "$*" >&2
  exit 2
}

valid_name() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]
}

absolute_path() {
  [[ "$1" == /* ]] || return 1
  realpath -m -- "$1"
}

outside_repo() {
  case "$1/" in
    "$REPO_DIR/"*) return 1 ;;
    *) return 0 ;;
  esac
}

toml_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '%s' "$value"
}

print_command() {
  printf 'DRY-RUN'
  printf ' %q' "$@"
  printf '\n'
}

lane=""
evidence_dir="${ORCH_EVIDENCE_DIR:-}"
worktree=""
timeout_sec="${ORCH_LANE_TIMEOUT_SEC:-3600}"
dry_run=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --lane|--evidence-dir|--worktree|--timeout-sec)
      [[ $# -ge 2 && -n "$2" ]] || { usage >&2; exit 2; }
      case "$1" in
        --lane) lane="$2" ;;
        --evidence-dir) evidence_dir="$2" ;;
        --worktree) worktree="$2" ;;
        --timeout-sec) timeout_sec="$2" ;;
      esac
      shift 2
      ;;
    --dry-run)
      dry_run=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --*)
      usage >&2
      exit 2
      ;;
    *)
      break
      ;;
  esac
done

[[ -n "$lane" ]] || refuse 'missing --lane'
valid_name "$lane" || refuse "invalid lane=$lane"
[[ $# -eq 1 ]] || { usage >&2; exit 2; }
[[ -n "$evidence_dir" ]] || refuse 'ORCH_EVIDENCE_DIR is unset and --evidence-dir was not supplied'
[[ "$timeout_sec" =~ ^[1-9][0-9]*$ ]] || refuse "invalid timeout-sec=$timeout_sec"
[[ "$LOCK_TIMEOUT_SEC" =~ ^[1-9][0-9]*$ ]] || refuse "invalid lock-timeout-sec=$LOCK_TIMEOUT_SEC"

prompt_file="$(realpath -- "$1" 2>/dev/null)" || refuse "prompt is not readable: $1"
[[ -f "$prompt_file" && -r "$prompt_file" ]] || refuse "prompt is not readable: $1"
evidence_dir="$(absolute_path "$evidence_dir")" || refuse 'evidence-dir must be absolute'
if [[ -z "$worktree" ]]; then
  [[ -n "${ORCH_LANES_DIR:-}" ]] || refuse 'ORCH_LANES_DIR is unset and --worktree was not supplied'
  worktree="${ORCH_LANES_DIR%/}/$lane"
fi
worktree="$(absolute_path "$worktree")" || refuse 'worktree must be absolute'
outside_repo "$evidence_dir" || refuse "evidence-dir is inside repo: $evidence_dir"
outside_repo "$worktree" || refuse "worktree is inside repo: $worktree"

branch="ag-$lane"
unit="bpa-lane-$lane"
report_file="$evidence_dir/$branch.report.md"
log_file="$evidence_dir/$branch.codex.log"
exit_file="$evidence_dir/$branch.exit"
lane_codex_home="$evidence_dir/$branch.codex-home"
deadline_sec=$((timeout_sec + 120))
case "$lane_codex_home/" in
  /tmp/*) refuse "lane CODEX_HOME must be outside /tmp: $lane_codex_home" ;;
esac

command -v git >/dev/null 2>&1 || refuse 'git is unavailable'
command -v flock >/dev/null 2>&1 || refuse 'flock is unavailable'
command -v realpath >/dev/null 2>&1 || refuse 'realpath is unavailable'
command -v systemctl >/dev/null 2>&1 || refuse 'systemctl is unavailable'
command -v systemd-run >/dev/null 2>&1 || refuse 'systemd-run is unavailable'
command -v codex >/dev/null 2>&1 || refuse 'codex is unavailable'
[[ -x "$AUTH_PREFLIGHT" ]] || refuse "auth preflight is not executable: $AUTH_PREFLIGHT"
if ! "$AUTH_PREFLIGHT" codex; then
  refuse 'codex authentication preflight failed'
fi
auth_source="${ORCH_CODEX_AUTH_FILE:-$HOME/.codex/auth.json}"
[[ -f "$auth_source" && -r "$auth_source" ]] || refuse "codex auth file is not readable: $auth_source"
if ! systemctl --user is-system-running >/dev/null 2>&1; then
  refuse 'systemd user manager is not running'
fi
if systemctl --user is-active --quiet "$unit"; then
  refuse "unit is active: $unit"
fi

[[ ! -e "$report_file" && ! -L "$report_file" ]] || refuse "report already exists: $report_file"
[[ ! -e "$worktree" && ! -L "$worktree" ]] || refuse "worktree already exists: $worktree"
if git -C "$REPO_DIR" show-ref --verify --quiet "refs/heads/$branch"; then
  refuse "branch already exists: $branch"
fi
if ! git -C "$REPO_DIR" show-ref --verify --quiet refs/remotes/origin/main; then
  refuse 'local origin/main ref is missing'
fi

# shellcheck disable=SC2016
wrapper='
set +e
codex exec --cd "$1" \
  --model "$2" \
  --config "model_reasoning_effort=\"$3\"" \
  --dangerously-bypass-approvals-and-sandbox \
  - < "$4" > "$5" 2>&1
status=$?
exit_tmp="$6.tmp.$$"
printf "exit=%s ts=%s\n" "$status" "$(date -u +%FT%TZ)" > "$exit_tmp"
mv -f "$exit_tmp" "$6"
exit "$status"
'
systemd_argv=(
  systemd-run --user --collect --quiet
  --unit "$unit"
  --working-directory "$worktree"
  --property "RuntimeMaxSec=$timeout_sec"
  --setenv "CODEX_HOME=$lane_codex_home"
  --setenv "GIT_CONFIG_COUNT=1"
  --setenv "GIT_CONFIG_KEY_0=remote.origin.pushurl"
  --setenv "GIT_CONFIG_VALUE_0=file:///dev/null/push-disabled"
  /bin/bash -c "$wrapper" lane-wrapper
  "$worktree" "$CODEX_MODEL" "$CODEX_REASONING_EFFORT"
  "$prompt_file" "$log_file" "$exit_file"
)

if [[ "$dry_run" == true ]]; then
  print_command "${systemd_argv[@]}"
  print_command codex exec --cd "$worktree" --model "$CODEX_MODEL" \
    --config "model_reasoning_effort=\"$CODEX_REASONING_EFFORT\"" \
    --dangerously-bypass-approvals-and-sandbox -
else
  git_common_dir="$(git -C "$REPO_DIR" rev-parse --git-common-dir 2>/dev/null)" ||
    { printf 'ERROR codex-lane cannot resolve common git dir\n' >&2; exit 1; }
  if [[ "$git_common_dir" != /* ]]; then
    git_common_dir="$(realpath -m "$REPO_DIR/$git_common_dir")"
  fi
  exec 9>"$git_common_dir/bpa-lane-provision.lock"
  if ! flock -w "$LOCK_TIMEOUT_SEC" 9; then
    refuse "provision lock timeout after ${LOCK_TIMEOUT_SEC}s"
  fi

  # Repeat every mutable fence while holding the common-repository lock.
  [[ ! -e "$report_file" && ! -L "$report_file" ]] || refuse "report already exists: $report_file"
  [[ ! -e "$worktree" && ! -L "$worktree" ]] || refuse "worktree already exists: $worktree"
  if git -C "$REPO_DIR" show-ref --verify --quiet "refs/heads/$branch"; then
    refuse "branch already exists: $branch"
  fi

  if ! git -C "$REPO_DIR" worktree add -b "$branch" "$worktree" origin/main; then
    printf 'ERROR codex-lane worktree provisioning failed lane=%s\n' "$lane" >&2
    exit 1
  fi
  flock -u 9

  umask 077
  if ! mkdir -p "$evidence_dir" "$lane_codex_home"; then
    printf 'ERROR codex-lane evidence provisioning failed dir=%s\n' "$evidence_dir" >&2
    exit 1
  fi
  if ! cp -- "$auth_source" "$lane_codex_home/auth.json"; then
    printf 'ERROR codex-lane auth copy failed\n' >&2
    exit 1
  fi
  chmod 0400 "$lane_codex_home/auth.json"
  escaped_worktree="$(toml_escape "$worktree")"
  escaped_model="$(toml_escape "$CODEX_MODEL")"
  escaped_effort="$(toml_escape "$CODEX_REASONING_EFFORT")"
  if ! printf 'model = "%s"\nmodel_reasoning_effort = "%s"\n\n[projects."%s"]\ntrust_level = "trusted"\n' \
    "$escaped_model" "$escaped_effort" "$escaped_worktree" > "$lane_codex_home/config.toml"; then
    printf 'ERROR codex-lane config provisioning failed\n' >&2
    exit 1
  fi
  chmod 0600 "$lane_codex_home/config.toml"

  if ! "${systemd_argv[@]}"; then
    printf 'ERROR codex-lane systemd start failed unit=%s\n' "$unit" >&2
    exit 1
  fi
fi

printf 'LANE dispatched lane=%s branch=%s unit=%s\n' "$lane" "$branch" "$unit"
printf 'worktree=%s\n' "$worktree"
printf 'report=%s\n' "$report_file"
printf 'log=%s\n' "$log_file"
printf 'exit-file=%s\n' "$exit_file"
printf 'deadline-sec=%s\n' "$deadline_sec"
