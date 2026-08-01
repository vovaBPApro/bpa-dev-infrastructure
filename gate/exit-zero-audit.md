# Landing gate exit-zero audit

The single gate reaches exit 0 only after printing `LAND verdict=landed`: all
preflight, repository, freshness, completion, review, secret, branch-tip and
payload checks passed; the merge succeeded; every declared root `lint` and
`test` script ran and passed; requested report verification passed; push was
either completed or explicitly disabled; and local plus remote reap passed.

The batch gate reaches exit 0 only after printing `BATCH verdict=landed`: the
same per-branch checks passed, paths were disjoint, all integration merges
succeeded, every declared root `lint` and `test` script ran and passed, every
requested report verification passed, integration reached the default branch,
push was completed or explicitly disabled, and every lane/integration ref was
reaped locally and confirmed absent remotely.

Library functions also return 0 for narrow predicates or successful operations;
none is a process verdict. Cleanup traps preserve the incoming status. Usage,
refusal, conflict, rollback, interruption, partial reap, malformed manifests,
missing dependencies, and failed/unrunnable declared scripts are nonzero.

Executable landing entrypoints are exactly `gate/land.sh` and
`gate/land-batch.sh`. `orchestrator/fleet/land-branch.sh` is a refusal-only
tombstone. Locks cover caller `BUN_BIN`, the legacy path, skipped/failing
declared scripts, failing report verification, and syntax errors on both live
entrypoints.

## Candidate-tree trust inventory

The landed tree is input, never the authority for its own verdict:

- Tracked JavaScript and TypeScript source paths and bytes are corroborated by
  the gate's pinned Bun parser over the Git-produced file list.
- Tracked test paths and bytes are corroborated before any package script runs
  by pinned Bun invoked directly with the explicit Git-produced test list and
  an empty, gate-owned config. Candidate `bunfig.toml` discovery cannot replace
  that list or inject a preload.
- Root `package.json` and its `lint`/`test` strings select additional checks
  only. Their exit status is accepted only in addition to the direct parse and
  test-framework results; a repository wrapper cannot stand in for either.
- Candidate executables, dependencies, fixtures, and imports may be exercised
  by tests, but never select the Bun binary or its PATH. The clean-tree check,
  payload mode guard, pinned host tools, and direct pre-wrapper framework run
  corroborate their use; executable behavior remains test subject, not verdict.
- Git paths, modes, object IDs, and diff bytes drive scope, branch-tip, payload,
  overlap, and secret decisions. Git independently supplies those values;
  report SHA matching, mode refusal, disjoint-path checks, and the canonical
  gate-owned secret pattern corroborate them.
- Candidate changes to `gate/` do not alter the running gate: entrypoints source
  the already-landed library and policy before merging the candidate. Such
  risky paths additionally require independent review.
