# W-19 credential rotation runbook — coder report

## Consumption check

- lane-lifecycle sha256:84d3db25d785 — Lane Lifecycle
- verification-and-locks sha256:b13ed13070c1 — Verification and Regression Locks
- tool-permissions sha256:955630cc416e — Tool Permissions
- repository-hygiene sha256:02acdffe2a56 — Repository Hygiene
- isolated-test-environments sha256:6ffd35d7c9f1 — Isolated Test Environments
- operator-feedback sha256:f2af762572ae — Operator Feedback
- instruction-layers sha256:cd21f4ce0990 — Instruction Layers
- branching-policy sha256:98cd92116325 — Branching Policy
- reproducible-from-git sha256:822d9efe694b — Reproducible From Git

## Evidence

- Rebased onto `origin/main` before inspection; branch was already current.
- Inventory source: W-19 and its creating commit, current no-value host paths,
  and provider identity records. Exact Telegram timestamps were unavailable
  because the operator-directed purge removed the raw messages.
- `bun test`: exit 0 on the rebased tree with the runbook present.
- Canonical diff secret scan: run before and after commit; no output expected.
- Exact-value disk scan: `NO-GO`. The current QuickBooks and Google OAuth client
  secrets survive in one Claude project session-history JSONL file named in the
  runbook. Values were never printed into evidence.
- Rotation performed: no.

## Terminal contract

Commit SHA is filled by the commit itself and reported from `git rev-parse HEAD`.
Verification command: `bun test`.
Result: `NO-GO` — undeclared cleartext session-history survivor; bounded next
action is audited removal of that exact host file followed by the same
whole-host exact-value scan. The declared runtime stores also remain cleartext
mode-`0600` files pending a separate secret-store design.
