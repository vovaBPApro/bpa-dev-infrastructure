#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck disable=SC2016 # these are literal Caddy placeholders
grep -Fq '{$EDGE_DOMAIN}' "$SCRIPT_DIR/Caddyfile"
# shellcheck disable=SC2016 # these are literal Caddy placeholders
grep -Fq 'reverse_proxy @oauth_callbacks {$APP_UPSTREAM}' "$SCRIPT_DIR/Caddyfile"
[[ "$(grep -c '/api/integrations/.*/callback' "$SCRIPT_DIR/Caddyfile")" -eq 3 ]]
grep -Fq 'respond 404' "$SCRIPT_DIR/Caddyfile"
grep -Fq 'AmbientCapabilities=CAP_NET_BIND_SERVICE' "$SCRIPT_DIR/bpa-edge.service"
grep -Fq 'EnvironmentFile=/etc/bpa-edge/edge.env' "$SCRIPT_DIR/bpa-edge.service"

"$SCRIPT_DIR/install.sh" --help >/dev/null
if "$SCRIPT_DIR/install.sh" --domain 'bad domain' --upstream http://127.0.0.1:3000 >/dev/null 2>&1; then
  echo 'ERROR: installer accepted an invalid domain' >&2
  exit 1
fi
if "$SCRIPT_DIR/install.sh" --domain edge.test.invalid --upstream 'http://127.0.0.1:3000/injected' >/dev/null 2>&1; then
  echo 'ERROR: installer accepted an invalid upstream' >&2
  exit 1
fi

if command -v caddy >/dev/null 2>&1; then
  EDGE_DOMAIN=edge.test.invalid APP_UPSTREAM=http://127.0.0.1:3000 \
    caddy validate --config "$SCRIPT_DIR/Caddyfile"
elif command -v docker >/dev/null 2>&1; then
  docker run --rm \
    -e EDGE_DOMAIN=edge.test.invalid -e APP_UPSTREAM=http://127.0.0.1:3000 \
    -v "$SCRIPT_DIR/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2.10.0 \
    caddy validate --config /etc/caddy/Caddyfile
else
  echo 'ERROR: caddy or docker is required for config validation' >&2
  exit 1
fi

echo 'PASS edge configuration and exact callback allowlist'
