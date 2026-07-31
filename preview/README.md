# Per-lane previews

`bun preview/preview.ts start <lane> <worktree>` builds that worktree's root
`Dockerfile`, starts an isolated app and PostgreSQL database, and exposes the app
at `https://$PREVIEW_DOMAIN/preview/<lane>/` (`localhost` by default). Use `list`, `stop <lane>`, and
`reap`; the hygiene cron runs `reap` every ten minutes.

The app receives only generated values: a per-preview `DATABASE_URL`, a private
state mount, `INTEGRATIONS_MODE=NOT-CONFIGURED`, and
`OAUTH_CALLBACKS_ENABLED=false`. No production env file is read. OAuth callback
and connect paths below a preview are rejected by Caddy; production callback
paths remain routed only to production.

Defaults reserve loopback ports 13000-13999 (never 3000 or 4822). Each app is
limited to 0.75 CPU, 1 GiB RAM and 256 processes; each database to 0.25 CPU,
512 MiB RAM and 128 processes. Ten previews therefore have a 10 CPU / 15 GiB
hard ceiling, leaving capacity for the edge, production, and the daemon.

Install Caddy with `edge/install.sh`, which creates the tracked preview route
directory. Override `PREVIEW_STATE_ROOT`, `PREVIEW_ROUTES_DIR`,
`PREVIEW_DOMAIN`, `PREVIEW_DOCKERFILE`, or `PREVIEW_EDGE_RELOAD` only for
isolated tests. `fixture.Dockerfile` is the no-secret HTTP fixture used to prove
two-worktree concurrency; it is not a product image.
