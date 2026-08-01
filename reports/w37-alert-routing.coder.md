# W-37 terminal-alert routing coder report

## Outcome

Terminal alerts are journaled in full, while the connected MCP session receives
only `terminal-alert: kind=<encoded-kind> nonce=<nonce> — details in daemon
journal`. With no MCP session, tmux receives that same inert pointer. When
neither route works, delivery still throws `orchestrator unavailable`.

## Regression evidence

- Red-before: with the former tmux-first/full-frame behavior restored locally,
  `bun test terminal-alert-delivery.test.ts` exited 1: MCP-preference and
  inert-paste locks failed.
- Green: `bun test terminal-alert-delivery.test.ts terminal-alert.test.ts`
  passed 55/55.
- `bun install --frozen-lockfile && bunx tsc --noEmit` exited 0.
- `git diff --check` exited 0.
- Full daemon suite is an in-lane NO-GO: loopback-dependent tests timed out
  (`notify-handler.test.ts` 3/3; the full run was stopped after four bounded
  `watchdog-turnend-a1.test.ts` timeouts). The host landing gate must re-run it.
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

commit: 1409cf6002fa0b1e5bb1beca570796d9a081ecd1 [CODER] route terminal alerts outside watched pane
verify: cd daemon && bun install --frozen-lockfile && bun test terminal-alert-delivery.test.ts terminal-alert.test.ts && bunx tsc --noEmit && cd .. && git diff --check
result: NO-GO
blocker: host full-daemon re-verification and independent Tier A review remain required
secret-scan: clean
remaining: host full daemon suite; independent Tier A review; landing gate
