#!/usr/bin/env bash
# Alarm when a live stand trails its remote integration ref beyond policy.
set -euo pipefail
[[ $# == 1 ]] || { echo 'usage: check-live-stand-staleness.sh <tracked-config>' >&2; exit 2; }
# shellcheck disable=SC1090 -- the config is a tracked, reviewed instance artifact.
source "$1"
: "${REPO_ROOT:?}" "${HEALTH_URL:?}"
STALE_COMMIT_THRESHOLD=${STALE_COMMIT_THRESHOLD:-0}
MAIN_REF=${MAIN_REF:-origin/main}
[[ "$STALE_COMMIT_THRESHOLD" =~ ^[0-9]+$ ]] || { echo 'STAND-STALENESS ALARM: invalid threshold' >&2; exit 2; }
git -C "$REPO_ROOT" fetch --quiet origin main || { echo 'STAND-STALENESS ALARM: cannot fetch origin/main' >&2; exit 2; }
serving=$(curl --silent --show-error --fail --max-time 5 "$HEALTH_URL" |
  node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const x=JSON.parse(s);if(x.status!=="ok"||typeof x.build?.commit!=="string")process.exit(1);process.stdout.write(x.build.commit)}catch{process.exit(1)}})') || {
    echo 'STAND-STALENESS ALARM: health identity unavailable' >&2; exit 1;
  }
git -C "$REPO_ROOT" merge-base --is-ancestor "$serving" "$MAIN_REF" || {
  echo "STAND-STALENESS ALARM: serving commit is not an ancestor of $MAIN_REF serving=$serving" >&2; exit 1;
}
behind=$(git -C "$REPO_ROOT" rev-list --count "$serving..$MAIN_REF")
if ((behind > STALE_COMMIT_THRESHOLD)); then
  message="STAND-STALENESS ALARM: serving=$serving behind=$behind ref=$MAIN_REF threshold=$STALE_COMMIT_THRESHOLD"
  echo "$message" >&2
  if [[ -n "${NOTIFY_URL:-}" ]]; then
    NOTIFY_TEXT="$message" node -e 'process.stdout.write(JSON.stringify({text:process.env.NOTIFY_TEXT}))' |
      curl --silent --show-error --fail --max-time 10 -H 'Content-Type: application/json' --data-binary @- "$NOTIFY_URL" >/dev/null ||
      echo 'STAND-STALENESS ALARM: operator notification delivery failed' >&2
  fi
  exit 1
fi
echo "STAND-STALENESS OK serving=$serving behind=$behind threshold=$STALE_COMMIT_THRESHOLD"
