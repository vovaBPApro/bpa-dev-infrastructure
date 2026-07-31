#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP_DIR="$(mktemp -d)"
CADDY_PID=""
UPSTREAM_PID=""

cleanup() {
  [[ -z "$CADDY_PID" ]] || kill "$CADDY_PID" 2>/dev/null || true
  [[ -z "$UPSTREAM_PID" ]] || kill "$UPSTREAM_PID" 2>/dev/null || true
  wait "$CADDY_PID" "$UPSTREAM_PID" 2>/dev/null || true
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

# shellcheck disable=SC2016 # these are literal Caddy placeholders
grep -Fq '{$EDGE_DOMAIN}' "$SCRIPT_DIR/Caddyfile"
# shellcheck disable=SC2016 # these are literal Caddy placeholders
grep -Fq 'reverse_proxy {$APP_UPSTREAM}' "$SCRIPT_DIR/Caddyfile"
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
for forbidden_upstream in http://127.0.0.1:4822 http://127.0.0.1:99999; do
  if "$SCRIPT_DIR/install.sh" --domain edge.test.invalid --upstream "$forbidden_upstream" >/dev/null 2>&1; then
    echo "ERROR: installer accepted forbidden upstream $forbidden_upstream" >&2
    exit 1
  fi
done

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

command -v caddy >/dev/null 2>&1 || {
  echo 'ERROR: local caddy is required for the HTTPS routing regression lock' >&2
  exit 1
}
command -v bun >/dev/null 2>&1 || {
  echo 'ERROR: bun is required for the stub upstream' >&2
  exit 1
}

# Use lane-local high ports so the test neither disturbs nor depends on the live edge.
PORT_OFFSET=$((BASHPID % 1000))
EDGE_PORT=$((24000 + PORT_OFFSET))
UPSTREAM_PORT=$((25000 + PORT_OFFSET))
cat >"$TMP_DIR/upstream.ts" <<'EOF'
const port = Number(process.env.STUB_PORT);
Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(request) {
    return new Response(new URL(request.url).pathname, {
      status: 409,
      headers: { "X-Stub-Upstream": "reached" },
    });
  },
});
EOF
STUB_PORT="$UPSTREAM_PORT" bun run "$TMP_DIR/upstream.ts" >"$TMP_DIR/upstream.log" 2>&1 &
UPSTREAM_PID=$!
EDGE_DOMAIN="https://localhost:$EDGE_PORT" EDGE_HTTP_PORT=$((EDGE_PORT + 2000)) \
  APP_UPSTREAM="http://127.0.0.1:$UPSTREAM_PORT" \
  caddy run --config "$SCRIPT_DIR/Caddyfile" >"$TMP_DIR/caddy.log" 2>&1 &
CADDY_PID=$!

ready=false
for _ in {1..50}; do
  if curl --insecure --silent --output /dev/null "https://localhost:$EDGE_PORT/not-public"; then
    ready=true
    break
  fi
  sleep 0.1
done
if [[ "$ready" != true ]]; then
  echo 'ERROR: test edge did not become ready' >&2
  sed -n '1,120p' "$TMP_DIR/caddy.log" >&2
  exit 1
fi

for callback in qbo gmail drive; do
  headers="$TMP_DIR/$callback.headers"
  body="$TMP_DIR/$callback.body"
  status="$(curl --insecure --silent --show-error --dump-header "$headers" \
    --output "$body" --write-out '%{http_code}' \
    "https://localhost:$EDGE_PORT/api/integrations/$callback/callback")"
  [[ "$status" == 409 ]] || {
    echo "ERROR: $callback callback returned $status instead of upstream 409" >&2
    exit 1
  }
  grep -qi '^X-Stub-Upstream: reached' "$headers"
  grep -qi '^X-BPA-Edge: callback-proxy' "$headers"
  [[ "$(<"$body")" == "/api/integrations/$callback/callback" ]]
done

status="$(curl --insecure --silent --show-error --output "$TMP_DIR/fallback.body" \
  --write-out '%{http_code}' "https://localhost:$EDGE_PORT/not-public")"
[[ "$status" == 404 ]] || {
  echo "ERROR: unmatched path returned $status instead of 404" >&2
  exit 1
}

echo 'PASS HTTPS edge routes exact callback allowlist and rejects unmatched paths'
