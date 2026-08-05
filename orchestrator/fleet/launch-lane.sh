#!/usr/bin/env bash
# Portable fleet entry point: compose, gate, isolate, and launch one agent lane.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DEFAULT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck disable=SC1091
source "$REPO_DEFAULT/orchestrator/lib.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/fleet-params.sh"

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
  --allow-over-cap R   Launch past the lane cap deliberately, stating the reason
                       R. Journaled to LANES-DIR/fleet-cap.jsonl. Refusal is the
                       default; this is the declared exception, not a bypass.
EOF
}

die() { printf 'launch-lane: %s\n' "$*" >&2; exit 2; }

name=""; role=""; task_file=""; repo="$REPO_DEFAULT"
lanes_dir="${XDG_CACHE_HOME:-$HOME/.cache}/infra-lanes"
base="origin/main"; branch=""; agent_command_file="${AGENT_COMMAND_FILE:-}"
over_cap_reason=""; over_cap_requested=false
while (($#)); do
  case "$1" in
    --allow-over-cap) over_cap_requested=true; over_cap_reason="${2:-}"; shift 2 ;;
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
# The unit payload is a file so that systemd never parses its body; keeping it
# beside the masker and the exit gate means a lane runs the target repository's
# code throughout rather than mixing in the launcher's own copy.
lane_payload="$repo/orchestrator/fleet/lane-payload.sh"
[[ -f "$lane_payload" && -r "$lane_payload" ]] || die "lane payload missing or unreadable: $lane_payload"
[[ -x "$BUN_BIN" ]] || die 'Bun is unavailable; install it with bootstrap/install.sh or set BUN_BIN'
command -v systemd-run >/dev/null || die 'systemd-run is unavailable; lane launch requires systemd'

# ── The lane cap, enforced here rather than quoted elsewhere ────────────────
# Until workboard row V3-5.10, nothing in this launcher refused a lane beyond the
# configured cap: `FLEET_NUDGE_CAP` and `FleetConfig.cap` were only ever printed
# in messages, and the ceiling was held by the orchestrator counting running
# units by hand at every dispatch. A rule enforced by an agent remembering to
# count is a rule the system does not have.
#
# The number and the ruling that declares it are read from the target
# repository's instance/params.yaml — HR-2538 scopes the cap PER REPOSITORY, so
# it is that repository's parameter file, not the launcher's — through the one
# reader in fleet-params.sh. Nothing here retypes either.
#
# Fail-closed on both edges: an unreadable cap and an untakeable census are
# refusals, not zeros, because neither can show the launch is under the ceiling.
# The refusal happens before any artifact exists, so a refused launch leaves the
# worktree, branch, pack and unit untouched.
cap=$(fleet_cap "$repo") ||
  die "cannot read fleet.cap from $repo/instance/params.yaml; refusing to launch against an unknown cap"
declared_by=$(fleet_declared_by "$repo") || declared_by="unstated ruling"

json_escape() { printf '%s' "$1" | tr '\n\t' '  ' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

# Every cap decision that is not an ordinary in-budget launch is journaled, both
# halves of it: the refusal, so a fleet that keeps hitting the ceiling is visible
# without reading logs, and the override, so a deliberate extra lane is a record
# rather than a memory. Journal failure never blocks a launch — the journal is
# evidence about the decision, not part of it.
cap_journal="${FLEET_CAP_JOURNAL:-$lanes_dir/fleet-cap.jsonl}"
journal_cap_decision() { # decision running reason
  local running_field="$2"
  case "$running_field" in '' | *[!0-9]*) running_field=null ;; esac
  mkdir -p "$(dirname "$cap_journal")" 2>/dev/null || return 0
  printf '{"at":"%s","lane":"%s","repo":"%s","decision":"%s","cap":%s,"running":%s,"declared_by":"%s","reason":"%s"}\n' \
    "$(date -Is)" "$(json_escape "$name")" "$(json_escape "$repo")" "$1" "$cap" "$running_field" \
    "$(json_escape "$declared_by")" "$(json_escape "$3")" >>"$cap_journal" 2>/dev/null || return 0
}

running=""
running=$(fleet_running_lanes) || running=""

if [[ "$over_cap_requested" == true ]]; then
  [[ -n "$over_cap_reason" ]] || die '--allow-over-cap requires a reason; a deliberate exception states why'
  journal_cap_decision over-cap-override "$running" "$over_cap_reason"
  printf 'launch-lane: launching past the cap of %s (%s) by explicit --allow-over-cap: %s\n' \
    "$cap" "$declared_by" "$over_cap_reason" >&2
elif [[ -z "$running" ]]; then
  journal_cap_decision refused-census-unavailable "" 'systemctl lane census failed'
  die "cannot count running lanes; refusing rather than launching past an unverified cap of $cap ($declared_by) — use --allow-over-cap REASON for a deliberate exception"
elif ((running >= cap)); then
  journal_cap_decision refused-at-cap "$running" "cap reached"
  die "refusing to launch $name: $running lane(s) already running and the cap is $cap ($declared_by) — land or reap a lane, or use --allow-over-cap REASON for a deliberate exception"
fi

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
unit_path="$(dirname "$BUN_BIN"):$(dirname "${agent_argv[0]}"):/usr/local/bin:/usr/bin:/bin"

# systemd expands `$VAR` and `${VAR}` in the command line it is handed, before
# the shell sees any of it, and substitutes an EMPTY STRING for anything that
# is not a valid environment variable name. That is what silently ate this
# launcher's tenth argument -- lane-payload.sh carries the full account. The
# payload body is now a file systemd never parses, but these VALUES still cross
# that expander, so refuse a dollar sign rather than let one vanish in transit.
# Checked here, before any artifact exists, so a rejected launch leaves nothing.
for systemd_value in "$prompt" "$BUN_BIN" "$repo/daemon/mask-stream.ts" "$log" "$report" \
  "$status" "$repo/gate/lane-exit.sh" "$repo" "$branch" "$role" "$lane_payload" \
  "$worktree" "$tmp_dir" "$HOME" "$unit_path" "${agent_argv[@]}"; do
  if [[ "$systemd_value" == *'$'* ]]; then
    die "refusing to launch: systemd would expand '\$' in a lane value: $systemd_value"
  fi
done

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

# All command elements remain positional parameters; no configured value is
# evaluated as shell source. Agent stdout reaches disk only through mask-stream.
if ! systemd-run --collect --unit "$unit" \
  --property=IPAddressDeny=localhost \
  --property=IPAddressAllow=127.0.0.53 \
  --setenv="HOME=$HOME" --setenv="TMPDIR=$tmp_dir" --setenv="PATH=$unit_path" \
  --setenv="LANE_REPORT_PATH=$report" \
  --working-directory="$worktree" \
  /bin/bash "$lane_payload" \
  "$prompt" "$BUN_BIN" "$repo/daemon/mask-stream.ts" "$log" "$report" "$status" \
  "$repo/gate/lane-exit.sh" "$repo" "$branch" "$role" "${agent_argv[@]}" >/dev/null; then
  printf 'launch-lane: unit launch failed; cleaned lane artifacts: %s\n' "$name" >&2
  exit 1
fi

launch_complete=true
printf 'launched %s\nworktree: %s\nbranch: %s\nlog: %s\nreport: %s\nstatus: %s\n' \
  "$unit" "$worktree" "$branch" "$log" "$report" "$status"
