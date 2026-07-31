# HTTPS edge

Caddy is the edge because its native ACME client obtains and renews public TLS
certificates without a separate certbot timer. Port 80 is used by Caddy for the
HTTP-01 challenge and redirects; port 443 terminates TLS. Only the three exact
OAuth callback paths in `Caddyfile` proxy to the app. Every other path is a 404.

## Fresh-host install and certificate issuance

Prerequisites: Debian/Ubuntu with `apt`, systemd, inbound TCP 80/443, an A record
pointing at the host, and the app listening on a host port other than 4822. The
domain and upstream are runtime configuration and are not committed.

This is the single issuance/go-live command (replace both values):

```sh
sudo ./edge/install.sh --domain <fqdn> --upstream http://127.0.0.1:<app-port>
```

It installs the distribution Caddy package, copies the tracked config and unit,
validates them, and enables `bpa-edge.service`. Caddy requests the certificate
when the service starts and renews it automatically. Re-running the command is
idempotent and updates the domain/upstream. It does not touch
`bpa-telegram-daemon` or port 4822.

The host-local `/etc/bpa-edge/edge.env` contains only the selected domain and
upstream. Certificate private material is managed by Caddy under its system data
directory and must never be committed.

## Verification

Run the complete public verification after DNS resolves:

```sh
./edge/verify.sh <fqdn> 144.76.185.238
```

This uses normal CA validation (no `--insecure`), proves all three callback
routes carry the edge marker, and proves HTTP redirects to the same HTTPS
origin. Useful diagnostics are:

```sh
systemctl status bpa-edge.service
journalctl -u bpa-edge.service
ss -ltnp '( sport = :80 or sport = :443 or sport = :4822 )'
```

If DNS does not yet resolve to this host, do not start issuance repeatedly.
Validate the staged config with `./edge/edge.test.sh`, then run the one command
above once DNS is correct. Caddy's production issuance is the real ACME proof;
there is no meaningful offline ACME dry-run before the CA can resolve the name.
