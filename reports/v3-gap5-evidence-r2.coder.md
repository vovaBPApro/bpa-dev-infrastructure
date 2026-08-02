# GAP-5 comparable evidence repair

## Consumption check

- `lane-lifecycle` `sha256:84d3db25d785` — Lane Lifecycle
- `verification-and-locks` `sha256:b6f8862a801d` — Verification and Regression Locks
- `tool-permissions` `sha256:955630cc416e` — Tool Permissions
- `repository-hygiene` `sha256:02acdffe2a56` — Repository Hygiene
- `isolated-test-environments` `sha256:6ffd35d7c9f1` — Isolated Test Environments
- `operator-feedback` `sha256:6dc6f5d4768f` — Operator Feedback
- `instruction-layers` `sha256:cd21f4ce0990` — Instruction Layers
- `branching-policy` `sha256:98cd92116325` — Branching Policy
- `reproducible-from-git` `sha256:822d9efe694b` — Reproducible From Git

## Exact source and ancestry pins

- reviewed donor: `1b6f4ac51a949171e679c00f5c2b23a98ad788be` on the
  `origin/v3` chain; `git merge-base origin/v3 1b6f4ac...` is the landed v3 tip
  `99db22d5bda00381653b9fd9da5c2c5de5d7a882`.
- comparable recut candidate: `d81862c9dbcd7d10c238c8f12e63fae1aa777933`
  on the `origin/main` chain; its parent and merge-base with `origin/main` are
  both `f49b43b3d7cf3294a279d44aac7dbb68dbfeb891`.
- relation: the candidate ports the donor's append-only tick journal and
  fail-closed interval accounting into the canonical `StateStore` present on
  `origin/main`; it does not claim that the two commits share ancestry or that
  the donor is the candidate base.

## Regression evidence

Red-before was run in a disposable detached worktree at `d81862c^`. Only the
candidate's `core/state.test.ts` patch was applied, leaving production code at
the parent. `bun test core/state.test.ts` exited 1: 9 pass / 2 fail. Both named
W-48 locks failed because `StateStore.appendTickJournal` was absent. The
worktree was removed after capture.

Green was run at exact candidate `d81862c9dbcd7d10c238c8f12e63fae1aa777933`:
`bun test core/state.test.ts` exited 0 with 11 pass / 0 fail and 35 expectations.

Dependency setup was explicit: `(cd daemon && bun install --frozen-lockfile)`
exited 0 and installed the locked dependency graph. The highest repository-wide
command, `bun test`, was then run. It did not pass: unrelated daemon integration
tests timed out at their daemon/tmux boundary, including
`terminal-alert-process.test.ts`, `notify-handler.test.ts`,
`watchdog-turnend-a1.test.ts`, and `inbound-media-pipeline.test.ts`. After
multiple bounded failures (5s, 15s, and 30s each) established that failure
class, the still-running suite was interrupted. This is partial evidence and is
therefore explicitly `NO-GO`; none of those files is changed by this candidate.

## Terminal evidence

candidate: `d81862c9dbcd7d10c238c8f12e63fae1aa777933`
verify: `bun test core/state.test.ts && (cd daemon && bun install --frozen-lockfile) && bun test`
result: `NO-GO` — the GAP-5 regression boundary is red-before/green-after, but the highest repository-wide suite has unrelated daemon/tmux timeouts and was partial
secret-scan: clean — canonical runtime-extracted pattern over `git diff origin/main...HEAD` produced no hits
remaining: independent Tier-A review and a host-capable complete repository-wide rerun; do not land
