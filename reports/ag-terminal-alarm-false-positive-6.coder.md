# Coder terminal report: ag-terminal-alarm-false-positive-6

commit: fcb54de4dc43d590a421f4a5ead0935abf0493ac [CODER] authenticate terminal alert echo suppression
verify: bun test daemon/terminal-alert.test.ts && (cd daemon && bun install --frozen-lockfile && bunx tsc --noEmit) && git diff --check
verify-count: 33/0
result: NO-GO
blocker: orchestrator-core alert suppression requires independent review and landing evidence
secret-scan: clean
remaining: independent review and landing

## Change and regression evidence

Alerts now carry a crypto-random, injectable nonce. Only complete frames whose
nonce occurs in the bounded 256-entry, one-hour issued-nonce set are suppressed.
Legacy frames, incomplete frames, and unknown nonces remain ordinary terminal
text. Re-reading an issued frame remains suppressed.

FAIL-BEFORE at `190c47c0b404f9c9b0aa4c4cd56eab0836b7fae7` used the current tests in a
disposable detached worktree. Both required round-5 locks failed:

```text
(fail) REGRESSION round-5-forged-frame: a forged complete frame cannot hide a real failure
Expected: "exited"
Received: null
(fail) REGRESSION round-5-incomplete-legacy-frame: legacy shape cannot hide a real failure
Expected: "exited"
Received: null
```

PASS-AFTER at the implementation SHA exited 0:

```text
33 pass
0 fail
38 expect() calls
Ran 33 tests across 1 file.
```

TypeScript verification and `git diff --check` exited 0. The canonical secret
scan over `origin/main...HEAD` emitted no matches.

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
