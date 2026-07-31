# Coder terminal report: ag-ml1-alarm-classes

commit: 62ed9beb1db2bcf8cb51dd813524e3ad85664a2b [CODER] preserve unknown and external terminal alarms
verify: (cd daemon && bun test notify-handler.test.ts terminal-alert.test.ts && bun run typecheck) && (cd orchestrator && ORCH_SKIP_TRUST_CHECK=1 ./runtime.test.sh) && git diff --check origin/main...HEAD
verify-count: 18/0
result: NO-GO
blocker: Tier A orchestrator-core change requires independent re-review of the current coder SHA
secret-scan: clean
remaining: independent re-review and landing evidence

## Closed REJECT blockers

- Failure-looking terminal lines which match no declared pattern now route as
  `unknown`; ordinary output remains ignored.
- Audience classification is explicit, and the historical external `/notify`
  path is locked through the real HTTP handler and Human sender boundary.

## FAIL-BEFORE

The changed lock files were copied unchanged into a disposable detached
worktree at pre-fix SHA `6a463b6`, then each named lock was executed.

Unknown terminal failure, exit 1:

```text
Expected: "unknown"
Received: null
(fail) REGRESSION ML-1: an unclassified terminal failure remains actionable
0 pass
1 fail
```

External routing boundary, exit 1:

```text
SyntaxError: Export named 'classifyNotifyAudience' not found
0 pass
1 fail
1 error
```

## PASS-AFTER

The `verify:` command above exited 0 at the implementation SHA. Exact Bun
summary:

```text
18 pass
0 fail
29 expect() calls
Ran 18 tests across 2 files.
$ bunx tsc --noEmit
runtime tests: PASS
```

The runtime output's two `ERROR terminal-alert-not-ready` lines are asserted
negative fixtures; the script ended with `runtime tests: PASS` and exit 0.

## Consumption check

- lane-lifecycle sha256:84d3db25d785 — Lane Lifecycle
- verification-and-locks sha256:b13ed13070c1 — Verification and Regression Locks
- tool-permissions sha256:6c7b9f57fbbd — Tool Permissions
- repository-hygiene sha256:8b21c6129e5c — Repository Hygiene
- isolated-test-environments sha256:d0c2162eeba5 — Isolated Test Environments
- operator-feedback sha256:82d309b667eb — Operator Feedback
- instruction-layers sha256:f9a51936be92 — Instruction Layers
- branching-policy sha256:dbe7ace1193b — Branching Policy
- reproducible-from-git sha256:822d9efe694b — Reproducible From Git
