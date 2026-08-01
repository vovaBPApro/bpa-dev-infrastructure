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

The landed tree is input, never the authority for its own verdict. This is the
complete trust surface of both entrypoints; each row names its corroboration and
the regression lock that exercises the boundary:

- CLI branch, report, repository, worktree, push, verify, and review-skip inputs
  are shape-checked, branch-resolved by Git, and tied together by exact report
  SHA. Locks: `land.test.sh`, `land-batch.test.sh`, and
  `land-batch-hardening.test.sh` cover missing/malformed arguments, stale or bad
  SHA, rollback, interruption, and batch cardinality.
- Repository and origin state (default ref, current checkout, cleanliness,
  freshness, merge base, branch tips, object modes, overlap, ancestry, remote
  presence) is believed only when independent Git queries agree at the point of
  use. The same three landing suites lock stale main, dirty/ref-invalid cases,
  conflicts, overlap, forbidden modes, rollback, and local/remote reap.
- The coder report supplies result, verify command, claimed counts, and commit
  SHA. `completion-guard.ts` checks its grammar and runs verification at the
  branch commit; the landing entrypoint rechecks the branch tip, and optional
  post-merge verification re-runs the command and count comparison. Locks:
  `completion-guard.test.ts`, `land.test.sh`, and
  `land-batch-hardening.test.sh` cover fabricated, failing, stale, and later
  failing evidence.
- Review policy prefixes and review artifacts select and attest risky review.
  Exact candidate paths are matched against the gate-owned policy; artifact
  shape, reviewed SHA, verdict, and reviewer independence are checked. Locks:
  the review cases in `land.test.sh` and `land-batch.test.sh` cover missing,
  malformed, rejected, stale, symlinked, self-authored, and skipped review.
- Secret decisions consume Git diff bytes, paths, modes, and bounded decoded
  additions. They are corroborated by the single gate-owned signature pattern
  and fail closed on scanner errors. Locks: secret, secret-path, type-change,
  binary, Unicode, and encoded cases in the landing suites and
  `land-secret-scan.test.sh`.

- Tracked JavaScript and TypeScript source paths and bytes are corroborated by
  the gate's pinned Bun parser over the Git-produced file list.
- Tracked test paths and bytes are corroborated before any package script runs
  by pinned Bun invoked directly with the explicit Git-produced test list and
  an empty, gate-owned config. The gate parses Bun's own final collection and
  pass counts, prints `tests=N passed=N`, and refuses a missing, malformed, or
  zero value for either; the single and batch zero-suite and skipped-only locks
  prove both entrypoints fail. Candidate `bunfig.toml` discovery cannot replace
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
- Executables believed by the gate are the invoking shell plus `git`, `flock`,
  and fixed-path host utilities, and Bun resolved only from
  `/usr/local/bin:/usr/bin:/bin` then canonicalized. Candidate scripts receive a
  clean environment and the fixed PATH; caller binary overrides are refused.
  Locks: `landing-entrypoints.test.sh` covers Bun override and legacy entrypoint,
  while shadow-binary cases in both landing suites cover candidate PATH input.
- Exit codes are believed only for the exact command just executed, under
  `pipefail`; output-derived claims additionally require parseable structured
  evidence (report counts or Bun's collection summary). Syntax checks and the
  failing declared/verify/framework cases in both landing suites prove nonzero
  propagation; `exit-zero-audit.md` itself is the inventory lock reviewed with
  every gate change.
