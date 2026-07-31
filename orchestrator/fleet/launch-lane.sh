#!/usr/bin/env bash
# Portable fleet entry point: compose, gate, isolate, and launch one Codex lane.
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
  --codex-bin FILE     Codex executable (default: CODEX_BIN or PATH lookup)
EOF
}

die() { printf 'launch-lane: %s\n' "$*" >&2; exit 2; }

name=""; role=""; task_file=""; repo="$REPO_DEFAULT"
lanes_dir="${XDG_CACHE_HOME:-$HOME/.cache}/infra-lanes"
base="origin/main"; branch=""; codex_bin="${CODEX_BIN:-}"
while (($#)); do
  case "$1" in
    --name) name="${2:-}"; shift 2 ;;
    --role) role="${2:-}"; shift 2 ;;
    --task-file) task_file="${2:-}"; shift 2 ;;
    --repo) repo="${2:-}"; shift 2 ;;
    --lanes-dir) lanes_dir="${2:-}"; shift 2 ;;
    --base) base="${2:-}"; shift 2 ;;
    --branch) branch="${2:-}"; shift 2 ;;
    --codex-bin) codex_bin="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die '--name is missing or invalid'
case "$role" in coder|reviewer|orchestrator|manager) ;; *) die '--role is missing or invalid' ;; esac
[[ -f "$task_file" ]] || die "task file not found: $task_file"
repo="$(cd "$repo" && pwd)"
[[ -x "$BUN_BIN" ]] || die 'Bun is unavailable; install it with bootstrap/install.sh or set BUN_BIN'
if [[ -z "$codex_bin" ]]; then codex_bin="$(command -v codex 2>/dev/null || true)"; fi
[[ -x "$codex_bin" ]] || die 'Codex is unavailable; install it or set CODEX_BIN/--codex-bin'
command -v systemd-run >/dev/null || die 'systemd-run is unavailable'

branch="${branch:-ag-$name}"
worktree="$lanes_dir/$name"
pack_dir="$lanes_dir/pack-$name"
prompt="$lanes_dir/lane-$name.prompt.md"
log="$lanes_dir/lane-$name.log"
unit="lane-$name"
tmp_dir="$lanes_dir/tmp"

mkdir -p "$lanes_dir" "$tmp_dir"
[[ ! -e "$worktree" && ! -e "$pack_dir" && ! -e "$prompt" && ! -e "$log" ]] || \
  die "lane artifacts already exist for $name"

"$BUN_BIN" "$repo/tools/instructions/compose.ts" --role "$role" --repo "$repo" --out "$pack_dir" >/dev/null
{
  cat "$pack_dir/preamble.md"
  printf '\n---\n\n'
  cat "$task_file"
  printf '\n'
} >"$prompt"

# The checked front door validates the materialized pack marker before any
# worktree or unit is created.
BUN_BIN="$BUN_BIN" bash "$repo/orchestrator/dispatch-lane.sh" "$prompt" >/dev/null

git -C "$repo" worktree add -b "$branch" "$worktree" "$base" -q
systemctl reset-failed "$unit" >/dev/null 2>&1 || true

unit_path="$(dirname "$BUN_BIN"):$(dirname "$codex_bin"):/usr/local/bin:/usr/bin:/bin"
# Prompt expansion is intentionally deferred to the transient unit's shell.
# shellcheck disable=SC2016,SC2251
if ! systemd-run --collect --unit "$unit" \
  --setenv="HOME=$HOME" --setenv="TMPDIR=$tmp_dir" --setenv="PATH=$unit_path" \
  --working-directory="$worktree" \
  /bin/bash -o pipefail -c '"$1" exec --dangerously-bypass-approvals-and-sandbox "$(cat "$2")" 2>&1 | "$3" "$4" >>"$5"' \
  _ "$codex_bin" "$prompt" "$BUN_BIN" "$repo/daemon/mask-stream.ts" "$log" >/dev/null; then
  printf 'launch-lane: unit launch failed; retained worktree for diagnosis: %s\n' "$worktree" >&2
  exit 1
fi

printf 'launched %s\nworktree: %s\nbranch: %s\nlog: %s\n' "$unit" "$worktree" "$branch" "$log"
