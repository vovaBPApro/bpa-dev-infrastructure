#!/usr/bin/env bash
# Deterministically maintain this tool's marker-delimited crontab section.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: install-cron.sh [--uninstall] [--help]

Installs an idempotent hygiene cron block. Override CRONTAB_CMD for testing.
EOF
}

uninstall=false
case "${1:-}" in
  '') ;;
  --uninstall) uninstall=true ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "$script_dir/.." && pwd)"
cron_cmd="${CRONTAB_CMD:-crontab}"
log_dir="${HYGIENE_LOG_DIR:-$script_dir/logs}"
begin='# BEGIN bpa-dev-infrastructure hygiene'
end='# END bpa-dev-infrastructure hygiene'
current="$($cron_cmd -l 2>/dev/null || true)"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

# Drop exactly the old managed block while preserving all unrelated crontab text.
filtered="$(printf '%s\n' "$current" | awk -v begin="$begin" -v end="$end" '
  $0 == begin { skip=1; next }
  $0 == end { skip=0; next }
  !skip { print }
')"
{
  [[ -n "$filtered" ]] && printf '%s\n' "$filtered"
  if ! "$uninstall"; then
    printf '%s\n' "$begin"
    printf '%s\n' "19 * * * * $script_dir/reap.sh branches --repo $repo_dir --apply >> $log_dir/branches.log 2>&1"
    printf '%s\n' "29 * * * * $script_dir/reap.sh worktrees --repo $repo_dir --apply >> $log_dir/worktrees.log 2>&1"
    printf '%s\n' "39 2 * * * $script_dir/reap.sh disk --root $repo_dir --apply >> $log_dir/disk.log 2>&1"
    printf '%s\n' "$end"
  fi
} > "$tmp"

if ! "$uninstall"; then mkdir -p "$log_dir"; fi
"$cron_cmd" "$tmp"
if "$uninstall"; then echo "uninstalled hygiene cron block"; else echo "installed hygiene cron block"; fi
