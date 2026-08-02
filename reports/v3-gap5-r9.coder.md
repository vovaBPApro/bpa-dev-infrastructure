# GAP-5 r9 landing-boundary producer epoch terminal evidence

candidate: `e7f36c21ba3b5a5798583e52f6888f6685df6d70`
prior-acceptance: `b2cbeff3893adcb6abbbc78c80d94ec0e9a05986`
implementation: `1223e6fd0a05b2c7ee2c8b07d70c6f796486b983`

## Consumption check

- lane-lifecycle `sha256:84d3db25d785` — Lane Lifecycle
- verification-and-locks `sha256:b6f8862a801d` — Verification and Regression Locks
- tool-permissions `sha256:955630cc416e` — Tool Permissions
- repository-hygiene `sha256:02acdffe2a56` — Repository Hygiene
- isolated-test-environments `sha256:6ffd35d7c9f1` — Isolated Test Environments
- operator-feedback `sha256:6dc6f5d4768f` — Operator Feedback
- instruction-layers `sha256:cd21f4ce0990` — Instruction Layers
- branching-policy `sha256:98cd92116325` — Branching Policy
- reproducible-from-git `sha256:822d9efe694b` — Reproducible From Git

## Root cause and regression

The epoch was not missing bootstrap state, synthesized by an earlier pass,
order-dependent, or racy. The clean detached landing checkout was under `/tmp`.
The tracked unit's `PrivateTmp=true` hid that checkout from the fixture, and its
direct script execution also crossed a `noexec` boundary. Systemd returned
`203/EXEC` before the producer could publish an authenticated epoch; the
readiness loop then surfaced the downstream absent-epoch error.

Red-before at the candidate SHA reproduced the exact landing failure from a
fresh detached worktree: `authenticated watchdog producer epoch absent`, then
`FAIL: live producer accounting was not clean`. Journal evidence recorded
systemd `203/EXEC`.

The tracked unit now invokes the tracked script through `/usr/bin/bash`, while
the fixture stages only its tracked runtime and unit template under disposable
`/run`. Provenance still requires the exact rendered unit and fingerprint.
Readiness fails immediately with the systemd result and exit status if the
producer cannot start; absent authority is never accepted.

## Clean verification evidence

The exact landing `verify:` command ran three consecutive times at the
implementation SHA, each in a newly-created clean detached worktree. Every run
reported three authenticated watchdog matrices, one foreign-unit preservation
matrix, and five explicit zero-residue observations. The daemon suite and all
other quoted subjects passed. No fixture worktree, unit, fragment, scratch
directory, or foreign unit created by these runs remained.

No deploy, merge, landing, push, live watchdog install, or activation occurred.

verify: `for run in 1 2 3; do bash core/watchdog-systemd.test.sh || exit; done && bash core/tick-journal-reconstruction.test.sh && bash test/run-loopback-fixture.test.sh && bash orchestrator/morning.test.sh && bash orchestrator/watchdog-supervision.test.sh && (cd daemon && bun install --frozen-lockfile && bun run typecheck && ../test/run-loopback-fixture.sh bun test)`

result: `NO-GO` — implementation and clean verification pass; fresh independent Tier-A review and landing evidence are absent.

secret-scan: clean

remaining: fresh independent Tier-A review, then landing gate
