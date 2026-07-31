#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

unit_dir="$tmp_dir/units"
canonical_repo="$tmp_dir/canonical-repo"
mkdir -p "$canonical_repo"
systemctl_stub="$tmp_dir/systemctl"
printf '#!/usr/bin/env bash\nexit 1\n' > "$systemctl_stub"
chmod +x "$systemctl_stub"

ORCH_SYSTEMD_USER_DIR="$unit_dir" \
ORCH_REPO_DIR="$canonical_repo" \
ORCH_SYSTEMCTL_BIN="$systemctl_stub" \
BUN_BIN="$(command -v bun)" \
  "$REPO_DIR/orchestrator/install-memory-sweep.sh" install >/dev/null

service="$unit_dir/orch-memory-sweep.service"
timer="$unit_dir/orch-memory-sweep.timer"
test -f "$service"
test -f "$timer"
grep -F "WorkingDirectory=$canonical_repo" "$service" >/dev/null
grep -F -- "--repo $canonical_repo" "$service" >/dev/null
grep -F 'OnCalendar=*-*-* 04:30:00' "$timer" >/dev/null
grep -F 'Persistent=true' "$timer" >/dev/null

printf 'install-memory-sweep.test: PASS\n'
