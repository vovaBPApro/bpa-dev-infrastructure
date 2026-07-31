#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOMAIN=""
UPSTREAM=""

usage() {
  cat <<'EOF'
Usage: sudo edge/install.sh --domain <fqdn> --upstream <http[s]://host:port>

Installs Caddy, stages the tracked edge configuration, validates it, and starts
the edge. Caddy obtains the public certificate as part of this command once the
A record resolves to this host; renewal is automatic while the service runs.
EOF
}

while (($#)); do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --upstream) UPSTREAM="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ "$EUID" -eq 0 ]] || { echo 'ERROR: run as root (sudo)' >&2; exit 1; }
[[ "$DOMAIN" =~ ^([A-Za-z0-9](|[A-Za-z0-9-]*[A-Za-z0-9])\.)+[A-Za-z]{2,63}$ ]] || {
  echo 'ERROR: --domain must be a fully qualified DNS name' >&2; exit 2;
}
[[ "$UPSTREAM" =~ ^https?://(127\.0\.0\.1|localhost|\[[0-9A-Fa-f:]+\]|[A-Za-z0-9.-]+):[0-9]{1,5}$ ]] || {
  echo 'ERROR: --upstream must be an http(s) URL with an explicit host and port' >&2; exit 2;
}
[[ "$UPSTREAM" != *$'\n'* && "$DOMAIN" != *$'\n'* ]] || exit 2

if ! command -v caddy >/dev/null 2>&1; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y caddy
fi

install -d -o root -g caddy -m 0750 /etc/bpa-edge
install -o root -g root -m 0644 "$SCRIPT_DIR/Caddyfile" /etc/bpa-edge/Caddyfile
install -o root -g root -m 0644 "$SCRIPT_DIR/bpa-edge.service" /etc/systemd/system/bpa-edge.service
umask 027
{
  printf 'EDGE_DOMAIN=%s\n' "$DOMAIN"
  printf 'APP_UPSTREAM=%s\n' "$UPSTREAM"
} > /etc/bpa-edge/edge.env
chown root:caddy /etc/bpa-edge/edge.env
chmod 0640 /etc/bpa-edge/edge.env

EDGE_DOMAIN="$DOMAIN" APP_UPSTREAM="$UPSTREAM" caddy validate --config /etc/bpa-edge/Caddyfile

# The Debian package owns caddy.service; this repository owns bpa-edge.service.
# Never allow both to compete for ports 80/443.
systemctl disable --now caddy.service >/dev/null 2>&1 || true
systemctl daemon-reload
systemctl enable --now bpa-edge.service

echo "READY: https://$DOMAIN (certificate issuance is automatic; inspect with journalctl -u bpa-edge.service)"
