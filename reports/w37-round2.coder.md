# W-37 round 2 nonce-boundary coder report

## Outcome

Pointer formatting now renders a nonce only when it is a canonical UUID;
all other frame/factory nonce values render as the fixed `invalid-nonce`
placeholder. The original frame remains unchanged for journal-first delivery.

## Regression evidence

- Red-before at `1409cf6`: copy this commit's
  `daemon/terminal-alert-delivery.test.ts` into a detached `1409cf6` worktree,
  then run `cd daemon && bun install --frozen-lockfile && bun test
  terminal-alert-delivery.test.ts`. It exited 1 with 10 failures, including all
  four reviewer probes exposing their raw nonce in the pointer.
- Green: `cd daemon && bun install --frozen-lockfile && bun test
  terminal-alert-delivery.test.ts terminal-alert.test.ts && bunx tsc --noEmit`
  passed 64/64 tests, 11,055 assertions, and TypeScript.
- The lock checks both the frame parser and exported pointer formatter for every
  prefix, plain/quoted/TUI-chrome-wrapped and doubled-CR variants. A canonical
  UUID remains available for correlation.
- `timeout 60s bun test` exited 124 after three existing
  `watchdog-turnend-a1.test.ts` loopback/process waits timed out. Host gate must
  re-run the environment-sensitive full suite.
- Tier A independent review remains required before landing.

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

commit: pending [CODER] make W-37 alert nonce classifier-inert
verify: cd daemon && bun install --frozen-lockfile && bun test terminal-alert-delivery.test.ts terminal-alert.test.ts && bunx tsc --noEmit && cd .. && git diff --check
result: NO-GO
blocker: host full-daemon re-verification and independent Tier A review remain required
secret-scan: clean
remaining: host full daemon suite; independent Tier A review; landing gate
