# Coder terminal report: ag-terminal-alarm-false-positive-10

commit: 8b7c3ee3cfe9d208188f606e643d59b047644d63 [CODER] make terminal alert headers classifier-inert
verify: bun test daemon/terminal-alert.test.ts && (cd daemon && bun install --frozen-lockfile && bunx tsc --noEmit) && git diff --check
verify-count: 52/0
result: NO-GO
blocker: orchestrator-core alert suppression requires independent review and landing evidence
secret-scan: clean
remaining: independent review and landing

## Change and regression evidence

`formatTerminalAlert` now inserts a printable middle-dot separator after the
first character of every emitted kind. The issued-frame recognizer derives its
accepted encoded kinds through the same encoder, so suppression hashes and
frame recognition cover the new format without a raw classification signature
in the `Type:` header. This file has no consumer that parses `Type:` back into a
kind, so no decode boundary exists to update.

FAIL-BEFORE at `fee46d26c2b56e4f99cfa00330df95b63d1850b2` with the exhaustive
round-10 lock applied: the unsuppressed `429/overload` and `fatal` frames
classified as their raw header kinds instead of `null`; the updated format
expectation also failed.

PASS-AFTER at the implementation SHA exited 0 with 52 passes, 0 failures, and
1,283 expectations. For all nine kinds, the generated lock checks the complete
frame with an unknown nonce, every non-payload line, and every quoted prefix of
each such line. The round-9 live truncated-banner/nonce fixtures remain `null`.
All round 3-9 locks remain green. TypeScript verification and `git diff --check`
exited 0. The canonical secret scan emitted no matches.

Accepted residual: a TUI quote truncated inside a verbatim payload line can
still re-classify because payload is the real failure text. The named
`REGRESSION round-10-residual` lock asserts that behavior; payload remains
verbatim and unencoded.

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
