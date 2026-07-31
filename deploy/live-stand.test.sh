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
BUILD_COMMAND='printf "{\"status\":\"ok\",\"build\":{\"commit\":\"\$(git rev-parse HEAD)\"}}\\n" > health.json'
HEALTH_TIMEOUT_SECONDS=1
STALE_COMMIT_THRESHOLD=0
MAIN_REF=origin/main
NOTIFY_URL=
EOF
cat >"$TMP/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat >"$TMP/bin/curl" <<EOF
#!/usr/bin/env bash
cat '$TMP/releases/current/health.json'
EOF
chmod +x "$TMP/bin/systemctl" "$TMP/bin/curl"
PATH="$TMP/bin:$PATH" "$ROOT/deploy/live-stand.sh" "$TMP/config" "$new" | grep -F "DEPLOY SUCCESS service=fixture.service commit=$new"
[[ "$(readlink -f "$TMP/releases/current")" == "$TMP/releases/$new" ]]

# Required red lock: a bad candidate is rolled back to the last healthy release.
printf three >"$repo/source" && git -C "$repo" commit -am three >/dev/null
bad=$(git -C "$repo" rev-parse HEAD)
git -C "$repo" push origin HEAD:main >/dev/null
sed -i "s#BUILD_COMMAND=.*#BUILD_COMMAND='printf not-json > health.json'#" "$TMP/config"
if PATH="$TMP/bin:$PATH" "$ROOT/deploy/live-stand.sh" "$TMP/config" "$bad" >"$TMP/bad.out" 2>"$TMP/bad.err"; then
  echo 'FAIL: unhealthy release was accepted' >&2; exit 1
fi
grep -Fq 'rolling back' "$TMP/bad.err"
[[ "$(readlink -f "$TMP/releases/current")" == "$TMP/releases/$new" ]]
echo 'FAIL-BEFORE unhealthy release would remain active; rollback lock: PASS'

sed -i "s#BUILD_COMMAND=.*#BUILD_COMMAND='printf \"{\\\"status\\\":\\\"ok\\\",\\\"build\\\":{\\\"commit\\\":\\\"\$(git rev-parse HEAD)\\\"}}\\\\n\" > health.json'#" "$TMP/config"
git -C "$repo" reset --hard "$new" >/dev/null
git -C "$repo" fetch origin main >/dev/null
if PATH="$TMP/bin:$PATH" "$ROOT/deploy/check-live-stand-staleness.sh" "$TMP/config" >"$TMP/stale.out" 2>"$TMP/stale.err"; then
  echo 'FAIL: stale serving release was silent' >&2; exit 1
fi
grep -Fq 'STAND-STALENESS ALARM:' "$TMP/stale.err"
echo 'FAIL-BEFORE stale serving commit was silent; staleness alarm lock: PASS'
