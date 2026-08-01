# W-37 round 5 coder report

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

- A drain observed inside `write()` is explicitly rejected and the one-shot
  listener is re-armed before control returns to the sink. A false return now
  requires callback success and a subsequent drain.
- Deterministic locks cover a pre-return drain with no later drain (timeout)
  and with a later drain (success only after that event). The delivery battery
  passes 9/9 with listener cleanup assertions.
- The process fixture launches its watcher as an exact, correlation-validated
  process-group leader. Normal/failure/timeout cleanup reaps that group, its
  private tmux socket, and its temp tree. SIGINT/SIGTERM handlers run the same
  synchronous cleanup before exit; an executable ordering lock covers both.
- The real process lock intentionally timed out on this lane's unavailable
  loopback boundary. Its new failure cleanup completed with no current-run
  watcher PID, socket, or temp residue. The topology lock likewise timed out.
- TypeScript, candidate behavioral check, targeted delivery tests, and
  `git diff --check` exit 0. The behavioral script exits 1 against base
  `59631869a51923d5bc41bcbe483cab5ca1f9dcf2` on the legacy tmux edge.

commit: recorded in the terminal report after commit creation
verify: cd daemon && bun install --frozen-lockfile && bunx tsc --noEmit && bun w37-red-before.ts && bun test terminal-alert-delivery.test.ts && cd .. && git diff --check
result: NO-GO
blocker: current-SHA topology/process and full daemon runtime evidence cannot complete in this loopback-denied lane
secret-scan: clean
remaining: Tier A rereview; rerun topology/process and full daemon suite on the orchestrator host; landing gate
