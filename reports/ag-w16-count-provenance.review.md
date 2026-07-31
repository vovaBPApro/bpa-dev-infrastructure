# Independent review: W-16 count provenance

verdict: REJECT
reviewed-sha: 9add65e42c8bd3ade448aa39bfe53cc1c55e535a
reviewer: Codex reviewer lane `ag-w16-count-provenance`
independence: independent session; reviewer did not author the branch
tier: Tier A — landing/evidence-gate behavior
base: origin/main at 62eb1717

## Manifest consumption

```text
review-policy b95d6eb6d0e5 — Review Policy
verification-and-locks b13ed13070c1 — Verification and Regression Locks
roles cd4c40c4e640 — Roles
instruction-layers f9a51936be92 — Instruction Layers
tool-permissions 6c7b9f57fbbd — Tool Permissions
```

## Finding

1. **Blocker — count provenance remains fail-open for ordinary prose count
   claims** (`gate/completion-guard.ts:93`, `gate/completion-guard.ts:210`).
   `hasUnstructuredCountClaim` recognizes only slash-separated claims, while
   `verify-count` is optional. A report can claim `999 tests passed, 0 failed`
   outside `verify-count`, run a command that emits `2 pass` and `0 fail`, and
   receive `GUARD verdict=pass`. The branch's own coder report also contains
   prose `13 pass` / `0 fail` claims outside the checked field. Thus `[CODER]
   derive reported test counts from verify output` overclaims the implemented
   behavior. Make count claims structurally mandatory or reject all supported
   unstructured forms, and add a regression case for prose output.

No secret exposure or out-of-scope path was found. The changed paths are
confined to gate implementation/tests/docs and the lane report.

## Commands and observed output

### Green at reviewed SHA

```sh
bun test gate/completion-guard.test.ts && gate/land.test.sh && gate/land-batch.test.sh && gate/land-batch-hardening.test.sh && (cd daemon && bun run typecheck) && git diff --check origin/main...HEAD
```

```text
13 pass
0 fail
26 expect() calls
Ran 13 tests across 1 file.
land tests: pass
land batch tests: pass
land batch hardening tests: pass
$ bunx tsc --noEmit
exit=0
```

### Red-before lock proof

In a detached `origin/main` worktree, I applied only the diffs for
`gate/completion-guard.test.ts` and `gate/land.test.sh`, then ran:

```sh
bun test gate/completion-guard.test.ts
gate/land.test.sh
```

```text
Expected: 2
Received: 0
(fail) completion guard > rejects a claimed count that disagrees with the verify command output
9 pass
4 fail
RED_BEFORE completion_status=1 land_status=1
```

The supplied slash-form regression lock genuinely bites, but it does not cover
the fail-open prose form in the finding.

### Fail-open probe

I created a disposable one-commit repository and a clean report containing
`verify: printf '2 pass\n0 fail\n'` and
`remaining: claimed 999 tests passed, 0 failed`, then ran:

```sh
bun gate/completion-guard.ts --report "$probe_root/report.md" --repo "$probe_root" --run-verify
```

```text
PASS report-shape
PASS commit-exists 4db258faa9ddfd38840e5a79b09f390e4e4bc9c6
PASS result clean
PASS secret-scan clean
PASS verify present
PASS verify-run tail=2 pass | 0 fail
GUARD verdict=pass
FAIL_OPEN_PROBE status=0
```

### Diff and scope

```sh
git diff --check origin/main...HEAD
git diff --name-status origin/main...HEAD
```

`git diff --check` exited 0. Name-status showed only `gate/README.md`, the
completion/landing gate implementation and tests, and the coder report.

## Rollback posture

The changes are gate-only and can be reverted without data migration, but the
fail-open permits false confidence at the landing boundary. Landing is blocked
until the finding is fixed and independently re-reviewed.
