#!/usr/bin/env bash
# Build a commit in an isolated release worktree and activate it atomically.
set -euo pipefail

usage() { echo 'usage: live-stand.sh <tracked-config> <commit>' >&2; exit 2; }
[[ $# == 2 ]] || usage
CONFIG=$1
REQUESTED_COMMIT=$2
[[ -f "$CONFIG" ]] || { echo "DEPLOY ERROR: config missing: $CONFIG" >&2; exit 2; }
# shellcheck disable=SC1090 -- the config is a tracked, reviewed instance artifact.
source "$CONFIG"
: "${REPO_ROOT:?}" "${RELEASE_ROOT:?}" "${CURRENT_LINK:?}" "${SERVICE_NAME:?}" "${HEALTH_URL:?}" "${BUILD_COMMAND:?}"
SERVICE_ROOT_ENV=${SERVICE_ROOT_ENV:-APP_ROOT}
SYSTEMD_SYSTEM_DIR=${SYSTEMD_SYSTEM_DIR:-/etc/systemd/system}
[[ "$SERVICE_ROOT_ENV" =~ ^[A-Z_][A-Z0-9_]*$ ]] || { echo 'DEPLOY ERROR: invalid service root environment name' >&2; exit 2; }
HEALTH_TIMEOUT_SECONDS=${HEALTH_TIMEOUT_SECONDS:-30}
[[ "$HEALTH_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] || { echo 'DEPLOY ERROR: invalid health timeout' >&2; exit 2; }
[[ "$CURRENT_LINK" == "$RELEASE_ROOT"/* ]] || { echo 'DEPLOY ERROR: current link must be below release root' >&2; exit 2; }

commit=$(git -C "$REPO_ROOT" rev-parse --verify "$REQUESTED_COMMIT^{commit}") || {
  echo "DEPLOY ERROR: unknown commit: $REQUESTED_COMMIT" >&2; exit 2;
}
release="$RELEASE_ROOT/$commit"
mkdir -p "$RELEASE_ROOT"
if [[ ! -d "$release/.git" && ! -f "$release/.git" ]]; then
  git -C "$REPO_ROOT" worktree add --detach "$release" "$commit"
fi
[[ "$(git -C "$release" rev-parse HEAD)" == "$commit" ]] || {
  echo "DEPLOY ERROR: release path contains the wrong commit: $release" >&2; exit 1;
}

echo "DEPLOY build=$commit release=$release"
(cd "$release" && bash -o pipefail -c "$BUILD_COMMAND")

previous=
if [[ -L "$CURRENT_LINK" ]]; then
  previous=$(readlink -f "$CURRENT_LINK")
elif [[ -e "$CURRENT_LINK" ]]; then
  echo "DEPLOY ERROR: current path exists and is not a symlink: $CURRENT_LINK" >&2
  exit 1
else
  previous=$REPO_ROOT
fi

activate() {
  local target=$1 temporary="$CURRENT_LINK.next.$$"
  ln -s "$target" "$temporary"
  mv -Tf "$temporary" "$CURRENT_LINK"
  systemctl restart "$SERVICE_NAME"
}

health_commit() {
  curl --silent --show-error --fail --max-time 5 "$HEALTH_URL" |
    node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const x=JSON.parse(s);if(x.status!=="ok"||typeof x.build?.commit!=="string")process.exit(1);process.stdout.write(x.build.commit)}catch{process.exit(1)}})'
}

# The stable link is the only mutable activation boundary. The original unit,
# including its OAuth/token-store ExecStartPre, remains byte-for-byte untouched.
dropin_dir="$SYSTEMD_SYSTEM_DIR/$SERVICE_NAME.d"
dropin="$dropin_dir/release-root.conf"
mkdir -p "$dropin_dir"
temporary_dropin="$dropin.next.$$"
printf '[Service]\nEnvironment=%s=%s\n' "$SERVICE_ROOT_ENV" "$CURRENT_LINK" >"$temporary_dropin"
chmod 0644 "$temporary_dropin"
mv -Tf "$temporary_dropin" "$dropin"
systemctl daemon-reload

activate "$release"
deadline=$((SECONDS + HEALTH_TIMEOUT_SECONDS))
observed=
while ((SECONDS < deadline)); do
  observed=$(health_commit 2>/dev/null || true)
  [[ "$observed" == "$commit" ]] && break
  sleep 1
done
if [[ "$observed" != "$commit" ]]; then
  echo "DEPLOY ALARM: health did not report deployed commit=$commit; rolling back to $previous" >&2
  activate "$previous" || true
  rollback=$(health_commit 2>/dev/null || true)
  if [[ -z "$rollback" ]]; then
    echo 'DEPLOY ALARM: rollback health check failed' >&2
  else
    echo "DEPLOY rollback=healthy commit=$rollback" >&2
  fi
  exit 1
fi
systemctl is-active --quiet "$SERVICE_NAME"
echo "DEPLOY SUCCESS service=$SERVICE_NAME commit=$commit health=$HEALTH_URL"
