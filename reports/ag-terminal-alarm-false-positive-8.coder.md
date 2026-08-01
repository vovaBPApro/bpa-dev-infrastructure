# Coder terminal report: ag-terminal-alarm-false-positive-8

commit: 2ad2311c6d65798c97f2d2485ab644204a06d3aa [CODER] tolerate terminal frame newline noise
verify: bun test daemon/terminal-alert.test.ts && (cd daemon && bun install --frozen-lockfile && bunx tsc --noEmit) && git diff --check
verify-count: 37/0
result: NO-GO
blocker: orchestrator-core alert suppression requires independent review and landing evidence
secret-scan: clean
remaining: independent review and landing

## Change and regression evidence

Frame recognition now accepts blank lines, CR-derived newline runs, and per-line
indentation between frame lines. The end marker still bounds the recognized
frame, while suppression still requires the canonical content hash of a live
issued nonce to match.

FAIL-BEFORE at `ac82fa553b6f4f98377096b4f2e9e00d95ea0aae`: the exact doubled-CR
reproducer returned `fatal` instead of `null`.

PASS-AFTER at the implementation SHA exited 0 with 37 passes, 0 failures, and
42 expectations. The exact doubled-CR lock and an interleaved blank-line and
indentation lock return `null`. Replay substitution still returns `exited`, and
an adjacent real failure after the end marker still returns `exited`.
TypeScript verification and `git diff --check` exited 0. The canonical secret
scan emitted no matches.

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
