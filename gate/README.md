# Completion guard

Machine gate for lane terminal reports. It closes the forged/false-green and
stale-status failure modes in `migration-prep/problem-matrix.md`, including the
HR-07 fail-closed evidence invariant and HR-13 machine-readable completion
guard requirement.

```sh
bun gate/completion-guard.ts --report /path/to/report.md --repo /path/to/repo --branch ag-lane --run-verify
```

`--branch` requires the reported commit to be reachable from that branch. When
that branch is checked out, the guard also rejects tracked uncommitted changes.
`--run-verify` executes the report's `verify:` command in the supplied repo and
requires it to exit successfully.

Exit codes: `0` = pass; `2` = contract violation; `3` = valid report declaring
`NO-GO` (`no-go-declared`). The final output is always `GUARD verdict=pass`,
`GUARD verdict=violation`, or `GUARD verdict=no-go`.

Run the test suite with:

```sh
bun test gate/completion-guard.test.ts
```

## Landing a lane

`land.sh` makes the completion guard, range secret scan, no-ff merge, optional
post-merge verification, push, and branch/worktree reap one fail-closed command:

```sh
gate/land.sh --branch ag-lane --report /path/to/report.md --repo /path/to/repo --worktree /path/to/lane --run-verify
```

Use `--no-push` for a local landing. Every stage emits a `LAND step=` record;
the final line is a `LAND verdict=landed` or `LAND verdict=aborted` record.
Run its fixture suite with `gate/land.test.sh`.

The reap stage is remote-inclusive and fail-closed: it deletes the local lane
branch, deletes `refs/heads/<branch>` on origin, and reports `status=pass` only
after `git ls-remote origin refs/heads/<branch>` confirms the ref is absent
(a lane that never existed on origin passes with an explicit `remote=absent`
record). If the remote delete fails, cannot be verified, or is refused
(`--no-push` never deletes a present origin ref because origin/main lacks the
merge), the stage reports `status=local-only` and a `landed-*reap-failed`
verdict — never `pass`.
