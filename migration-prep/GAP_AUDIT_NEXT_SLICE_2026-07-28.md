# Stable daemon parity gap audit — next implementation slice

Status: **NO-GO / inventory-only**. The stable checkout referenced by
`DAEMON_RUNTIME_INVENTORY.md` (SHA `4cdf3c70c6ec9d28608d7921b4dd4dd31ce340aa`)
is not present in this workspace, so no source-level parity claim is made.

## Evidence

- New contour suite: `python3 -m unittest discover -s contour -p 'test_*.py' -q`
  (23 tests green at audit time).
- New repository has no `server.ts`, `relay.ts`, Bun manifest, Telegram/MCP
  endpoint, or manager process; this is recorded in the inventory.
- Docker contract artifact records health/auth/resource/rollback as blocked.

## Smallest safe next slice

Import the reference `templates/daemon/` tree unchanged into an isolated
`daemon/` subtree, without changing dependency manifests in this slice. Add
only a read-only adapter boundary that emits the existing contour evidence
format. Required files from the stable source are `server.ts`, `relay.ts`,
`reliability.ts`, and their `server.test.ts`/`relay.test.ts`; bootstrap scripts
remain unchanged until parity tests pass.

## Verification commands

1. `bun test daemon/server.test.ts daemon/relay.test.ts` (reference tests,
   unchanged).
2. `python3 -m unittest discover -s contour -p 'test_*.py' -q` (contour
   regression lock).
3. `docker compose -f contour/compose.yaml config --quiet` followed by a
   disposable build/start/health/stop run; missing authenticated route,
   resource limits, manifest, or rollback evidence is hard NO-GO.
4. Differential replay of three recorded missions: reconnect, duplicate
   delivery, lease fencing, terminal projection, and rollback evidence must
   match before any cutover.

## Explicit blockers

Stable source checkout/content is unavailable locally; obtaining it and any
Bun dependency/lockfile mutation are approval gates. No daemon implementation
or Docker promotion should proceed until that source is mounted and the above
commands produce durable evidence.
