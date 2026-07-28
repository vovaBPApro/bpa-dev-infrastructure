# Durable state store

`StateStore` uses a single SQLite file selected by `BPA_STATE_DB_PATH` (or
`STATE_DB_PATH`); callers may pass a path explicitly for tests. It enables WAL
mode and serializes mutations with `BEGIN IMMEDIATE`.

Mission state machine:

```text
queued ──> running ──> succeeded
  │          │  └──> failed
  └──> failed│
             └──> recovering ──> queued | running | failed
```

Lanes use `queued -> running -> succeeded|failed`. Terminal states have no
outbound transition. Mission, lane, and lease changes append an immutable row
to `events` in the same transaction as the snapshot change.

`acquireLease(owner, key, ttlMs)` grants one live owner for a key and returns a
monotonically increasing fencing token. Renew/release require the exact current
owner and token; an expired or superseded owner is fenced. Reaping marks expired
lease rows released, while a later acquisition gets a greater token even if the
reaper has not yet run. `listActive` returns only unexpired, unreleased leases.

This closes the problem-matrix rows for stale/false-active status,
manager/worker fragility, and the lease portion of Telegram/MCP reconnect risk:
expired workers cannot renew or release a newer lease, and a live lease has one
owner across SQLite connections.

## Mission CLI

`bun core/mission-cli.ts` is the durable lifecycle interface used by an
orchestrator after a restart. It reads `INFRA_STATE_DB`, defaulting to
`runtime/state.db` relative to the repository root, and creates the database
parent directory when needed.

```text
bun core/mission-cli.ts mission create <correlation-id>
bun core/mission-cli.ts mission transition <id> <state>
bun core/mission-cli.ts lane create <mission-id> <lane-id>
bun core/mission-cli.ts lane transition <lane-id> <state>
bun core/mission-cli.ts lease acquire <owner> <key> <ttl-ms>
bun core/mission-cli.ts lease renew <owner> <key> <token>
bun core/mission-cli.ts lease release <owner> <key> <token>
bun core/mission-cli.ts reap
bun core/mission-cli.ts status
```

Successful mutations print a single machine-readable record. `status` prints a
single JSON object containing non-terminal missions and lanes plus unexpired,
unreleased leases; this is the truth an orchestrator uses after restart.
Failures print one `ERROR` line and exit non-zero. A live lease acquisition
prints `ERROR LEASE-HELD`. Lease renewals use a fixed 30-second TTL because the
compact renew command intentionally has no TTL argument.
