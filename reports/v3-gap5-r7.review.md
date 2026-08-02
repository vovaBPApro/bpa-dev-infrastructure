# GAP-5 watchdog supervision r7 — Tier-A review

reviewed-sha: 816b7eda0f0fff5a0b9f9fb914cd53711481d159
evidence-sha: a304f32a70eb326a6d92b1391d7d26094267e168
independence: independent Codex reviewer session ag-rev-v3-gap5-r7-1544; no candidate authorship; report-only scope
tier: A — watchdog/evidence-gate and rollback behavior
verdict: REJECT

## Consumption check

- review-policy `sha256:6537ef28ad14` — Review Policy
- verification-and-locks `sha256:b6f8862a801d` — Verification and Regression Locks
- roles `sha256:cd4c40c4e640` — Roles
- instruction-layers `sha256:cd21f4ce0990` — Instruction Layers
- tool-permissions `sha256:955630cc416e` — Tool Permissions
- reproducible-from-git `sha256:822d9efe694b` — Reproducible From Git

## Scope and evidence inspected

Reviewed the exact candidate and evidence commits, the complete diff from
`origin/main` through the candidate, the tracked clean-clone reconstruction,
real-systemd matrix, daemon loopback runner, morning and supervision fixtures,
production watchdog provenance/accounting code, and the rendered production
unit contract. No Telegram contact, live watchdog installation/activation,
deployment, merge, landing, push, or cleanup of pre-existing host units was
performed.

## Blocking findings

1. **The real-systemd lock reports zero residuals while leaving failed unit
   state behind.** Each of the three consecutive runs printed
   `cleanup rollback zero-residuals`, and `core/watchdog-systemd.test.sh` accepts
   cleanup when `LoadState=not-found`. Immediately afterwards,
   `systemctl list-units --all 'bpa-watchdog-gap5-*' --no-legend --no-pager`
   still listed the new run identities (including `335809-20776`,
   `336370-6822`, and `336767-9088`) as `not-found failed failed`. The fixture
   removes its fragment and reloads the manager but never resets failed state.
   Therefore rollback/zero-residue evidence is false green and does not meet the
   explicit success/failure/timeout residue requirement.

2. **The terminal evidence is contradictory at the exact reviewed tree.** The
   evidence commit records `2078 expectations`; the required isolated daemon
   rerun at that tree completed with 272 pass, 0 fail, but reported `2077
   expect() calls`. The test result itself is green, but the stamped evidence is
   stale or inaccurate and cannot support a clean Tier-A verdict.

3. **Failure/timeout cleanup of the loopback unit is asserted, not locked.** The
   only direct consumer assertions in `daemon/mcp-rebind.integration.test.ts`
   cover a successful nested run and its `residuals=0` message. There is no
   regression lock that drives `test/run-loopback-fixture.sh` through a failing
   child and a bounded timeout/interruption and then independently enumerates
   the manager to prove no unit state remains. This missing evidence is
   independently blocking under the mission's explicit acceptance boundary.

## Commands rerun

```sh
git diff --check origin/main...816b7eda0f0fff5a0b9f9fb914cd53711481d159
bash core/tick-journal-reconstruction.test.sh
for run in 1 2 3; do bash core/watchdog-systemd.test.sh; done
bash orchestrator/morning.test.sh
bash orchestrator/watchdog-supervision.test.sh
(cd daemon && bun install --frozen-lockfile && bun run typecheck && ../test/run-loopback-fixture.sh bun test)
systemctl list-units --all 'bpa-loopback-fixture-*' 'bpa-watchdog-gap5-*' --no-legend --no-pager
```

Observed: reconstruction 18 pass/0 fail; all three real-systemd runs printed
PASS; morning and supervision PASS; 503 stayed queued and subsequent success
was acknowledged; frozen install and typecheck exited zero; daemon suite 272
pass/0 fail across 26 files with 2077 expectations; loopback runner printed
`residuals=0`; independent systemd enumeration contradicted zero residue for
the watchdog matrix.

## Disposition

Do not land. Add exact ownership cleanup plus manager enumeration that proves
absence after success, child failure, and timeout/interruption; make the
real-systemd matrix clear and verify failed-unit state; rerun the entire exact
suite and refresh evidence with the observed counters before a new independent
Tier-A review.

result: NO-GO
blocker: false-green zero-residue/rollback claim and missing failure/timeout cleanup lock
remaining: implementation correction, fresh exact-SHA evidence, and new independent Tier-A review
