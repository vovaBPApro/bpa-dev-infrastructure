# v3-recovery terminal report

## Public interface

- `supervise(state, now, staleAfterMs, newOwner)` marks stale/missing semantic progress `NO-GO` even when `pidAlive=true`, advances generation when a lease expires, and emits a generation-keyed escalation.
- `ownerMayWrite(lane, owner, generation, now)` is the old-owner write fence.
- `runSupervisor(statePath, outboxPath, ...)` atomically persists recovered state and appends independent JSONL outbox records.
- `renderStatus(input)` joins channel/provider/mission/manager/lane evidence; missing state is `UNKNOWN`, never green.
- Schema dependency: `core/schema.ts` must supply equivalent lane fields (`id`, `owner`, `generation`, `leaseDeadline`, semantic timestamp/evidence, verdict/blocker) or an adapter at integration.

## Consumption check

- lane-lifecycle sha256:84d3db25d785 — Lane Lifecycle
- verification-and-locks sha256:07e760358365 — Verification and Regression Locks
- tool-permissions sha256:955630cc416e — Tool Permissions
- repository-hygiene sha256:02acdffe2a56 — Repository Hygiene
- isolated-test-environments sha256:6ffd35d7c9f1 — Isolated Test Environments
- operator-feedback sha256:6dc6f5d4768f — Operator Feedback
- instruction-layers sha256:cd21f4ce0990 — Instruction Layers
- branching-policy sha256:98cd92116325 — Branching Policy
- reproducible-from-git sha256:822d9efe694b — Reproducible From Git

Mandatory plan consumed: `/root/.cache/infra-lanes/data-v3/v3-plan.md`, row `v3-recovery`.

## Verification

- PASS: `bun test orchestrator/supervisor.test.ts orchestrator/status.test.ts` (5 pass, 0 fail).
- PASS: copied launcher locks `launch-handshake-bounded.test.sh` and `singleton-failclosed.test.sh`.
- PASS: copied `watchdog.test.sh` with pinned NEW `core/mission-cli.ts`/`core/state.ts` supplied as a disposable dependency fixture.
- PARTIAL PASS: `watchdog-supervision.test.sh` reaches its executable transport boundary; its internal recovery/mutation locks pass.
- FAIL: copied `watchdog-transport-boundary.test.ts` times out waiting for `sendMessage`; reproduced unchanged against a clean archive of pinned NEW `5f41a5cad59b764fa4c692ec7f33e3a4c978e559` (`methods=`). This cross-lane daemon boundary is not green.

commit: 71434133436a84c5c24f4753f4c2e87d6490e2e7
verify: NO-GO — upstream copied watchdog transport boundary fails at pinned source SHA
result: NO-GO
secret-scan: NO-GO — local gate/land-lib.sh is absent until foundation integration
remaining: repair/reconcile daemon outbox transport boundary, integrate core schema adapter, then rerun all tests and canonical local secret scan
