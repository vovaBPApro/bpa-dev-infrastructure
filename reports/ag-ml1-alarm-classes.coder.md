# Coder terminal report: ag-ml1-alarm-classes

commit: ec90b0ecadcbcaea69722223150920dc1546acdb `[CODER] route terminal alarms internally fail closed`

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

## FAIL-BEFORE

Command:

```sh
cd daemon && bun test notify-handler.test.ts
```

Exit 1:

```text
error: Cannot find module './notify-handler' from '.../daemon/notify-handler.test.ts'
0 pass
1 fail
1 error
Ran 1 test across 1 file. [13.00ms]
```

Command:

```sh
cd orchestrator && ORCH_SKIP_TRUST_CHECK=1 ./runtime.test.sh
```

Exit 1:

```text
started: test-orch (codex)
session already exists: test-orch
started: test-orch (codex)
FAIL: unexpected success: .../orchestrator/launch.sh start
```

## PASS-AFTER

Command:

```sh
cd daemon && bun test notify-handler.test.ts terminal-alert.test.ts && bunx tsc --noEmit
```

Exit 0:

```text
15 pass
0 fail
22 expect() calls
Ran 15 tests across 2 files. [56.00ms]
```

Command:

```sh
cd orchestrator && ORCH_SKIP_TRUST_CHECK=1 ./runtime.test.sh
```

Exit 0 (terminal lines):

```text
ERROR terminal-alert-pipe-detached session=test-orch
runtime tests: PASS
```

The error line is the asserted fail-closed fixture: launch rejects the detached
classifier and kills its session. `ORCH_SKIP_TRUST_CHECK=1` isolates this
checkout's unrelated local Codex trust configuration, as in the independent
review.

## Scope and exclusions

The known fresh-clone `dispatch-check` CI failure is external and owned by
`ag-ci-dispatch-gate`; it was not investigated or changed.

verify: `(cd daemon && bun test notify-handler.test.ts terminal-alert.test.ts && bunx tsc --noEmit) && (cd orchestrator && ORCH_SKIP_TRUST_CHECK=1 ./runtime.test.sh)`

result: clean

secret-scan: clean

remaining: independent re-review and landing evidence required for Tier A
