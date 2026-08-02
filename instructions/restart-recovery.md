---
id: restart-recovery
layer: L1
status: binding
audience: orchestrator
tags: [restart, recovery, durability]
summary: Reconstruct mission and lane state from durable records; never trust chat memory, process lists, or stale heartbeats.
---

# Restart Recovery

## Alert delivery boundary

The system watchdog deliberately owns no Telegram credential. It appends loud
recovery alerts to the configured `NUDGE_OUTBOX_FILE`; the independently
managed `bpa-telegram-daemon.service` drains that same file and routes it to the
bound Human chat even when the orchestrator tmux session is absent. If the
orchestrator and Telegram daemon fail simultaneously, the durable outbox
retains the alert but cannot make the Human reachable until the daemon
recovers. Operators requiring notification through that simultaneous failure
need a separately credentialed, independently supervised off-host channel.

## Binding rules

- Reconstruct mission, lane, lease, dispatch, and terminal-report state from durable records; never use chat memory, a process list, or a stale heartbeat as the source of truth.
- **Fresh provider-session boundary.** An operator-requested kill/start or restart creates a new provider conversation identity; never resume, continue, fork, or reactivate the previous provider conversation. Recover continuity only from declared durable state and one deduplicated recent-message projection with repository-defined time, message, and character caps.
- Every delivery path, including messages buffered while no provider is active, is inside those same caps. Prove the identity changed and the old identity can no longer publish; otherwise recovery is `NO-GO`.
- Every durable operation is idempotent. Replaying startup, enabling a service, redelivering a dispatch, or consuming an operator message must not duplicate work or replies.
- Use leases with expiry and fencing tokens. On restart, reclaim only expired ownership; a prior owner must be unable to mutate state after fencing.
- The watchdog is a single tick invoked by an external scheduler, not an immortal loop. It probes process and heartbeat health, records durable observations, rate-limits nudges, and starts or stops only its supervised unit.
- `orchestrator/status.sh` is a fail-soft observer over durable state and host probes; unavailable state is reported as unavailable, never invented as healthy.
- Make service installation and enablement idempotent. A repeat run must converge on one correctly configured service instance, not create duplicate sessions, timers, leases, or adapters.
- Rehearse recovery: terminate the process with an ungraceful kill, restart from an empty process memory, verify replay/deduplication/lease fencing, then prove health and teardown. Graceful restart alone is insufficient evidence.
- Keep recovery artifacts redacted and durable enough for a fresh operator to resume the mission.

Why: the only reliable restart is one that can recover correct state after memory and graceful shutdown are both gone.
