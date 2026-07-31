#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURE="$(mktemp -d)"
trap 'rm -rf "$FIXTURE"' EXIT

cat > "$FIXTURE/getent" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' '192.0.2.10 STREAM fixture.test'
EOF

cat > "$FIXTURE/curl" <<'EOF'
#!/usr/bin/env bash
headers=''
url=''
while (($#)); do
  case "$1" in
    --dump-header) headers="$2"; shift 2 ;;
    http://*|https://*) url="$1"; shift ;;
    *) shift ;;
  esac
done
case "$url" in
  http://*)
    printf 'Location: https://fixture.test/\r\n' > "$headers"
    printf '308'
    ;;
  */__edge_allowlist_probe__)
    : > "$headers"
    printf '404'
    ;;
  */api/integrations/*/callback)
    printf 'X-BPA-Edge: callback-proxy\r\n' > "$headers"
    printf '%s' "${FIXTURE_CALLBACK_STATUS:-400}"
    ;;
  *)
    : > "${headers:-/dev/null}"
    printf '404'
    ;;
esac
EOF
chmod +x "$FIXTURE/getent" "$FIXTURE/curl"

PATH="$FIXTURE:$PATH" "$SCRIPT_DIR/verify.sh" fixture.test 192.0.2.10 >/dev/null

if PATH="$FIXTURE:$PATH" FIXTURE_CALLBACK_STATUS=502 \
  "$SCRIPT_DIR/verify.sh" fixture.test 192.0.2.10 >"$FIXTURE/out" 2>&1; then
  echo 'ERROR: verifier accepted a marked upstream 502' >&2
  exit 1
fi
grep -Fq 'FAIL: upstream callback returned HTTP 502' "$FIXTURE/out"
echo 'PASS regression: marked upstream 502 fails verification'
