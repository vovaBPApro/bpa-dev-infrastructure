# Coder terminal report: ag-terminal-alarm-false-positive-7

commit: 802efd3c2784a98de8ac83ca82b1955892cb6956 [CODER] bind terminal echo nonce to frame content
verify: bun test daemon/terminal-alert.test.ts && (cd daemon && bun install --frozen-lockfile && bunx tsc --noEmit) && git diff --check
verify-count: 35/0
result: NO-GO
blocker: orchestrator-core alert suppression requires independent review and landing evidence
secret-scan: clean
remaining: independent review and landing

## Change and regression evidence

Issued nonces now retain the SHA-256 hash of their canonical emitted frame in
the bounded 256-entry, one-hour set. Suppression requires both a live nonce and
an equal frame hash; a matching nonce with changed payload, type, session, or
line order remains ordinary terminal text. Matching does not consume the entry.

FAIL-BEFORE at `734eb47a8c1ca070902a03d45b7aeeee3a6af2a1` with the two round-7
locks applied produced 0 passes and 2 failures: replay substitution returned
`null` instead of `exited`, while a CR/LF-, wrapping-, and whitespace-mangled
issued frame returned `fatal` instead of `null`.

PASS-AFTER at the implementation SHA exited 0 with 35 passes, 0 failures, and
40 expectations. The replay-substitution lock proves changed payload content
does not canonicalize equal; the mangled-frame lock proves realistic terminal
noise still suppresses. TypeScript verification and `git diff --check` exited
0. The canonical secret scan emitted no matches.

## Consumption check

- lane-lifecycle sha256:84d3db25d785 — Lane Lifecycle
- verification-and-locks sha256:b13ed13070c1 — Verification and Regression Locks
- tool-permissions sha256:955630cc416e — Tool Permissions
- repository-hygiene sha256:02acdffe2a56 — Repository Hygiene
- isolated-test-environments sha256:6ffd35d7c9f1 — Isolated Test Environments
- operator-feedback sha256:6dc6f5d4768f — Operator Feedback
- instruction-layers sha256:cd21f4ce0990 — Instruction Layers
- branching-policy sha256:98cd92116325 — Branching Policy
- reproducible-from-git sha256:822d9efe694b — Reproducible From Git
