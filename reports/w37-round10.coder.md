# W-37 round 10 coder report

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

- Implementation: `ea30c7f7a09d969058a4935f4029557fc42f33de`.
- The first owned acquisition (`mkdirSync(fixtureRoot)`) is immediately followed
  by the single bounded `try/finally` cleanup path. Root and socket deletion are
  separately gated by exact acquisition flags.
- Cleanup validates the watcher correlation and process group independently of
  the injected `ps` boundary, kills only that exact group, awaits the spawned
  child, polls the exact PID to absence, and only then removes the exact socket
  and root.
- New executable locks cover watcher-validation refusal, later startup failure,
  and bounded `ps` failure. Each captures the watcher PID before failure, awaits
  fixture exit, then independently proves PID, socket, root, and correlated
  process absence.
- Lifecycle soak: 20/20 iterations, 240/240 tests, 0 failures. It retains pass,
  assertion, deadline, SIGINT, SIGTERM, pre-existing socket/root/both refusal,
  and retained-residue coverage.
- TypeScript: `bunx tsc --noEmit`, exit 0 after the declared frozen install.
  Production behavioral lock: `bun w37-red-before.ts`, exit 0.
- Exact-base behavioral red at
  `019180f52417f64c07358466105ca5ae91dc9480`: a bounded `ps` failure exited 1
  while watcher PID `1247590` and the private socket remained present. The probe
  then removed only that correlation; PID/socket/root were independently absent.
- Full daemon suite was executed with `timeout 240s bun test`; it exited 124 on
  the already dispositioned host/loopback timeout class (topology, watchdog,
  restart, and inbound-media boundaries). The changed lifecycle file itself was
  12/12 green in that run. This is not relabelled clean.
- Post-run correlated watcher inventory is empty. Historical socket inventory
  remains six names with hash
  `c0a915b81b771e21f9dcb5ca62e036266e0900661279e0a05a47f7a585edc2ff`;
  historical root inventory is empty with hash
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- `git diff --check` passed. Canonical diff secret scan passed.

commit: ea30c7f7a09d969058a4935f4029557fc42f33de [CODER] close W-37 startup cleanup boundary
verify: cd daemon && bun install --frozen-lockfile && bunx tsc --noEmit && bun w37-red-before.ts && bun test w37-fixture-lifecycle.test.ts
result: NO-GO
blocker: full daemon suite is red on dispositioned host/loopback timeouts; fresh cumulative Tier-A review against the remote baseline remains mandatory
secret-scan: clean
remaining: fresh cumulative Tier-A review, host full-suite corroboration, and landing gate
