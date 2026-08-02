# v3 GAP-5 r3 runtime journal rework

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

## Artifact and regression evidence

Implementation `ea960e98636bd39576e860ca4c37ce2e18660ee7` wires the durable
journal producer into `orchestrator/watchdog.sh` and its fail-closed consumer
into `orchestrator/morning.sh`. Producer identities bind boot, unit/producer,
and service invocation. Each retained missed interval requires exactly one
cause row with the same cause and source identities. Missing, extra, unknown,
or drifting identities become `UNKNOWN`, `AMBIGUOUS`, or `IDENTITY_DRIFT` and
are `UNMEASURED`/`NO-GO`.

`bun test core/state.test.ts core/tick-journal-runtime.test.ts` passed 15 tests
and 46 expectations. It covers restart/reboot replay and dedupe, abrupt SIGKILL
with WAL recovery, one-to-one cause accounting, identity drift, ambiguity,
schema upgrade, corrupt database refusal, rollback-compatible legacy inserts,
and exact temporary-resource teardown.

`bash core/tick-journal-reconstruction.test.sh` cloned exact tip without local
transport, reran those 15 locks, checked production callers, checked a clean
clone status, and exited 0.

The complete repository inventory was allowed to finish: `(cd daemon && bun
install --frozen-lockfile) && bun test` exited 1 after 635.99s with 541 pass,
24 fail, 7 errors, and 2754 expectations. Failures are the existing real tmux,
daemon health/transport, and database-grant timeouts, including W-37, W-15,
A1, inbound media, MCP rebind, watchdog transport, and database access. They
are outside this seven-file implementation diff, but complete failing evidence
is still `NO-GO` and is not relabelled clean.

No service was installed, armed, landed, deployed, or pointed at live state.
All runtime fixtures were disposable and removed.

commit: ea960e98636bd39576e860ca4c37ce2e18660ee7 [CODER] wire durable GAP-5 runtime journal
verify: bun test core/state.test.ts core/tick-journal-runtime.test.ts && bash core/tick-journal-reconstruction.test.sh
result: NO-GO — full inventory completed with 541 pass / 24 fail / 7 errors
secret-scan: clean
remaining: independent Tier-A review and repair/rerun of the repository-wide daemon/tmux/database timeout inventory; do not land or deploy
