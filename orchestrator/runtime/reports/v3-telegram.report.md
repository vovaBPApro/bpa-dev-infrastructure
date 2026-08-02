# v3-telegram lane report

## Public interface (published early)

- `TelegramAdapter.receiveOnce()`: polls an injected Bot API endpoint; persists each update through `InboundStore.putIfAbsent()` before calling the acknowledgement hook. Replayed update IDs are idempotent.
- `DurableOutbox.enqueue()`: persists a pending outbound item before delivery. `flush()` attempts each pending item once per process recovery epoch; failures remain pending and make channel status degraded; a later outbox instance retries and records one delivered result.
- `telegramChannelStatus(inbox, outbox)`: returns `healthy | degraded | unknown` plus durable counters and the last delivery error. Unknown storage state is never green.
- Live and fake Bot API use the same `BotApiClient` HTTP boundary configured by `baseUrl` and token; tests inject a deterministic local endpoint.

## Status

Implemented the pinned NEW daemon allowlist plus fresh Telegram HTTP adapter,
durable file inbox/outbox, recovery-epoch retry fencing, and truthful channel
status. Narrow seam verification is green. The temporary allowlist intentionally
omits several modules imported by NEW `server.ts`, so whole-daemon typecheck is
an integration `NO-GO` until the planned D2 split or foundation supplies a
complete boundary.

commit: 93737b2b79830ece8cd7e63e648cd52179b27b12
verify: new seam strict typecheck + tests: PASS (4/4); copied eligible tests: NO-GO (69 pass, 13 fail: gate pattern absent causes 10 inbox failures; pinned notify tests time out 3/3)
result: NO-GO
secret-scan: NO-GO (canonical scanner absent from empty v3 base; pinned canonical signature diff scan found no hits, but absence must fail closed)
remaining: foundation must land canonical gate; integration must resolve intentionally incomplete NEW server allowlist and pinned notify timeouts, then rerun at landed SHA
