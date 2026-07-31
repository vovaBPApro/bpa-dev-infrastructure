# Independent review: HTTPS edge

verdict: ACCEPT
reviewed-sha: a9c867163a52f624b5f5d8e6cc4ebb9216f46db4
independence: separate Codex reviewer session; read-only and did not author changes
risk: production infrastructure / TLS edge

The reviewer confirmed that the exact callback allowlist is parsed by Caddy,
callback verification rejects 5xx/000 responses, an unlisted live HTTPS path
must return an unmarked 404, and the installer rejects both invalid ports and
the Telegram daemon's reserved port 4822. The marked-502 regression fixture
passed. Public TLS/runtime verification remains correctly pending the selected
domain, DNS, app upstream, installation, and certificate issuance.

Commands reported passing:

```sh
./edge/edge.test.sh
./edge/verify.test.sh
shellcheck edge/*.sh
git diff origin/main...HEAD --check
pat=$(eval "$(sed -n 's/^[[:space:]]*secret_pattern=/REPLY=/p' gate/land-lib.sh)"; printf '%s' "$REPLY")
git diff origin/main...HEAD | LC_ALL=C grep -aE "$pat"
```

The last command produced no output (`secret-scan: clean`).
