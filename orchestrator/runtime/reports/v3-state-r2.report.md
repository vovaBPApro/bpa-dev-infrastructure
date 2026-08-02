# Published v3 state schema contract

One SQLite store, exported as both `DurableStore` and `StateStore` from `core/state.ts`, owns four tables: `missions`, `managers`, `lanes`, and `outbox`. Mission records carry correlation and acceptance identity. Managers carry mission parentage at depth 1. Lanes carry manager parentage at depth 2, generation, retry budget, acceptance id, fenced lease owner/token/deadline, acknowledgement time, semantic evidence time/path, and terminal SHA/report/verdict. Outbox records carry a unique dedupe key, JSON payload, delivery state, attempts, last error, and delivery time. `reconstruct()` returns all four durable record sets after restart; `mission-cli.ts` executes exclusively through this store.

## Tier-A rejection disposition

1. **Blocking false-green/evidence failure:** fixed by `core/regression-r2.sh`. `core/regression-r2.sh 10d6c269f9928288f220716571345050cc5f284b` exits 1; `core/regression-r2.sh HEAD` exits 0.
2. **Blocking integration-contract split:** fixed. The legacy schema was deleted; `StateStore` is an alias of `DurableStore`, and both the CLI and restart tests exercise the full published contract.
3. **Security/least-privilege:** fixed. `sandboxed-lane` no longer receives `push`; its exact denial and trusted approval boundary are locked in `core/capabilities.test.ts`.
4. **Donor parity unproven:** fixed by named executable OLD mailbox-replay and handoff-record parity cases in `core/state.test.ts`, including restart deduplication, acknowledgement, semantic evidence, and terminal evidence.

## Verification evidence

- `core/regression-r2.sh 10d6c269f9928288f220716571345050cc5f284b` — exit 1 (red-before).
- `core/regression-r2.sh HEAD` — 5 pass, 0 fail.
- `bun test core` — 14 pass, 0 fail, 43 assertions.
- `git diff --check` — exit 0.

commit: b82c35b80e6d5c491a5bd5bb6ba6528c2859d727
verify: core/regression-r2.sh HEAD && bun test core && git diff --check
result: NO-GO
secret-scan: NO-GO (scanner missing: gate/land-lib.sh is absent at this isolated lane SHA)
remaining: integrate the foundation gate, run the canonical origin/v3...HEAD scan, and reverify at the landed boundary
