# W-16 count provenance coder report

commit: 434149fc1a4b57f717b37b799a41ff3dfc03cf37 [CODER] reject unverified prose count claims
verify: bun test gate/completion-guard.test.ts && gate/land.test.sh && gate/land-batch.test.sh && gate/land-batch-hardening.test.sh && (cd daemon && bun run typecheck) && git diff --check origin/main...HEAD
verify-count: 14/0
result: NO-GO
blocker: Tier A fix requires independent re-review at 434149fc1a4b57f717b37b799a41ff3dfc03cf37; the existing REJECT reviews the superseded SHA 9add65e42c8bd3ade448aa39bfe53cc1c55e535a
secret-scan: clean
remaining: independent re-review and landing; unrelated fresh-clone dispatch-check remains owned by ag-ci-dispatch-gate

## Regression lock

FAIL-BEFORE command, run with only the new prose regression test added to the
reviewed implementation:

```sh
bun test gate/completion-guard.test.ts
```

Real output excerpt:

```text
Expected: 2
Received: 0
(fail) completion guard > rejects a prose count outside the provenance-checked field
FAIL_BEFORE_STATUS=1
```

PASS-AFTER command, run after the implementation change:

```sh
bun test gate/completion-guard.test.ts
```

Real output excerpt:

```text
(pass) completion guard > rejects a prose count outside the provenance-checked field
Ran 14 tests across 1 file.
PASS_AFTER_STATUS=0
```

The full quoted `verify:` command then exited 0 at the implementation SHA. Its
shell-suite markers were:

```text
land tests: pass
land batch tests: pass
land batch hardening tests: pass
$ bunx tsc --noEmit
```

The canonical diff secret scan emitted `secret-scan: clean`. `git status
--short` before the implementation commit named only the two intended guard
files; after that commit it was empty.

## External exclusion

The fresh-clone `dispatch-check` CI failure is excluded exactly as directed. It
is unrelated to this diff and belongs to `ag-ci-dispatch-gate`; it was not
chased or included in W-16 verification.

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
reproducible-from-git 822d9efe694b — Reproducible From Git
```
