# Migration-poison deploy protection — coder terminal report

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

`deploy/live-stand.test.sh` creates a disposable PostgreSQL database from a
healthy live-schema fixture, applies the exact poisoned migration shape
(`realm_id`, missing `organization_id`, RLS not forced), and executes the
startup tenant-isolation assertion. The deploy refuses before release creation,
symlink activation, or service restart. A second lock proves migration deploys
announce rollback-unsafety and post-migration startup failure emits a concrete
fix-forward verdict without claiming code rollback can restore service.

## Verification

- `bun test deploy/live-stand.test.ts` — exit 0
- `git diff --check` — exit 0
- canonical secret scan — recorded in the commit handoff

Result is `NO-GO` pending mandatory independent Tier A review and landing.
