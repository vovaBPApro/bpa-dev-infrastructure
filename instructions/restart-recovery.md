# Restart Recovery

## Binding rules

- Reconstruct mission, lane, lease, dispatch, and terminal-report state from durable records; never use chat memory, a process list, or a stale heartbeat as the source of truth.
- Every durable operation is idempotent. Replaying startup, enabling a service, redelivering a dispatch, or consuming an operator message must not duplicate work or replies.
- Use leases with expiry and fencing tokens. On restart, reclaim only expired ownership; a prior owner must be unable to mutate state after fencing.
- The watchdog is a single tick invoked by an external scheduler, not an immortal loop. It probes process and heartbeat health, records durable observations, rate-limits nudges, and starts or stops only its supervised unit.
- `orchestrator/status.sh` is a fail-soft observer over durable state and host probes; unavailable state is reported as unavailable, never invented as healthy.
- Make service installation and enablement idempotent. A repeat run must converge on one correctly configured service instance, not create duplicate sessions, timers, leases, or adapters.
- Rehearse recovery: terminate the process with an ungraceful kill, restart from an empty process memory, verify replay/deduplication/lease fencing, then prove health and teardown. Graceful restart alone is insufficient evidence.
- Keep recovery artifacts redacted and durable enough for a fresh operator to resume the mission.

Why: the only reliable restart is one that can recover correct state after memory and graceful shutdown are both gone.
