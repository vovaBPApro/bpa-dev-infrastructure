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
