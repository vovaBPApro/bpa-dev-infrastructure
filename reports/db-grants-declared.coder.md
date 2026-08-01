# W-27 coder report

Consumption check:

- lane-lifecycle sha256:84d3db25d785 — Lane Lifecycle
- verification-and-locks sha256:b13ed13070c1 — Verification and Regression Locks
- tool-permissions sha256:955630cc416e — Tool Permissions
- repository-hygiene sha256:02acdffe2a56 — Repository Hygiene
- isolated-test-environments sha256:6ffd35d7c9f1 — Isolated Test Environments
- operator-feedback sha256:fc36fafe4623 — Operator Feedback
- instruction-layers sha256:cd21f4ce0990 — Instruction Layers
- branching-policy sha256:98cd92116325 — Branching Policy
- reproducible-from-git sha256:822d9efe694b — Reproducible From Git

The tracked declaration covers the `agentic` role attributes, database and
schema ownership, and `USAGE, CREATE` on schema `public`. The scheduled checker
is read-only and fails loudly on any difference. Its disposable PostgreSQL lock
proves missing initial state and revoked `CREATE` fail before reconciliation,
then pass after explicit reconciliation.

Root cause: not established. Repository history contains no GRANT or REVOKE
capable of explaining the removal. No live database permission was changed.

Terminal evidence is completed after the final commit so the SHA and commands
refer to the exact verified tree.
