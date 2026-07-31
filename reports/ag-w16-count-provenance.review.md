# Independent review: W-16 count provenance

verdict: ACCEPT
reviewed-sha: 0bd7f04154ca5749d356d6dd4174b9b56b079705
reviewer: Codex reviewer lane `ag-w16-count-provenance`
independence: independent reviewer session; reviewer did not author the implementation
tier: Tier A — landing/evidence-gate behavior
base: origin/main at fd8ac29c

## Manifest consumption

```text
review-policy sha256:b95d6eb6d0e5 — Review Policy
verification-and-locks sha256:b13ed13070c1 — Verification and Regression Locks
roles sha256:cd4c40c4e640 — Roles
instruction-layers sha256:f9a51936be92 — Instruction Layers
tool-permissions sha256:6c7b9f57fbbd — Tool Permissions
reproducible-from-git sha256:822d9efe694b — Reproducible From Git
```

## Verdict

ACCEPT. The prior fail-open prose-count finding is closed. The reviewed guard
rejects reported counts outside `verify-count`, re-runs `verify:` at the reported
SHA, compares a structured claim with the command's own unambiguous pass/fail
output, and treats mismatch or indeterminate output as a contract violation.
The landing path repeats the count comparison after merge and rolls back on a
mismatch. No blocking scope, secret-exposure, rollback, or false-green finding
remains.

## Independent acceptance probes

I created a disposable one-commit repository and ran the current completion
guard against three reports. Each report named the exact fixture SHA.

False claim (`verify-count: 999/0`; command output `2 pass`, `0 fail`):

```text
PASS verify-run tail=2 pass | 0 fail
FAIL verify-count mismatch report=999/0 actual=2/0
GUARD verdict=violation
status=2
```

Honest claim (`verify-count: 2/0`; same command output):

```text
PASS verify-run tail=2 pass | 0 fail
PASS verify-count 2/0
GUARD verdict=pass
status=0
```

Indeterminate actual count (`verify-count: 2/0`; command output only
`tests succeeded`):

```text
PASS verify-run tail=tests succeeded
FAIL verify-count command-output-missing-unambiguous-pass/fail-count
GUARD verdict=violation
status=2
```

Combined probe assertion:

```text
PROBE_STATUS false=2 honest=0 unknown=2
```

This directly proves mismatch rejection, continued usability for honest reports,
and fail-closed behavior when the real count cannot be derived.

## Regression-lock provenance

For red-before, I created a detached worktree at the previously rejected
implementation commit `40c02e6`, applied only the new prose-count test from
`dcb955b`, and ran:

```sh
bun test gate/completion-guard.test.ts
```

Observed:

```text
Expected: 2
Received: 0
(fail) completion guard > rejects a prose count outside the provenance-checked field
13 pass
1 fail
RED_BEFORE_STATUS=1
```

At the reviewed SHA the same suite produced:

```text
14 pass
0 fail
29 expect() calls
```

## Full verification at reviewed SHA

```sh
bun test gate/completion-guard.test.ts && gate/land.test.sh && gate/land-batch.test.sh && gate/land-batch-hardening.test.sh && (cd daemon && bun run typecheck) && git diff --check origin/main...HEAD
```

Result: exit 0. Relevant terminal markers were:

```text
14 pass
0 fail
land tests: pass
land batch tests: pass
land batch hardening tests: pass
$ bunx tsc --noEmit
```

The landing integration lock constructs a false `168/168` report whose verify
command emits `162 pass` and `6 fail`; it asserts rejection, rollback to the
pre-merge SHA, retention of the lane branch, and absence of a successful push.

## Scope and rollback

The diff is limited to the completion/landing gate, its tests and documentation,
and W-16 evidence reports. The behavior is configuration-free and introduces no
data migration. Reverting the gate commits restores the prior behavior; on a
post-merge verification mismatch, `gate/land.sh` resets the local merge to
`ORIG_HEAD` before reporting failure.
