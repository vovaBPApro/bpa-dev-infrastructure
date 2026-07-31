#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
repo=$TMP/repo
mkdir -p "$repo" "$TMP/bin" "$TMP/releases"
git -C "$TMP" init --bare origin.git >/dev/null
git clone "$TMP/origin.git" "$repo" >/dev/null 2>&1
git -C "$repo" config user.email test@example.test
git -C "$repo" config user.name Test
printf one >"$repo/source"
git -C "$repo" add source && git -C "$repo" commit -m one >/dev/null && git -C "$repo" push -u origin HEAD:main >/dev/null
old=$(git -C "$repo" rev-parse HEAD)
printf two >"$repo/source"
git -C "$repo" commit -am two >/dev/null && git -C "$repo" push origin HEAD:main >/dev/null
new=$(git -C "$repo" rev-parse HEAD)
cat >"$TMP/config" <<EOF
REPO_ROOT=$repo
RELEASE_ROOT=$TMP/releases
CURRENT_LINK=$TMP/releases/current
SERVICE_NAME=fixture.service
SERVICE_ROOT_ENV=APP_ROOT
SYSTEMD_SYSTEM_DIR=$TMP/systemd
HEALTH_URL=http://fixture/healthz
BUILD_COMMAND='test -f .git && test "\$PWD" = "\$(git rev-parse --show-toplevel)" && touch install-ran && mkdir -p dist && printf "{\"status\":\"ok\",\"build\":{\"commit\":\"\$(git rev-parse HEAD)\"}}\\n" > health.json && printf app > dist/app.js && chmod 0700 . dist'
MIGRATION_PREFLIGHT_COMMAND='touch "$TMP/preflight-passed"'
HEALTH_TIMEOUT_SECONDS=4
POST_ACTIVATING_DELAY_SECONDS=1
STALE_COMMIT_THRESHOLD=0
MAIN_REF=origin/main
NOTIFY_URL=http://fixture/notify
DEPLOY_EVENT_DIR=$TMP/events
EOF
cat >"$TMP/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == show ]]; then
  count=$(cat "${STATE_MARKER:?}" 2>/dev/null || printf 0)
  if ((count < 2)); then
    printf '%s' $((count + 1)) >"$STATE_MARKER"
    echo activating
  else
    printf 3 >"$STATE_MARKER"
    echo active
  fi
  exit 0
fi
if [[ "$1" == restart && "${REQUIRE_PREFLIGHT:-0}" == 1 && ! -f "${PREFLIGHT_MARKER:?}" ]]; then
  echo 'restart occurred before migration preflight' >&2
  exit 91
fi
if [[ "$1" == restart && -n "${RESTART_MARKER:-}" ]]; then
  printf 0 >"$RESTART_MARKER"
