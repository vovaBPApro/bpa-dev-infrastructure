# W-37 round 4 coder report

## Manifest consumption

- lane-lifecycle sha256:84d3db25d785 — Lane Lifecycle
- verification-and-locks sha256:b13ed13070c1 — Verification and Regression Locks
- tool-permissions sha256:955630cc416e — Tool Permissions
- repository-hygiene sha256:02acdffe2a56 — Repository Hygiene
- isolated-test-environments sha256:6ffd35d7c9f1 — Isolated Test Environments
- operator-feedback sha256:6dc6f5d4768f — Operator Feedback
- instruction-layers sha256:cd21f4ce0990 — Instruction Layers
- branching-policy sha256:98cd92116325 — Branching Policy
- reproducible-from-git sha256:822d9efe694b — Reproducible From Git

## Evidence

- Acceptance now requires the write return value to be known, a successful
  callback, and an observed `drain` whenever `write()` returns `false`.
- The scheduled acceptance re-checks all three predicates. A `drain` listener
  is installed before `write()` so a conforming synchronous sink cannot race
  listener registration.
- Deterministic regression locks cover a synchronous callback followed by
  `false`, both without `drain` (timeout) and with `drain` (success).
- Red-before: the no-drain lock fails at
  `f2ba5897e2af4727a99d3efbe6d2c2bbd817f467` because the promise resolves;
  targeted candidate tests pass 59/59. TypeScript, behavioral red-before, and
  `git diff --check` exit 0.
- Full daemon and production/process batteries are NO-GO in this lane: loopback
  topology/process, watchdog, restart, and media integration tests time out or
  receive `ConnectionRefused`. No live daemon/session/watcher was touched.

commit: recorded in the terminal report after commit creation
verify: cd daemon && bun install --frozen-lockfile && bun test terminal-alert-delivery.test.ts terminal-alert.test.ts && bunx tsc --noEmit && bun w37-red-before.ts && cd .. && git diff --check
result: NO-GO
blocker: current-SHA full daemon and production/process evidence cannot complete in this lane
secret-scan: clean
remaining: Tier A rereview; rerun topology/process and full daemon suite on the orchestrator host; landing gate
