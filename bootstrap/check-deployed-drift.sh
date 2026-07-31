#!/usr/bin/env bash
# Compare every registered host mechanism with both its tracked source and main.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${DEPLOY_DRIFT_REPO_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
MANIFEST="${DEPLOY_DRIFT_MANIFEST:-$SCRIPT_DIR/deployed-mechanisms.tsv}"
MAIN_REF="${DEPLOY_DRIFT_MAIN_REF:-refs/heads/main}"
SYSTEMD_SYSTEM_DIR="${SYSTEMD_SYSTEM_DIR:-/etc/systemd/system}"
LOCAL_BIN_DIR="${LOCAL_BIN_DIR:-/root/.local/bin}"
NOTIFY_URL="${DEPLOY_DRIFT_NOTIFY_URL-http://127.0.0.1:4822/notify}"
export SYSTEMD_SYSTEM_DIR LOCAL_BIN_DIR

expand_target() {
  local value=$1
  value=${value//'${SYSTEMD_SYSTEM_DIR}'/$SYSTEMD_SYSTEM_DIR}
  value=${value//'${LOCAL_BIN_DIR}'/$LOCAL_BIN_DIR}
  printf '%s\n' "$value"
}

tracked_at_main() { # path
  git -C "$REPO_ROOT" cat-file -e "$MAIN_REF:$1" 2>/dev/null &&
    git -C "$REPO_ROOT" diff --quiet "$MAIN_REF" -- "$1"
}

[[ -f "$MANIFEST" ]] || { echo "DEPLOY-DRIFT ALARM: manifest missing: $MANIFEST" >&2; exit 2; }
git -C "$REPO_ROOT" rev-parse --verify --quiet "$MAIN_REF^{commit}" >/dev/null || {
  echo "DEPLOY-DRIFT ALARM: main ref unavailable: $MAIN_REF" >&2
  exit 2
}

result=0
count=0
while IFS=$'\t' read -r source target companions extra; do
  [[ -z "$source" || "$source" == \#* ]] && continue
  if [[ -n "${extra:-}" || -z "$target" || -z "$companions" || "$source" == /* || "$source" == *..* ]]; then
    echo "DEPLOY-DRIFT ALARM: invalid manifest row for: $source" >&2
    exit 2
  fi
  ((count += 1))
  deployed=$(expand_target "$target")
  if [[ ! -f "$REPO_ROOT/$source" ]] || ! tracked_at_main "$source"; then
    echo "DEPLOY-DRIFT ALARM: companion tracked change is absent from $MAIN_REF: $source" >&2
    result=1
  fi
  if [[ "$companions" != - ]]; then
    IFS=',' read -ra required <<<"$companions"
    for companion in "${required[@]}"; do
      if [[ "$companion" == /* || "$companion" == *..* ]] || ! tracked_at_main "$companion"; then
        echo "DEPLOY-DRIFT ALARM: companion tracked change is absent from $MAIN_REF: $companion (required by $source)" >&2
        result=1
      fi
    done
  fi
  if [[ ! -f "$deployed" ]]; then
    echo "DEPLOY-DRIFT ALARM: deployed mechanism missing: $deployed (source $source)" >&2
    result=1
  elif ! cmp -s "$REPO_ROOT/$source" "$deployed"; then
    echo "DEPLOY-DRIFT ALARM: deployed mechanism differs: $deployed (source $source)" >&2
    result=1
  else
    echo "MATCH $source -> $deployed"
  fi
done <"$MANIFEST"

((count > 0)) || { echo 'DEPLOY-DRIFT ALARM: manifest contains no mechanisms' >&2; exit 2; }
if ((result != 0)) && [[ -n "$NOTIFY_URL" ]]; then
  if ! curl -fsS -m 10 -X POST -H 'Content-Type: application/json' \
      --data '{"text":"⚠️ DEPLOY-DRIFT ALARM: host mechanisms differ from tracked main. Run journalctl -u bpa-deploy-drift-guard.service."}' \
      "$NOTIFY_URL" >/dev/null; then
    echo 'DEPLOY-DRIFT ALARM: operator notification delivery failed' >&2
  fi
fi
exit "$result"
