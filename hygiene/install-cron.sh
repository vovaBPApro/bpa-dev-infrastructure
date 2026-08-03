#!/usr/bin/env bash
# Deterministically maintain this tool's marker-delimited crontab section.
#
# Ported from v2-deprecated (`git show v2-deprecated:hygiene/install-cron.sh`).
# On that line this script was tracked and never invoked -- `crontab -l` on the
# host returned "no crontab for root" -- which is exactly why 1372 branches
# accumulated. This port is tested (hygiene/reap.test.ts) against a fake
# crontab command so the test proves the script is correct without touching
# any real crontab.
#
# It is deliberately NOT invoked against this host's real crontab by this
# lane, and no systemd timer is wired either: bootstrap/ does not exist on v3
# yet (that is V3-1.1), so there is no container to arm a timer inside, and a
# coder lane mutating this host's live crontab is exactly the kind of
# untracked, host-only mechanism CLAUDE.md's meteorite test forbids. Arming
# the real schedule -- via this script on the host, or a systemd timer unit
# once bootstrap/ lands -- is recorded as deferred in instance/workboard.md.
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
    printf '%s\n' "39 * * * * $script_dir/reap.sh meteorite-refs --repo $repo_dir --apply >> $log_dir/meteorite-refs.log 2>&1"
    printf '%s\n' "$end"
  fi
} > "$tmp"

if ! "$uninstall"; then mkdir -p "$log_dir"; fi
"$cron_cmd" "$tmp"
if "$uninstall"; then echo "uninstalled hygiene cron block"; else echo "installed hygiene cron block"; fi
