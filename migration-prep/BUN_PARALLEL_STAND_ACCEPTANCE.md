# Bun daemon import and parallel-stand acceptance gates

This gate list is the handoff contract for importing the stable
`telegram-dev-daemon` runtime. It is a prerequisite to implementation and
prevents a Python contour from being called equivalent by assertion.

## Reference freeze

- Source repository: `vovaBPApro/telegram-dev-daemon`.
- Reference branch/SHA: `main@4cdf3c70c6ec9d28608d7921b4dd4dd31ce340aa`.
- Inventory must enumerate the daemon entrypoint, relay, reliability module,
  templates, instruction docs, and their test commands.
- Any source drift requires a new reference SHA and a recorded diff.

## Gates before coding

1. **Runtime/dependency gate:** decide faithful Bun/TypeScript import (the
   recommended path) versus a separately reviewed adaptation. Adding or
   changing manifests/lockfiles is a Human approval gate.
2. **Contract gate:** freeze Telegram offset/reconnect/deduplication,
   lease-fencing, mission rollup, provenance and rollback contracts as shared
   fail-closed tests.
3. **Stand gate:** define disposable per-lane Compose project name, network,
   worktree, ports and resource budget; no lane may share mutable state.

## Parallel Docker stand gates

Every lane must produce machine-readable evidence for build, start, health,
authenticated route, resource limits, bounded soak, teardown and clean restart.
The canonical integration stand additionally proves cross-lane event
deduplication and replay. A stand that lacks a required command is `NO-GO`.

## Parity and cutover gates

- Run the original Bun tests and the new stand's contract suite against the
  same replay fixtures.
- Execute both stands in parallel for four hours under the recorded CPU/RAM
  budget; compare signed evidence, not log volume.
- Demonstrate rollback to a pinned source SHA/image digest and verify the
  restored target from fresh provenance evidence.
- Independent reviewer records ACCEPT/REJECT. Any missing evidence, projection
  divergence, stale lease, duplicate delivery, secret exposure or resource
  breach blocks cutover.

## Current blockers

The new repository has no Bun/TypeScript harness or package manifest; adding
one requires the dependency/lockfile approval gate. Live authenticated health,
resource-limited soak, complete manifest and real rollback-target evidence are
not yet available. These are explicit `NO-GO` rows, not tasks to hand-wave
green.