fi
if [[ "$1" == restart ]]; then printf 0 >"${STATE_MARKER:?}"; fi
exit 0
EOF
cat >"$TMP/bin/curl" <<EOF
#!/usr/bin/env bash
if [[ "\$*" == *http://fixture/notify* ]]; then
  payload=
  for arg in "\$@"; do [[ "\$arg" == @* ]] && payload=\$arg; done
  [[ "\$payload" == @* ]] || exit 2
  cp "\${payload#@}" '$TMP/notification.json'
  exit 0
fi
if [[ -n "\${RESTART_MARKER:-}" && -f "\$RESTART_MARKER" ]]; then
  attempts=\$(cat "\$RESTART_MARKER")
  if ((attempts < \${STARTUP_FAILURES:-0})); then
    printf '%s' \$((attempts + 1)) >"\$RESTART_MARKER"
    exit 7
  fi
fi
if [[ -f "\${STATE_MARKER:?}" ]] && ((\$(cat "\$STATE_MARKER") < 3)); then
  echo 'probe occurred while service was activating' >&2
  exit 86
fi
cat '$TMP/releases/current/health.json'
EOF
chmod +x "$TMP/bin/systemctl" "$TMP/bin/curl"
# Model an already healthy live stand at the exact previous SHA.
git -C "$repo" worktree add --detach "$TMP/releases/$old" "$old" >/dev/null
printf '{"status":"ok","build":{"commit":"%s"}}\n' "$old" >"$TMP/releases/$old/health.json"
ln -s "$TMP/releases/$old" "$TMP/releases/current"
PATH="$TMP/bin:$PATH" PREFLIGHT_MARKER="$TMP/preflight-passed" STATE_MARKER="$TMP/service-state" "$ROOT/deploy/live-stand.sh" "$TMP/config" "$new" | grep -F "DEPLOY SUCCESS service=fixture.service commit=$new"
[[ ! -e "$TMP/preflight-passed" ]]
[[ "$(readlink -f "$TMP/releases/current")" == "$TMP/releases/$new" ]]
[[ -f "$TMP/releases/$new/install-ran" ]]
[[ ! -e "$TMP/releases/current.next.$$" ]]
[[ "$(stat -c %a "$TMP/releases/$new")" == 755 ]]
[[ "$(stat -c %a "$TMP/releases/$new/dist")" == 755 ]]
echo 'FAIL-BEFORE root build left release and regenerated dist at 0700; post-build permission lock: PASS'
echo 'FAIL-BEFORE probing during activating false-alarmed; settled-state delay lock: PASS'

# Required red lock: a bad candidate is rolled back to the last healthy release.
printf three >"$repo/source" && git -C "$repo" commit -am three >/dev/null
mkdir -p "$repo/migrations" && printf 'select 1;\n' >"$repo/migrations/001.sql"
git -C "$repo" add migrations/001.sql && git -C "$repo" commit --amend --no-edit >/dev/null
bad=$(git -C "$repo" rev-parse HEAD)
git -C "$repo" push origin HEAD:main >/dev/null
sed -i "s#BUILD_COMMAND=.*#BUILD_COMMAND='printf not-json > health.json'#" "$TMP/config"
if PATH="$TMP/bin:$PATH" PREFLIGHT_MARKER="$TMP/preflight-passed" REQUIRE_PREFLIGHT=1 RESTART_MARKER="$TMP/restart-attempts" STARTUP_FAILURES=2 STATE_MARKER="$TMP/service-state" "$ROOT/deploy/live-stand.sh" "$TMP/config" "$bad" >"$TMP/bad.out" 2>"$TMP/bad.err"; then
  echo 'FAIL: unhealthy release was accepted' >&2; exit 1
fi
grep -Fq 'rolling back' "$TMP/bad.err"
grep -Fq "rollback=healthy commit=$new" "$TMP/bad.err"
[[ "$(readlink -f "$TMP/releases/current")" == "$TMP/releases/$new" ]]
grep -Fq "exact-sha=$new" "$TMP/events"/*.delivered
grep -Fq '"outcome":"rolled-back"' "$TMP/notification.json"
[[ "$(cat "$TMP/restart-attempts")" -ge 2 ]]
echo 'FAIL-BEFORE app startup failure would remain active and immediate rollback probe false-alarmed; exact-SHA wait lock: PASS'

# A ready response without build identity is contract drift, not an ordinary
# failed health probe. Refuse it loudly and restore the proven previous SHA.
printf four >"$repo/source" && git -C "$repo" commit -am four >/dev/null
drift=$(git -C "$repo" rev-parse HEAD)
git -C "$repo" push origin HEAD:main >/dev/null
sed -i "s#BUILD_COMMAND=.*#BUILD_COMMAND='printf eyJzdGF0dXMiOiJvayJ9Cg== | base64 -d > health.json'#" "$TMP/config"
rm -f "$TMP/restart-attempts"
if PATH="$TMP/bin:$PATH" PREFLIGHT_MARKER="$TMP/preflight-passed" RESTART_MARKER="$TMP/restart-attempts" STATE_MARKER="$TMP/service-state" "$ROOT/deploy/live-stand.sh" "$TMP/config" "$drift" >"$TMP/drift.out" 2>"$TMP/drift.err"; then
  echo 'FAIL: health response without build.commit was accepted' >&2; exit 1
fi
grep -Fq 'health contract drift: /healthz status=ok but build.commit is missing' "$TMP/drift.err"
grep -Fq "rollback=healthy commit=$new" "$TMP/drift.err"
[[ "$(readlink -f "$TMP/releases/current")" == "$TMP/releases/$new" ]]
echo 'FAIL-BEFORE readiness-only health silently caused rollback; fail-loud contract lock: PASS'

# A migration collision is rejected before any restart or activation.
printf 'select 2;\n' >"$repo/migrations/002.sql"
git -C "$repo" add migrations/002.sql && git -C "$repo" commit -m migration-conflict >/dev/null
conflict=$(git -C "$repo" rev-parse HEAD)
sed -i "s#MIGRATION_PREFLIGHT_COMMAND=.*#MIGRATION_PREFLIGHT_COMMAND='exit 42'#" "$TMP/config"
rm -f "$TMP/preflight-passed"
if PATH="$TMP/bin:$PATH" PREFLIGHT_MARKER="$TMP/preflight-passed" STATE_MARKER="$TMP/service-state" "$ROOT/deploy/live-stand.sh" "$TMP/config" "$conflict" >"$TMP/preflight.out" 2>"$TMP/preflight.err"; then
  echo 'FAIL: migration conflict was accepted' >&2; exit 1
fi
grep -Fq 'migration preflight failed' "$TMP/preflight.err"
grep -Fq '"outcome":"refused"' "$TMP/notification.json"
[[ "$(readlink -f "$TMP/releases/current")" == "$TMP/releases/$new" ]]
[[ ! -e "$TMP/releases/$conflict" ]]
echo 'FAIL-BEFORE migration conflict restarted live stand; preflight lock: PASS'

sed -i "s#BUILD_COMMAND=.*#BUILD_COMMAND='printf \"{\\\"status\\\":\\\"ok\\\",\\\"build\\\":{\\\"commit\\\":\\\"\$(git rev-parse HEAD)\\\"}}\\\\n\" > health.json'#" "$TMP/config"
git -C "$repo" reset --hard "$new" >/dev/null
git -C "$repo" fetch origin main >/dev/null
if PATH="$TMP/bin:$PATH" "$ROOT/deploy/check-live-stand-staleness.sh" "$TMP/config" >"$TMP/stale.out" 2>"$TMP/stale.err"; then
  echo 'FAIL: stale serving release was silent' >&2; exit 1
fi
grep -Fq 'STAND-STALENESS ALARM:' "$TMP/stale.err"
echo 'FAIL-BEFORE stale serving commit was silent; staleness alarm lock: PASS'
