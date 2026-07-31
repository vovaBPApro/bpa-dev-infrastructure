# Coder terminal report: ag-ml1-alarm-classes

commit: 33277f91a231693985f8af2c2138602e6e5ca0b4 [CODER] require terminal classifier readiness
verify: (cd daemon && bun test notify-handler.test.ts terminal-alert.test.ts && bun run typecheck) && (cd orchestrator && ORCH_SKIP_TRUST_CHECK=1 ./runtime.test.sh) && git diff --check origin/main...HEAD
verify-count: 16/0
result: NO-GO
blocker: Tier A orchestrator-core change requires independent re-review at 33277f91a231693985f8af2c2138602e6e5ca0b4; the retained REJECT reviews a superseded SHA
secret-scan: clean
remaining: independent re-review and landing evidence

## Approach correction

The reviewer was correct. Sampling `#{pane_pipe}` for a short interval still
treated a transient tmux child as classifier readiness. The replacement uses an
affirmative ready-file handshake written by the real classifier process. Launch
kills the new session unless both the pipe and that handshake are present.

The other review blockers remain closed: `/notify` routes the internal audience
to the orchestrator without invoking the Human relay, and the real HTTP handler
tests the success and fail-closed paths.

## FAIL-BEFORE

The current lock files were copied into a disposable worktree at pre-fix commit
`76d6b05`, then executed unchanged.

Command:

```sh
cd daemon && bun test terminal-alert.test.ts
```

Exit status was non-zero. Real output excerpt:

```text
Expected: true
Received: false
at <anonymous> (.../daemon/terminal-alert.test.ts:76:35)
(fail) REGRESSION ML-1: classifier proves process readiness to its launcher [2017.10ms]
```

Command:

```sh
cd orchestrator && ORCH_SKIP_TRUST_CHECK=1 ./runtime.test.sh
```

Exit status was non-zero. Real terminal output:

```text
started: test-orch (codex)
FAIL: terminal alert pipe did not carry its readiness handshake path
```

## PASS-AFTER

The `verify:` command above was run at the reported implementation SHA and
exited successfully. Real output excerpts:

```text
(pass) internal /notify reaches the orchestrator and never the Human relay
(pass) internal /notify fails closed when orchestrator delivery fails
(pass) REGRESSION ML-1: classifier proves process readiness to its launcher
$ bunx tsc --noEmit
ERROR terminal-alert-not-ready session=test-orch
runtime tests: PASS
```

The error line is the asserted fail-closed fixture: launch rejects a pipe that
never proves classifier readiness and kills its session.

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
