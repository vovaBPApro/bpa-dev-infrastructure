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

commit: pending
verify: `bunx tsc --ignoreConfig --noEmit --strict --target ES2022 --module Preserve --moduleResolution Bundler --types bun-types,node adapters/telegram.ts adapters/telegram.test.ts outbox.ts outbox.test.ts && bun test adapters/telegram.test.ts outbox.test.ts` (4 pass)
result: NO-GO
secret-scan: pending
remaining: commit, rerun verification at exact SHA; integration must resolve intentionally incomplete NEW server allowlist
