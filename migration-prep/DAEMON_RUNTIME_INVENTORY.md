# Daemon runtime inventory and migration packet

Status: phase-1 inventory only. Reference is `telegram-dev-daemon` main at
`4cdf3c70c6ec9d28608d7921b4dd4dd31ce340aa`. This document intentionally adds
no package manifest, lockfile, dependency, or runtime code.

## What exists in the reference

The reusable daemon runtime is the `templates/daemon/` tree:

| Path | Contract to preserve |
| --- | --- |
| `server.ts` | Bun HTTP/MCP server; default localhost port `4822`; Telegram bot lifecycle; reconnect state restore; pending-reply/permission/decision delivery; watchdog and stall detection; persisted binding and turn-delivery ledgers. |
| `relay.ts` | stdin JSON to daemon HTTP relay; requires `TELEGRAM_DAEMON_PORT`; rejects non-2xx responses. |
| `reliability.ts` | Pure parsing/classification/deduplication contract: Claude stop and Codex notify normalization, assistant-chunk extraction, approval/decision parsing, turn classification, relay decision, mission loading, and stall evaluation. |
| `server.test.ts` | Cross-session solicited/unsolicited classification, early-relay suppression, dedupe, Claude/Codex chunk parsing, approval/decision extraction, and stall state assertions. |
| `relay.test.ts` | Claude/Codex payload normalization, blank-text preservation, unsupported payload rejection. |
| `package.json`, `bun.lock`, `tsconfig.json` | Bun test/build entrypoint and pinned dependency graph. Adding these is a separate dependency gate; do not copy during inventory. |
| `run-daemon.sh.tmpl`, `launch-orchestrator.sh`, `start-claude.sh*`, `ensure-session.sh*` | Process/session bootstrap and reconnect orchestration. |
| `ctl.sh.tmpl`, `orchestrator-turnend-relay.sh`, `hooks/*` | Operator control, turn-end relay, and notification hooks. |

Reference operational/documentation contracts also include:
`docs/orchestrator_policy.md`, `docs/roles.md`, `docs/review_policy.md`,
`docs/development_workflow.md`, `docs/ops/permissions_policy.md`,
`docs/ops/auto_approve.example.json`, and
`docs/ORCHESTRATOR_RELAY_CONFIG.md`.

## What exists in the new repository

The new repository currently provides Python contour primitives, not a daemon
entrypoint: `contour/adapter.py` (local replay adapter), `dispatcher.py`
(lease/fleet width), `mission_lifecycle.py` (event-sourced mission state),
`provenance.py`/`runtime.py` (fail-closed checkout and rollback evidence),
`hygiene.py` (leases, reaper, disk admission), and `compose.yaml` plus
`docker_canary.py` (test-only canary). Existing tests cover deterministic local
replay, lifecycle, fencing, provenance, and short Docker canary checks.

There is currently no `server.ts`, `relay.ts`, Bun package, Telegram adapter,
MCP session endpoint, lane-report watchdog, or manager process in this repo.
Therefore the daemon cannot be claimed migrated or production-ready.

## Concrete migration packet (next implementation phase)

1. Freeze the reference checkout at the SHA above and create an isolated Bun
   stand under a new, clearly named subtree (no replacement of contour).
2. Add the reference runtime and its tests with only the minimum approved Bun
   manifest/lockfile changes. Preserve the localhost-only default and make
   state root, port, bot token, and orchestrator command explicit environment
   inputs; never commit secrets.
3. Add a stand-specific Compose project name, network, state directory, and
   port. Parallel stands must not share state or bind ports. The canonical
   integration stand remains separate from per-lane feature stands.
4. Execute the reference test suite unchanged first. Then add contract tests
   that compare Bun evidence with contour for reconnect replay, event
   deduplication, lease fencing, mission transitions, provenance linkage, and
   rollback fail-closed behavior.
5. Gate the stand on real `/health` response, authenticated relay route,
   bounded CPU/RAM soak, complete image/source manifest, and rollback to a
   concrete commit/image digest. Missing evidence is a hard NO-GO.
6. Run at least two isolated stands in parallel plus one canonical integration
   stand; collect machine-readable evidence keyed by stand/project/commit and
   compare results before any cutover decision.

## Explicit blockers and ownership

- Runtime choice is resolved in favor of a faithful Bun/TypeScript reference
  stand for migration parity; Python contour remains the lifecycle/evidence
  layer until parity is demonstrated.
- Adding `package.json`/`bun.lock` or dependencies is a Rule-15 dependency
  gate and requires Human approval before implementation.
- Live Telegram credentials, production ports, secrets, and production deploy
  are out of scope for the test stand. The stand must use fixtures or a test
  bot and localhost-only bindings.
- No source is deleted from either repository during migration; cutover is
  blocked until parity and rollback evidence are independently reviewed.

