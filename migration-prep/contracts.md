# P0 contracts

1. **Mission:** append-only events and snapshots keyed by `mission_id` and
   `correlation_id`; replay is deterministic and idempotent.
2. **Lease:** one owner, expiry timestamp, fencing token; expired owners cannot
   dispatch or report success.
3. **Heartbeat:** only a live lease plus a fresh heartbeat and `running` report
   projects as active. Terminal reports never project as active.
4. **Dispatch:** signed envelope contains mission, step, vendor, prompt hash and
   evidence target. Duplicate envelope delivery is harmless.
5. **Rollup:** exactly one terminal rollup per mission; retries append evidence,
   never overwrite history.
6. **Telegram/MCP:** one poll lease, persisted offset, message-ID dedupe,
   bounded retry/backoff, reconnect without duplicate replies.
7. **Manifest:** source SHA, remote, image digest, schema version and UTC time
   are mandatory before a stand is accepted.

