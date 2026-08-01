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
