#!/usr/bin/env bash
set -euo pipefail

DOMAIN="${1:-}"
EXPECTED_IP="${2:-}"
[[ -n "$DOMAIN" ]] || { echo "Usage: edge/verify.sh <fqdn> [expected-ip]" >&2; exit 2; }

if [[ -n "$EXPECTED_IP" ]]; then
  mapfile -t dns_ips < <(getent ahostsv4 "$DOMAIN" | awk '{print $1}' | sort -u)
  printf 'DNS A: %s\n' "${dns_ips[*]:-(none)}"
  printf '%s\n' "${dns_ips[@]}" | grep -Fxq "$EXPECTED_IP" || {
    echo "FAIL: $DOMAIN does not resolve to $EXPECTED_IP" >&2; exit 1;
  }
fi

paths=(
  /api/integrations/qbo/callback
  /api/integrations/gmail/callback
  /api/integrations/drive/callback
)

for path in "${paths[@]}"; do
  headers="$(mktemp)"
  trap 'rm -f "$headers"' EXIT
  status="$(curl --silent --show-error --output /dev/null --dump-header "$headers" \
    --connect-timeout 10 --max-time 20 --write-out '%{http_code}' "https://$DOMAIN$path")"
  [[ "$status" =~ ^[1-4][0-9][0-9]$ ]] || {
    echo "FAIL: upstream callback returned HTTP $status: $path" >&2; exit 1;
  }
  grep -Eiq '^X-BPA-Edge:[[:space:]]*callback-proxy[[:space:]]*$' "$headers" || {
    echo "FAIL: callback was not served by the allowlisted edge route: $path" >&2; exit 1;
  }
  printf 'PASS TLS callback %-40s HTTP %s\n' "$path" "$status"
  rm -f "$headers"
  trap - EXIT
done

blocked_headers="$(mktemp)"
trap 'rm -f "$blocked_headers"' EXIT
blocked_status="$(curl --silent --show-error --output /dev/null --dump-header "$blocked_headers" \
  --connect-timeout 10 --max-time 20 --write-out '%{http_code}' "https://$DOMAIN/__edge_allowlist_probe__")"
[[ "$blocked_status" == 404 ]] || {
  echo "FAIL: non-allowlisted HTTPS path returned $blocked_status, not 404" >&2; exit 1;
}
if grep -Eiq '^X-BPA-Edge:[[:space:]]*callback-proxy' "$blocked_headers"; then
  echo 'FAIL: non-allowlisted HTTPS path reached the callback route' >&2; exit 1
fi
rm -f "$blocked_headers"
trap - EXIT
echo 'PASS HTTPS non-allowlisted path -> 404'

redirect_headers="$(mktemp)"
trap 'rm -f "$redirect_headers"' EXIT
redirect_status="$(curl --silent --show-error --output /dev/null --dump-header "$redirect_headers" \
  --connect-timeout 10 --max-time 20 --write-out '%{http_code}' "http://$DOMAIN/")"
[[ "$redirect_status" =~ ^30[1278]$ ]] || { echo "FAIL: HTTP returned $redirect_status, not a redirect" >&2; exit 1; }
grep -Eiq "^Location:[[:space:]]*https://$DOMAIN/[[:space:]]*$" "$redirect_headers" || {
  echo 'FAIL: HTTP redirect target is not the HTTPS origin' >&2; exit 1;
}
printf 'PASS HTTP redirect -> https://%s/ (%s)\n' "$DOMAIN" "$redirect_status"
printf 'PASS certificate: '
curl --silent --show-error --connect-timeout 10 --max-time 20 "https://$DOMAIN/" --output /dev/null
echo 'trusted TLS handshake'
