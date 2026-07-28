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
