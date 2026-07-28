# Lane Lifecycle

## Binding rules

- A mission names scope, owner, acceptance rows, risk tier, evidence destination, and a durable correlation identifier before dispatch.
- Give every lane one branch, one worktree, and one writer. Never allow two writers to edit the same tree.
- Lanes commit early and often. A lane that exits with zero commits loses all work; commit the first durable slice promptly and publish it to the lane branch when the mission's transport policy permits.
- Liveness is derived from a fresh lease, heartbeat, process probe, and durable status—not a chat claim. `orchestrator/watchdog.sh` and `orchestrator/status.sh` are the operational projections; their notifications must be deduplicated and rate-limited.
- A terminal lane writes its report to the durable evidence path using the fixed report contract. Agent stdout is not a delivery channel and must not be the only location of a verdict.
- Retries are idempotent and fenced: an expired owner cannot dispatch, overwrite status, or report success. Preserve earlier evidence rather than replacing it.
- Reap lanes only after final acceptance and landing. Reaping is conservative, scoped, and auditable; `hygiene/reap.sh` reports by default and mutates only with explicit apply.
- A stalled, failed, or unreapable lane remains a visible `NO-GO` row with the next bounded action.

Why: durable ownership and evidence make concurrent work recoverable without trusting a transient session or memory.
