# Infrastructure Migration Preparation (P0)

See [`HUMAN_REQUIREMENTS_MATRIX_2026-07-28.md`](HUMAN_REQUIREMENTS_MATRIX_2026-07-28.md)
for the verbatim Human requirements and acceptance traceability matrix.

This package defines a sidecar-first migration of the development control plane.
It does not migrate product code or perform a production cutover.

## Scope

The new repository owns mission persistence, leases/heartbeat TTL, manager and
worker lifecycle, Telegram/MCP reconnect, status projection, and append-only
evidence. Product workers remain in their existing repositories.

Carry forward only mechanisms with durable evidence: correlation IDs, signed
dispatch envelopes, mailbox guards, heartbeat-ingest tests, role/vendor policy,
and one-mission-in/one-rollup-out contracts.

The orchestrator must follow [`COMPLETION_GUARD.md`](COMPLETION_GUARD.md): one
mission chain at a time, evidence-backed terminal records, explicit NO-GO
blockers, immediate commit pushes, and preserved verbatim Human requirements.

Quarantine rather than copy runtime worktree files, ad-hoc shell orchestration,
status inferred from historical heartbeats, worker-owned Telegram leases, and
unverified generated product snapshots.

## Operating principle

Run the new control plane as a read-only shadow beside the current one on a
disposable stand. Compare projections for three missions before allowing one
canary manager to dispatch work.
