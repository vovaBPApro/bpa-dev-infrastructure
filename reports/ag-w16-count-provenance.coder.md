# W-16 count provenance coder report

commit: d586a817baf70a6afcc8459a32830198fd1411bc [CODER] derive reported test counts from verify output
verify: bun test gate/completion-guard.test.ts && gate/land.test.sh && gate/land-batch.test.sh && gate/land-batch-hardening.test.sh && (cd daemon && bun run typecheck) && git diff --check origin/main...HEAD
verify-count: 13/0
result: NO-GO
blocker: required independent review artifact is absent; no review verdict exists under this worktree's `reports/` or another W-16 review worktree
secret-scan: clean
remaining: independent review and landing

## Regression lock

Fail-before was reproduced against `origin/main` (`62eb1717`) with the new
completion-guard regression test applied without the implementation:

```text
red-exit=1
Expected: 2
Received: 0
(fail) completion guard > rejects a claimed count that disagrees with the verify command output
0 pass
1 fail
```

Pass-after was reproduced at `d586a817baf70a6afcc8459a32830198fd1411bc`:

```text
(pass) completion guard > rejects a claimed count that disagrees with the verify command output
13 pass
0 fail
land tests: pass
land batch tests: pass
land batch hardening tests: pass
```

The complete quoted `verify:` command exited 0. The reported count is the exact
machine-emitted count from the Bun suite; the shell suites do not emit numeric
counts and are reported only by their pass markers.

## Typecheck and unrelated CI exclusion

The main-branch fix `b096cb5f` is present after rebase. The required daemon
typecheck now exits 0:

```text
$ bunx tsc --noEmit
```

The repository-wide CI `dispatch-check` failure is excluded exactly as directed:
it concerns fresh-clone pack validation, is unrelated to this diff, and belongs
to lane `ag-ci-dispatch-gate`. It was not run and is not a W-16 blocker.

## Manifest consumption

```text
lane-lifecycle 84d3db25d785 — Lane Lifecycle
verification-and-locks b13ed13070c1 — Verification and Regression Locks
tool-permissions 6c7b9f57fbbd — Tool Permissions
repository-hygiene 8b21c6129e5c — Repository Hygiene
isolated-test-environments d0c2162eeba5 — Isolated Test Environments
operator-feedback 82d309b667eb — Operator Feedback
instruction-layers f9a51936be92 — Instruction Layers
branching-policy dbe7ace1193b — Branching Policy
```
