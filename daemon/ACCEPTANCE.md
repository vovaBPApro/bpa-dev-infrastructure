# Daemon acceptance checklist

The Bun/TypeScript daemon is the tested base of this repo. Acceptance runs on
`bun test` (see `server.test.ts`, `relay.test.ts`) plus the operational gates
below. This file preserves the *ideas* the predecessor's Python "contour"
encoded as acceptance/canary/hygiene harnesses; the harnesses themselves were
dropped in favor of Bun-native tests (Human directive: Bun/TS alignment, no
Python contour). Anything below that is not yet covered by `bun test` is a
follow-up acceptance item, not a claim of current coverage.

## Covered by `bun test` today

- Cross-session solicited/unsolicited turn classification.
- Early-relay suppression and event deduplication.
- Claude stop / Codex notify payload normalization; assistant-chunk extraction.
- Approval and decision (inline-button) parsing.
- Relay: payload normalization, blank-text preservation, rejection of
  unsupported payloads and non-2xx daemon responses.
- Stall / watchdog state evaluation.

## Operational acceptance gates (run against a stand, not committed secrets)

- **Health.** `GET /health` returns 200 from a freshly booted daemon on an
  ephemeral localhost port. Default bind is localhost-only; never bind a public
  interface in a stand.
- **Auth.** The relay HTTP route requires the configured
  `TELEGRAM_DAEMON_PORT` / token; unauthenticated or mis-ported requests are
  rejected, not silently accepted.
- **Resource limits (soak).** Bounded CPU and RAM over a short soak; the daemon
  stays within budget and does not leak file descriptors or unbounded state.
- **Disk hysteresis.** Disk-pressure admission uses high/low watermarks so the
  control plane does not flap at a single threshold.
- **Reconnect replay.** Events are idempotent by `event_id`, queued while
  disconnected, and replayed exactly once after reconnect (no dupes, no loss).
- **Lease fencing.** A single logical unit of work is held by one owner;
  heartbeats extend the lease and a dead owner is reaped before re-admission.
- **Mission lifecycle.** Event-sourced mission transitions are deterministic and
  terminal states are honored.
- **Provenance + rollback.** Evidence is redacted (no secrets), checkout is
  verified fail-closed, and rollback resolves to a concrete commit/image digest.
- **Manifest completeness.** The source/image manifest is complete before any
  cutover; missing evidence is a hard NO-GO.

## Non-negotiable

- **Zero secrets in the repo.** No `.env*`, `runtime/`, `*.bak`, tokens, or
  keys are ever committed (`.gitignore` enforces this; a staged-content secret
  scan runs before every commit). This is the one unforgivable failure.
- Stands use a test bot / fixtures and localhost-only bindings. Live Telegram
  credentials, production ports, and prod deploy are out of scope here.
