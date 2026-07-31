# Deploy pipeline fourth attempt — coder terminal report

## Instruction consumption

- lane-lifecycle sha256:84d3db25d785 — Lane Lifecycle
- verification-and-locks sha256:b13ed13070c1 — Verification and Regression Locks
- tool-permissions sha256:955630cc416e — Tool Permissions
- repository-hygiene sha256:02acdffe2a56 — Repository Hygiene
- isolated-test-environments sha256:6ffd35d7c9f1 — Isolated Test Environments
- operator-feedback sha256:fc36fafe4623 — Operator Feedback
- instruction-layers sha256:cd21f4ce0990 — Instruction Layers
- branching-policy sha256:98cd92116325 — Branching Policy
- reproducible-from-git sha256:822d9efe694b — Reproducible From Git

## Acceptance evidence

`deploy/live-stand.test.sh` deliberately proves and prints named locks for:

- migration collision refusal before restart or activation;
- post-build repair of release and regenerated `dist` permissions;
- candidate startup failure followed by exact-SHA automatic rollback;
- delayed rollback startup without a false rollback-health alarm;
- readiness-only `/healthz` response causing an immediate, explicit contract-drift error and exact-SHA automatic rollback.

The fixture finishes with `current` resolving to the prior healthy release. The
deploy path does not modify auth enforcement, token-store ownership, startup
preflight, or the original unit.

## Verification

- `deploy/live-stand.test.sh` — exit 0
- `bun test` — exit 0
- canonical secret scan — recorded in the commit/report handoff

Result remains `NO-GO` until the required independent risky-path review and
landing evidence exist.
