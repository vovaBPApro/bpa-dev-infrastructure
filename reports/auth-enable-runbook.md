# Turn authentication on (operator runbook)

**This is the operator's decision. Do not enable it yet:** the first-user
membership bootstrap and its fail-closed preflight have not landed. Without that
membership, login succeeds and every book page is denied.

## Phone checklist

1. Land/deploy the bootstrap; run its documented preflight. Continue only on
   `READY: auth enforcement may be enabled`.
2. Check auth is off and the service is healthy.
3. Set `AUTH_ENFORCEMENT=1`; restart; wait for healthy.
4. Sign in and check `/bill`, `/bill/transactions`, and `/bill/reports`.
5. Wrong or empty? Set `AUTH_ENFORCEMENT=0` and restart immediately.

## Exact procedure

Run these commands on the live host. Do not copy, print, or edit any other value
in `/etc/agentic-bpa/app.env`.

### 1. Prerequisites — stop on the first failure

Confirm the deployed product contains the landed bootstrap and preflight:

```sh
test -x /srv/releases/agentic-bpa/current/scripts/auth-first-user-bootstrap.mjs
test -x /srv/releases/agentic-bpa/current/scripts/auth-enforcement-preflight.mjs
```

If either command exits non-zero, **stop**. Those paths are the required
interface of the open bootstrap lane; this runbook must be updated if the landed
interface differs. Do not create a membership with ad-hoc SQL.

Follow the bootstrap's landed usage text to create/verify the operator account
and its single organization membership, then run the read-only preflight:

```sh
sudo -u agentic-bpa /usr/bin/node \
  /srv/releases/agentic-bpa/current/scripts/auth-enforcement-preflight.mjs
```

Continue only when it exits 0 and its final line is exactly:

```text
READY: auth enforcement may be enabled
```

Confirm the current release is healthy and enforcement is off:

```sh
curl --fail --silent --show-error http://127.0.0.1:3000/healthz
sudo grep -x 'AUTH_ENFORCEMENT=0' /etc/agentic-bpa/app.env
sudo systemctl is-active --quiet agentic-bpa.service
```

Each command must exit 0. The health response must say `"status":"ready"` and
contain a non-empty `build.commit`. Otherwise stop.

### 2. Enable and verify the service

```sh
sudo sed -i 's/^AUTH_ENFORCEMENT=0$/AUTH_ENFORCEMENT=1/' /etc/agentic-bpa/app.env
sudo grep -x 'AUTH_ENFORCEMENT=1' /etc/agentic-bpa/app.env
sudo systemctl restart agentic-bpa.service
for n in $(seq 1 30); do
  curl --fail --silent --show-error http://127.0.0.1:3000/healthz && break
  [ "$n" -lt 30 ] || exit 1
  sleep 1
done
sudo systemctl is-active --quiet agentic-bpa.service
```

All commands must exit 0; health must again report `ready` and the same deployed
`build.commit`. Auth takes effect when the restarted process accepts requests,
normally in seconds and no later than this 30-second health window.

### 3. Confirm the books in the browser

Open the live site in a private window. `/bill` must redirect to `/login`. Sign
in with the bootstrapped operator account, then check:

1. `/bill` — the Bill workspace opens, not an access-denied or empty-bootstrap
   page.
2. `/bill/transactions` — the transaction list is non-empty; the known live
   book contains **16,452 transactions**.
3. `/bill/reports` — open the full available period; totals render, and the
   ledger behind them contains **32,959 postings**, **107 accounts**, and net
   **0.0000** (balanced double entry).

Those are the live-readiness baseline numbers. If the UI applies a visible date
or pagination filter, clear it before comparing. Any denial, empty book, error,
or unexplained difference means rollback now.

### 4. Turn it off

This changes no book data; it restores the previous public access mode.

```sh
sudo sed -i 's/^AUTH_ENFORCEMENT=1$/AUTH_ENFORCEMENT=0/' /etc/agentic-bpa/app.env
sudo grep -x 'AUTH_ENFORCEMENT=0' /etc/agentic-bpa/app.env
sudo systemctl restart agentic-bpa.service
for n in $(seq 1 30); do
  curl --fail --silent --show-error http://127.0.0.1:3000/healthz && break
  [ "$n" -lt 30 ] || exit 1
  sleep 1
done
sudo systemctl is-active --quiet agentic-bpa.service
```

The rollback takes effect with the restarted process: normally seconds, bounded
by the same 30-second health window. Finally open `/bill` in a private window;
it must load without redirecting to `/login`.

## Evidence used

- `reports/auth-live-readiness-evidence.md`: all 66 org-scoped tables have zero
  NULL organization IDs; OFF/ON core counts and the three-table JOIN agree; no
  views exist; only the documented empty `auth_*` membership exemption is
  unforced.
- Product auth review rounds: open registration/shared data, mock-only proof,
  incomplete forced RLS, NULL live rows, and blank enforced login were closed;
  the empty first-user membership remains the activation blocker.
