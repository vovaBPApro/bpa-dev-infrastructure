# Telegram daemon migration plan

## Decision

Use a staged parallel stand. Keep the existing TypeScript/Bun daemon as the
reference relay until the new contour proves equivalent acceptance evidence;
do not blindly copy it into the Python runtime.

## Options

- **Faithful Bun port:** preserves `templates/daemon/server.ts`, `relay.ts`,
  `reliability.ts` semantics and tests, but introduces a second runtime and
  package/lockfile gate.
- **Python adaptation:** reuses contour lifecycle/lease primitives, but risks
  semantic drift in reconnect, offsets, and delivery deduplication.

## Stages

1. Inventory and freeze the Bun reference SHA (`4cdf3c70`).
2. Build an isolated Bun stand with its original tests and health endpoint.
3. Add contract tests shared with contour (lease fencing, event dedupe,
   reconnect replay, provenance and rollback).
4. Run both stands in parallel; compare signed evidence for four-hour soak.
5. Cut over only after parity, rollback proof, and Human approval for the
   irreversible production set.

No active data or legacy worktrees are moved by this plan.

The exact pre-coding, stand, parity and cutover gates are recorded in
[`BUN_PARALLEL_STAND_ACCEPTANCE.md`](BUN_PARALLEL_STAND_ACCEPTANCE.md).
