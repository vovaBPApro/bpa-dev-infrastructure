# Deploy pipeline third attempt — coder evidence

The deploy path builds a detached release, reapplies readable/traversable modes
after the build, runs the configured disposable live-schema migration replay
before mutation, and accepts health only from `/healthz` at the expected SHA.
Candidate failure rolls back and waits for the previous exact SHA.

Verification: `bash deploy/live-stand.test.sh && bun test`.

The deploy fixture deliberately proves migration refusal without restart,
post-build repair of release and regenerated `dist` mode 0700, application
startup failure with exact-SHA rollback, and a rollback listener delay without
a false rollback alarm. The prior SHA remains healthy after both refused and
rolled-back candidates.

No auth enforcement, token-store ownership, or startup-preflight file changed.

## Manifest consumption

- lane-lifecycle sha256:84d3db25d785 — Lane Lifecycle
- verification-and-locks sha256:b13ed13070c1 — Verification and Regression Locks
- tool-permissions sha256:955630cc416e — Tool Permissions
- repository-hygiene sha256:02acdffe2a56 — Repository Hygiene
- isolated-test-environments sha256:6ffd35d7c9f1 — Isolated Test Environments
- operator-feedback sha256:fc36fafe4623 — Operator Feedback
- instruction-layers sha256:cd21f4ce0990 — Instruction Layers
- branching-policy sha256:98cd92116325 — Branching Policy
- reproducible-from-git sha256:822d9efe694b — Reproducible From Git
