# W-37 round 6 coder report

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

## Fixture lifecycle evidence

- `w37-fixture-child.ts` owns one validated correlation, private tmux socket,
  watcher process-group leader, and temp tree. Cleanup validates those exact
  targets, kills the group, calls `tmux -L <correlation> kill-server`, explicitly
  removes the socket path, and removes only its exact temp tree.
- The parent lock independently probes the watcher PID, socket, and temp tree
  after normal pass, forced assertion failure, a fired fixture deadline (124),
  actual SIGINT (130), and actual SIGTERM (143). All six tests pass, including
  the red lock that observes the old kill-server-only cleanup leave its socket.
- The existing real topology/process fixture now explicitly removes its exact
  socket on both synchronous signal cleanup and asynchronous `finally`.
- TypeScript, behavioral candidate check, delivery locks, lifecycle locks, and
  `git diff --check` pass. The topology and process locks still time out on this
  lane's loopback boundary; the full daemon suite was run and stopped after
  repeated unrelated loopback/time-out failures made completion non-decidable.

## Bounded historical residue inventory

Dry-run only; no historical target was deleted. At evidence time there were 32
socket paths under `/tmp/tmux-0`: 26 `w37-<pid>-<time>` paths from earlier
rounds and six `w37-lifecycle-*` paths created by the initial pre-fix/red run.
Two historical temp trees remained:
`/tmp/w37-process-boundary-0Mm1zB` and
`/tmp/w37-process-boundary-IU2lgt`. No correlated watcher process was present.

After review accepts the replacement lock, the orchestrator may remove one
socket only with an explicit literal correlation:

```sh
correlation='LITERAL_FROM_THE_INVENTORY'
socket="/tmp/tmux-$(id -u)/$correlation"
test "$(basename "$socket")" = "$correlation" &&
test -S "$socket" &&
tmux -L "$correlation" kill-server 2>/dev/null || true
test "$(dirname "$socket")" = "/tmp/tmux-$(id -u)" &&
test "$(basename "$socket")" = "$correlation" &&
rm -- "$socket"
```

The two temp trees have no recoverable correlation-to-process mapping and must
remain review-visible; they are not authorized for cleanup by this mission.

commit: recorded in the terminal report after commit creation
verify: cd daemon && bun install --frozen-lockfile && bunx tsc --noEmit && bun w37-red-before.ts && bun test w37-fixture-lifecycle.test.ts terminal-alert-delivery.test.ts && cd .. && git diff --check
result: NO-GO
blocker: topology/process and full daemon suite cannot complete on this loopback-denied lane; Tier A rereview remains mandatory
secret-scan: clean
remaining: Tier A rereview; rerun topology/process and full daemon suite on the orchestrator host; landing gate
