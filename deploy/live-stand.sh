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
: "${REPO_ROOT:?}" "${RELEASE_ROOT:?}" "${CURRENT_LINK:?}" "${SERVICE_NAME:?}" "${HEALTH_URL:?}" "${BUILD_COMMAND:?}" "${MIGRATION_PREFLIGHT_COMMAND:?}"
SERVICE_ROOT_ENV=${SERVICE_ROOT_ENV:-APP_ROOT}
SYSTEMD_SYSTEM_DIR=${SYSTEMD_SYSTEM_DIR:-/etc/systemd/system}
[[ "$SERVICE_ROOT_ENV" =~ ^[A-Z_][A-Z0-9_]*$ ]] || { echo 'DEPLOY ERROR: invalid service root environment name' >&2; exit 2; }
HEALTH_TIMEOUT_SECONDS=${HEALTH_TIMEOUT_SECONDS:-30}
[[ "$HEALTH_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] || { echo 'DEPLOY ERROR: invalid health timeout' >&2; exit 2; }
[[ "$CURRENT_LINK" == "$RELEASE_ROOT"/* ]] || { echo 'DEPLOY ERROR: current link must be below release root' >&2; exit 2; }
DEPLOY_EVENT_DIR=${DEPLOY_EVENT_DIR:-$RELEASE_ROOT/deploy-events}
PROTECTED_PATH_PATTERN=${PROTECTED_PATH_PATTERN:-'(^|/)(auth|oauth|token-store|startup-preflight)(/|\.|$)|(^|/)systemd(/|$)'}

deliver_event() {
  local outcome=$1 detail=$2 event temporary
  mkdir -p -m 0700 "$DEPLOY_EVENT_DIR"
  event="$DEPLOY_EVENT_DIR/$(date -u +%Y%m%dT%H%M%SZ)-$$-$outcome.pending"
  temporary="$event.tmp"
  OUTCOME="$outcome" DETAIL="$detail" node -e 'const text=`DEPLOY ${process.env.OUTCOME}: ${process.env.DETAIL}`;process.stdout.write(JSON.stringify({text,outcome:process.env.OUTCOME,detail:process.env.DETAIL,at:new Date().toISOString()}))' >"$temporary"
  chmod 0600 "$temporary"
  mv -Tf "$temporary" "$event"
  if [[ -n "${NOTIFY_URL:-}" ]] && curl --silent --show-error --fail --max-time 10 -H 'Content-Type: application/json' --data-binary @"$event" "$NOTIFY_URL" >/dev/null; then
    mv "$event" "${event%.pending}.delivered"
    return 0
  fi
  echo "DEPLOY ALARM: operator delivery pending event=$event" >&2
  return 1
}

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

# A root build may recreate dist under mode 0700. Apply service-readable and
# traversable permissions after the build while preserving executable bits.
chmod -R a+rX "$release"
find "$release" -type d -exec chmod a+rx {} +

previous=
if [[ -L "$CURRENT_LINK" ]]; then
  previous=$(readlink -f "$CURRENT_LINK")
elif [[ -e "$CURRENT_LINK" ]]; then
  echo "DEPLOY ERROR: current path exists and is not a symlink: $CURRENT_LINK" >&2
  exit 1
else
  previous=$REPO_ROOT
fi
previous_commit=$(git -C "$previous" rev-parse HEAD)

# Candidate changes to these boundaries require a separate reviewed procedure.
# The live deploy path itself never changes auth enforcement, token ownership,
# startup preflight, or service wiring.
if git -C "$REPO_ROOT" diff --name-only "$previous_commit..$commit" | LC_ALL=C grep -Eq "$PROTECTED_PATH_PATTERN"; then
  detail="protected deployment boundary changed candidate=$commit previous=$previous_commit"
  echo "DEPLOY ERROR: $detail" >&2
  deliver_event refused "$detail" || true
  exit 1
fi

# This command must create a disposable database, copy the live schema into it,
# apply the candidate migrations, and destroy only that database. It runs before
# the symlink, unit drop-in, daemon-reload, or service are touched.
echo "DEPLOY migration-preflight=$commit"
if ! (cd "$release" && bash -o pipefail -c "$MIGRATION_PREFLIGHT_COMMAND"); then
  detail="migration preflight failed candidate=$commit previous=$previous_commit; live service untouched"
  echo "DEPLOY ERROR: $detail" >&2
  deliver_event refused "$detail" || true
  exit 1
fi

activate() {
  local target=$1 temporary="$CURRENT_LINK.next.$$"
  ln -s "$target" "$temporary"
  mv -Tf "$temporary" "$CURRENT_LINK"
  systemctl restart "$SERVICE_NAME"
}

health_commit() {
  curl --silent --show-error --fail --max-time 5 "$HEALTH_URL" |
    node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{let x;try{x=JSON.parse(s)}catch{process.exit(1)}if(x.status!=="ok")process.exit(1);if(typeof x.build?.commit!=="string"||x.build.commit.length===0){process.stdout.write("__HEALTH_CONTRACT_DRIFT__");return}process.stdout.write(x.build.commit)})'
}

wait_for_commit() {
  local expected=$1 deadline observed= rc
  deadline=$((SECONDS + HEALTH_TIMEOUT_SECONDS))
  while ((SECONDS < deadline)); do
    if observed=$(health_commit); then
      :
    else
      rc=$?
      [[ "$rc" -eq 4 ]] && return 4
      observed=
    fi
    if [[ "$observed" == '__HEALTH_CONTRACT_DRIFT__' ]]; then
      echo 'DEPLOY ERROR: health contract drift: /healthz status=ok but build.commit is missing' >&2
      return 4
    fi
    [[ "$observed" == "$expected" ]] && return 0
    sleep 1
  done
  return 1
}

# Establish the exact healthy rollback identity before activation. systemd's
# unit state is deliberately irrelevant: only /healthz identity is accepted.
if wait_for_commit "$previous_commit"; then
  :
else
  health_result=$?
  [[ "$health_result" -eq 4 ]] && contract_detail='; /healthz is missing required build.commit'
  detail="current stand is not healthy at expected rollback SHA=$previous_commit; candidate=$commit untouched"
  detail+="${contract_detail:-}"
  echo "DEPLOY ERROR: $detail" >&2
  deliver_event refused "$detail" || true
  exit 1
fi

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
if wait_for_commit "$commit"; then
  :
else
  health_result=$?
  if [[ "$health_result" -eq 4 ]]; then
    echo "DEPLOY ALARM: health contract drift for candidate=$commit; rolling back to $previous" >&2
  else
    echo "DEPLOY ALARM: health did not report deployed commit=$commit; rolling back to $previous" >&2
  fi
  if activate "$previous" && wait_for_commit "$previous_commit"; then
    detail="deploy failed candidate=$commit; rollback healthy exact-sha=$previous_commit"
    echo "DEPLOY rollback=healthy commit=$previous_commit" >&2
    deliver_event rolled-back "$detail" || true
    exit 1
  fi
  detail="deploy failed candidate=$commit; rollback unhealthy expected-sha=$previous_commit"
  echo "DEPLOY CRITICAL: $detail" >&2
  deliver_event rollback-failed "$detail" || true
  exit 3
fi
echo "DEPLOY SUCCESS service=$SERVICE_NAME commit=$commit health=$HEALTH_URL"
