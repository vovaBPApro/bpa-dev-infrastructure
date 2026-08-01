# W-37 round 7 coder report

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

## Rework evidence

- Cleanup sends a signal only after exact correlation and process-group
  validation, awaits the exact spawned watcher, then independently polls until
  its PID no longer exists. Both waits are bounded. Timeout rejects before tmux,
  socket, or fixture-root cleanup, preserving evidence.
- Before any fixture creation, the child refuses an existing exact socket path
  or exact fixture temp root. Socket-only, root-only, and combined executable
  locks preserve bytes and inode, observe no watcher process, and use a tmux
  invocation shim to prove tmux was never called.
- The lifecycle suite ran 20 bounded iterations: all 180 tests passed, covering
  pass, assertion, deadline, SIGINT, SIGTERM, three ownership-refusal cases, and
  the retained socket-residue red lock.
- Against candidate `2edd4402fe76527011d189e9d862cf5d99e160bb`,
  the replacement lifecycle lock exited 1 with observable watcher PID residue.
  A direct old-child ownership probe also recorded a tmux invocation and removal
  of the pre-existing socket. Candidate behavior is red; this rework is green.
- Focused cleanup/delivery: 18 pass, 0 fail. TypeScript and the retained W-37
  production behavioral check pass. The combined topology/process battery
  retains its dispositioned loopback timeouts.
- Full daemon suite was attempted under `timeout 180s bun test` and exited 124.
  It retained the already-known loopback/runtime timeout class, including
  topology, watchdog turn-end, restart, and inbound-media integration cases.
  No failure pointed at the cleanup rework, but the full-suite result is not
  relabelled green.
- Historical W-37 inventory is unchanged: socket-name hash
  `01cd431a656fb709699c5deb1f618da2359e5dd0a69713bfb65ea7c52398234e`;
  temp-root-name hash
  `5dca888a45d458eda90c6931b7ef2a3936c34823b55cff0d9986403db51da78e`.
  No current-run correlated watcher remains.

commit: recorded in the terminal report after commit creation
verify: cd daemon && bun install --frozen-lockfile && bunx tsc --noEmit && bun w37-red-before.ts && bun test w37-fixture-lifecycle.test.ts terminal-alert-delivery.test.ts && cd .. && git diff --check
result: NO-GO
blocker: full daemon suite cannot complete on this loopback/runtime-constrained lane; independent Tier A rereview remains mandatory
secret-scan: clean
remaining: Tier A rereview and landing gate; rerun full daemon suite on the orchestrator host
