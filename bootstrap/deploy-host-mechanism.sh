#!/usr/bin/env bash
# The only supported copy-to-host path: refuse sources or companions not on main.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ $# -eq 1 ]] || { echo "usage: $0 TRACKED_SOURCE" >&2; exit 2; }
source_path=$1
export DEPLOY_DRIFT_MANIFEST="${DEPLOY_DRIFT_MANIFEST:-$SCRIPT_DIR/deployed-mechanisms.tsv}"
row=$(awk -F '\t' -v source="$source_path" '$1 == source { print; found++ } END { if (found != 1) exit 1 }' "$DEPLOY_DRIFT_MANIFEST") || {
  echo "DEPLOY-DRIFT ALARM: source is not uniquely registered: $source_path" >&2
  exit 2
}
IFS=$'\t' read -r _ target companions <<<"$row"
REPO_ROOT="${DEPLOY_DRIFT_REPO_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
MAIN_REF="${DEPLOY_DRIFT_MAIN_REF:-refs/heads/main}"
for required in "$source_path" ${companions//,/ }; do
  [[ "$required" == - ]] && continue
  if ! git -C "$REPO_ROOT" cat-file -e "$MAIN_REF:$required" 2>/dev/null ||
     ! git -C "$REPO_ROOT" diff --quiet "$MAIN_REF" -- "$required"; then
    echo "DEPLOY-DRIFT ALARM: refusing deployment; companion tracked change is absent from $MAIN_REF: $required" >&2
    exit 1
  fi
done
SYSTEMD_SYSTEM_DIR="${SYSTEMD_SYSTEM_DIR:-/etc/systemd/system}"
LOCAL_BIN_DIR="${LOCAL_BIN_DIR:-/root/.local/bin}"
target=${target//'${SYSTEMD_SYSTEM_DIR}'/$SYSTEMD_SYSTEM_DIR}
target=${target//'${LOCAL_BIN_DIR}'/$LOCAL_BIN_DIR}
install -D -m "${DEPLOY_DRIFT_MODE:-755}" "$REPO_ROOT/$source_path" "$target"
echo "DEPLOYED $source_path -> $target"
