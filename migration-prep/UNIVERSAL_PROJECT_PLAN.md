# Universal `bpa-dev-infrastructure` project plan

This is a design and bootstrap plan only. Production implementation has not
been written, installed, or deployed.

## Bootstrap on clean Ubuntu

1. Verify Ubuntu version, CPU/RAM/disk headroom, time sync and TLS.
2. Install only pinned runtime prerequisites from an allow-listed manifest.
3. Create a dedicated unprivileged service user and private state directory.
4. Run a self-check that emits versions, capabilities and a redacted manifest.
5. Require an explicit operator command before enabling Telegram or dispatch.

## Security and access

Least privilege by default; separate operator, manager, worker and observer
roles; short-lived signed tokens; encrypted secret store integration; no tokens
in logs; audit every decision and access change. Production secrets and deploy
credentials are never copied from a development checkout.

## Self-initialisation

Initialization is idempotent and resumable: schema/version check, state-store
creation, key registration, health probe, synthetic mission, then readiness.
Partial initialization must fail closed and be safe to rerun.

## Reliability domains

Mission persistence uses append-only events plus snapshots. Managers have bounded
worker concurrency, retries with backoff, fencing and terminal archival. Branch
and disk hygiene is policy-driven: mission branches close only when terminal,
merged and without a worktree; caches have quotas and retention classes.

Telegram/MCP uses one fenced poll lease, durable offsets, message-ID dedupe,
reconnect/backpressure and a dead-letter queue. Product workers remain outside
this repository.

## Test harness and friend install

The harness must cover restart/replay, duplicate delivery, expired leases,
network reconnect, disk pressure, memory pressure, secret redaction and
rollback. A friend install is a signed, versioned bootstrap bundle with a
dry-run, local-only mode, explicit Telegram pairing, exportable diagnostics and
an uninstall path that preserves evidence unless the operator opts in.

## Implementation stages

P0 contracts and fixtures; P1 persistence/TTL/replay; P2 manager/worker
supervision; P3 Telegram/MCP adapter; P4 status CLI and hygiene workers; P5
clean-Ubuntu installer and friend flow; P6 chaos/soak, security review and
shadow migration. No stage implies production readiness until its gates pass.

