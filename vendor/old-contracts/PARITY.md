# OLD contract parity map

The classifications below are the complete disposition for every fixture in
this directory. `implemented-tonight` means the v3 fresh seam is required to
cover the behavior in tonight's integrated meteorite proof; it does not make
the donor file executable production code.

| Donor fixture | Classification | v3 seam or reason |
| --- | --- | --- |
| `tools/orchestrator/dispatch-agent-spawn-contract.test.sh` | `implemented-tonight` | `orchestrator/dispatcher.ts` plus the acknowledged noop worker own confirmed launch. |
| `tools/orchestrator/dispatch-agent-lane-report.test.sh` | `implemented-tonight` | Dispatcher reconciliation requires durable terminal SHA, report, and verdict evidence. |
| `tools/orchestrator/dispatch-agent-no-commit-proof.test.sh` | `implemented-tonight` | The schema and dispatcher require terminal SHA evidence and must fail closed when it is absent. |
| `tools/orchestrator/lane-survives-dispatcher-death.test.sh` | `implemented-tonight` | The meteorite dispatcher-death assertion requires one worker, no duplicate launch, and terminal reconciliation. |
| `tools/orchestrator/mission-queue-dispatch.test.sh` | `D3` | Tonight proves one queued mission only; continuous queue filling and hierarchy capacity belong to D3. |
| `tools/claude-telegram-daemon/status-collector.test.ts` | `implemented-tonight` | `orchestrator/status.ts` joins mission, worker, lease, semantic evidence, and delivery state. |
| `tools/claude-telegram-daemon/orchestrator-runtime-status.test.ts` | `implemented-tonight` | Tonight's status must report stale semantic progress and degraded delivery truthfully. |
| `packages/master-orchestrator/src/__tests__/mailbox-ipc.test.ts` | `D2` | Durable channel/provider boundaries and mailbox IPC are split and hardened in D2. |
| `packages/master-orchestrator/src/__tests__/mailbox-replay.test.ts` | `D2` | Full restart/replay behavior follows the D2 recovery and channel spine. |
| `packages/master-orchestrator/src/__tests__/handoff-records.test.ts` | `D1` | D1 freezes the handoff record schema before later stages exercise it. |
| `deploy/systemd/bpa-orchestrator.service` | `D2` | Host systemd parity is explicitly outside the container-only bootstrap proof and is rehearsed in D2. |
| `docs/ops/orchestrator_durable_boot.md` | `D2` | The tracked host recovery/install path is rebuilt and rehearsed with the D2 supervision spine. |

There are no silent omissions and no `rejected-with-reason` rows: each admitted
fixture captures behavior retained either tonight or in the declared runway.
# Toolchain provenance

`package.json` is synthesized for this admitted slice because donor pin
`5f41a5cad59b764fa4c692ec7f33e3a4c978e559` contains no `package.json`.
It declares Bun, the only runtime imported by the admitted TypeScript tests,
and the authoritative foundation test command. The donor pin also contains
neither `bun.lock` nor `tsconfig.json`; they are therefore classified as
ABSENT-AT-PIN rather than silently omitted.
