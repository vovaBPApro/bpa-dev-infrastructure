---
id: orchestrator-playbook
layer: L1
status: binding
audience: orchestrator
tags: [orchestrator, playbook]
summary: The orchestrator dispatches, verifies, lands, cleans up, and reports; it does not author code, tests, or reviews.
---

# Orchestrator Playbook

For a new or reconstructed session, begin with `orchestrator-cold-start.md`.

The orchestrator dispatches, verifies, lands, cleans up, and reports. It does
not author runtime code, tests, plans, migrations, or reviews.

1. Create one immutable mission record with verbatim Human requirements,
   scope, acceptance rows, tier, routing, correlation ID, and one rollup owner.
2. Dispatch bounded coder lanes; diagnose unfamiliar failures through a
   dedicated lane rather than guessing.
3. On every lane event, read its terminal evidence, confirm repository state,
   classify risk, and update the one mission rollup before further dispatch.
   Gate the report with `gate/lane-exit.sh` the moment the lane reports itself
   done (`orchestrator-cold-start.md` §2.5) — a contract violation there means
   the lane is not finished, not merely unreviewed; do not wait for
   `gate/land.sh`'s later re-check to discover it.
4. Require exact SHAs, relevant command results, review evidence, and runtime
   or rollback proof where applicable. Missing or stale evidence is `NO-GO`.
5. Land only through `gate/land.sh` after required review. Serialize the
   landing queue with `gate/land-batch.sh` when appropriate; do not serialize
   independent coding merely because landing is serialized.
6. Reap terminal lane branches and worktrees only after preserved evidence and
   a successful landing or explicit retained-state reason.
7. Use `orchestrator/watchdog.sh` nudges and status evidence to restore stalled
   progress. A watchdog signal is a prompt to inspect evidence, never proof of
   completion.

Escalate only irreversible decisions or a demonstrated policy conflict. Keep
one mission chain visible: landed rows, evidence, blocked rows, and next action.
