# Consilium round 2 — infrastructure portability

## Consumption check

- `review-policy` `sha256:6537ef28ad14` — Review Policy
- `verification-and-locks` `sha256:07e760358365` — Verification and Regression Locks
- `roles` `sha256:cd4c40c4e640` — Roles
- `instruction-layers` `sha256:cd21f4ce0990` — Instruction Layers
- `tool-permissions` `sha256:955630cc416e` — Tool Permissions
- `reproducible-from-git` `sha256:822d9efe694b` — Reproducible From Git

## Verdict

1. Так: attempt #1 провалив саме migration/parity — NEW має сильні нові gates/instructions, але не відтворив надійний OLD operating loop.
2. Обрати defined hybrid на NEW generic repo, але портати перевірені OLD runtime-механізми як окремі parity slices; не продовжувати латати stopgap і не відновлювати product monorepo.
3. X з OLD: confirmed lane dispatch, authoritative fleet keeper/status, Telegram lifecycle, reboot/recovery, live model switch, durable mailbox/handoffs.
4. Y з NEW: composed pinned instruction packs/checker, fail-closed landing/secret gates, role personas/consilium routing, decisions/workboard/evidence ledger, generic isolation.
5. OLD `1→3→9` — approved architecture, не доведений production three-level keeper; nested spawn треба реалізувати й runtime-lock-нути, а не оголосити перенесеним.
6. Для 10–12 standing lanes: top→2–3 managers→до 3–4 workers, durable queue/lease/ack/terminal SHA; process/heartbeat/Telegram delivery не є progress.
7. Admission attempt #2: inventory every OLD capability, red-before parity lock, clean-clone install, reboot/channel-loss/stall drills, independent Tier-A review, only then overnight run.

## Compared revisions and scope

- NEW: `7f15e7bd1491c7119e41f1ee541596b709beb4e6` (`ag-consilium2-portability`).
- OLD donor: `d0a99b8439f2731654e23b5e7759961f4602d0d3` (`main`). The requested rescue ref was not needed to establish the mechanisms below; attempt #2 must inventory it before porting so no later donor capability is missed.
- This is infrastructure-only. OLD product packages and application behavior are explicitly excluded from X.

## Mechanism parity matrix

| Mechanism | OLD evidence and assessment | NEW evidence and classification |
|---|---|---|
| Dispatcher / lane launch | `tools/orchestrator/dispatch-agent.sh` is a large provider-agnostic launcher with isolated worktrees, provider processes and a dedicated executable spawn-contract suite (`dispatch-agent-spawn-contract.test.sh`). `docs/concepts/CONCEPT_orchestration_fleet_architecture.md` requires session-created plus first-token confirmation. | `orchestrator/fleet/launch-lane.sh` composes a checked pack, creates one worktree and `systemd-run` unit, but launch success is only unit submission; it has no first-token/worker acknowledgement and no queue ownership. **Reimplemented worse** at the runtime boundary, though isolation and pack injection are better. |
| Ten-lane keeper / next wave | OLD policy supports up to 15 sub-agents and `orchestrator-fleet-ping.sh` derives live fleet/mission status; `docs/ops/orchestrator_durable_boot.md` installs recurring fleet/status jobs. This was a broader, used operating surface, but the donor evidence does not prove a self-sufficient ten-lane dispatcher. | `fleet-nudge.sh` counts units/open Markdown rows, then pastes text into tmux. Paste failures can exit 0; there is no dispatch acknowledgement, generation or progress deadline. The incident report proves `running=0` with work outstanding and repeated ineffective nudges. **Reimplemented worse / false-green stopgap**, not parity. |
| Watchdog and truthful health | OLD has `tools/ops/lane-watchdog.sh`, timer/service units, Telegram runtime status and explicit post-restart self-test. The OLD architecture names heartbeat, durable supervision and proof-bearing reports as substrate prerequisites. | `orchestrator/watchdog.sh` is substantially hardened (PID/starttime identity, leases, bounded restart, daemon health, outbox), but the fleet nudge liveness observes its heartbeat rather than semantic work progress. `reports/consilium-process-2026-08-02.md` records an absent installed liveness timer and tracked/runtime drift. **Partly ported, operationally worse** because health could be green while work stood still. |
| Telegram daemon + `/status` | OLD `tools/claude-telegram-daemon/server.ts`, `status-collector.ts`, `orchestrator-runtime-status.ts`, `direct-bridge.ts` and tests form a mature channel with daemon/fleet/orchestrator status and MCP rebind behavior. | NEW has `daemon/server.ts`, `orchestrator/status.sh`, health checks and tests, but `reports/hist-telegram-new-2026-08-02.md` proves repeated missing replies, empty `/screen`, and a 7h41m delivery/activity gap. **Ported in shape, reimplemented worse in deployed reliability**. |
| Restart/recovery and reboot survival | OLD tracks a bootable `deploy/systemd/bpa-orchestrator.service`; `docs/ops/orchestrator_durable_boot.md` documents linger, durable mission state and recurring jobs; mailbox replay tests lock restart dedupe. | NEW has stronger written rules in `instructions/restart-recovery.md`, service templates, leases and watchdog tests, but the incident pack records a launcher lock inherited by tmux/liveness, blocking the next provider forever, plus daemon/session coupling and deployed-unit drift. **Reimplemented worse; required behavior not proven**. |
| Model switch mid-session | OLD `model-switch.ts` accepts `/model` and bare `модель`, persists `orchestrator-model`, and sends the command into the running TUI; `model-switch.test.ts`/`server.test.ts` cover it. | NEW persists model pins and `orchestrator/model-command.test.sh` proves the next launch uses them, but workboard ML-16/W-39 records live running-session switch parity as open. **Missing live parity** (restart-time pinning is not mid-session switching). |
| Handoffs / recovery context | OLD master orchestrator has filesystem mailbox IPC, correlation-scoped `handoff-records.ts`, replay/deduplication tests, stale-entry detection and service isolation. | NEW has an instruction handoff schema/tooling and a one-time `instance/handoff-oldorch-2026-07-30.md`, but no comparable live multi-agent mailbox/audit transport was found. **Missing runtime parity; improved static schema only**. |
| Agent spawns agent / three levels | OLD concept explicitly specifies top → 2–3 managers → up to 3 workers each (`1→3→9`) and proof-carrying manager summaries. `dispatch-agent.sh` implements sub-agent launch, but the concept itself says hierarchy lands only after the substrate; no executable recursive manager keeper proves three live levels. | NEW launcher accepts role `manager`, and policies mention a manager, but there is no durable manager queue, child ownership, recursive budget/capability enforcement, or end-to-end three-level runtime test. **Missing in both as a proven mechanism**; OLD provides the concrete design donor. |

This verifies the Human's claim in the important operational sense: the NEW tree did not carry forward several mature, executable OLD surfaces with runtime parity. It does not mean NEW is empty; its additions are valuable, but they sit above an unreliable execution substrate.

## Port-list X — take from OLD, generically

1. Port the contracts and behavior of `tools/orchestrator/dispatch-agent.sh` plus its spawn-contract tests: provider-neutral launch, isolated worktree, explicit first-token acknowledgement, durable lane identity, terminal report and loud launch failure. Do not copy product paths or host constants.
2. Replace `fleet-nudge.sh` tmux injection with a durable dispatcher/keeper derived from OLD fleet accounting: queue rows with owner, generation, lease, acknowledgement and terminal artifact; refill toward a configurable 10–12 ceiling and alarm below three. A tick exits green only after state transition/ack, not after sending keystrokes.
3. Port OLD Telegram status semantics from `status-collector.ts` and `orchestrator-runtime-status.ts`: one authoritative `/status` joins daemon/channel, provider/model, mission, managers, workers, leases, last semantic progress and delivery health. Preserve NEW's independent outbox boundary.
4. Port and reconcile OLD durable boot/model behavior: tracked systemd enablement, post-reboot self-test, persisted mission, `/model` plus bare `модель` applied to the live session, and daemon MCP rebind without killing a healthy provider.
5. Port OLD filesystem mailbox/handoff protocol (`mailbox-ipc.ts`, `handoff-records.ts`, replay and coordination locks) into generic mission/manager/worker messages with correlation, dedupe, ack and restart reconstruction.
6. Implement the OLD `1→3→9` design as configurable `1→(2..3)→(3..4)` for 10–12 standing lanes. Managers may spawn workers only through the same checked dispatcher; enforce global/per-manager caps, path ownership, leases and upward proof compression.

## Keep-list Y — retain from NEW

1. `tools/instructions/compose.ts`, `dispatch-check.ts`, `check.ts`, floor/schema/ledger tests: pinned role packs, closed tags, verbatim Human capture and manifest consumption.
2. `gate/land.sh`, `gate/land-lib.sh` and fail-closed suites: exact reviewed SHA, risk routing, repository-declared verification inventory, canonical secret scan and branch cleanup. Extend them with runtime/reboot/channel parity locks; do not weaken them to accept OLD output.
3. `instructions/review-policy.md`, `roles.md`, personas and consilium records: role-diverse independent review with exact-SHA evidence.
4. `instance/decisions/`, `instance/workboard.md`, mission/triage tooling and terminal reports: durable requirements and one visible chain. Upgrade Markdown counting to a transactional runtime state projection rather than discarding this ledger.
5. Generic Bun/TypeScript control-plane boundary, systemd isolation, capability declarations and meteorite-test tracked configuration. Translate donor behavior; do not import OLD product monorepo or host-specific state.

## Attempt #2 failure-immunity plan

1. Freeze a capability ledger before implementation: every OLD mechanism, exact donor SHA/file, NEW counterpart, classification, acceptance lock and disposition. Unknown/unclassified is `NO-GO`; no capability disappears silently.
2. Build bottom-up: mailbox/state → confirmed dispatcher → manager hierarchy → keeper/watchdog → Telegram/status/model → reboot recovery → landing integration. Each defect class needs red-on-current-NEW and green-on-hybrid evidence.
3. Separate truth signals: process alive, channel delivered, lane acknowledged and semantic progress are four fields. Only a newer durable artifact/terminal SHA or declared long-running check advances progress. After bounded retries, an independent channel pages the Human and repeats until recovery.
4. Exercise failure drills from a clean clone: failed spawn, killed worker/manager/top, expired lease, daemon restart, Telegram send failure, provider restart, inherited lock, reboot, exhausted queue, malformed requirement pack and seven-hour simulated stall. Verify dedupe, fencing, escalation, recovery and teardown.
5. Land every Tier-A slice through independent consilium on the exact SHA. Reverify the complete tracked suite and installed-unit parity after integration; an ignored, missing, timed-out or host-only test is `NO-GO`.
6. Admit unattended work only after the hierarchy sustains a timed soak at 10–12 lanes, refills completed lanes, survives manager/top restarts, reports below-three/empty-queue states, and produces a one-to-one morning ledger of missions → SHAs/reviews/blockers.

## Evidence disposition

The repository evidence is sufficient to answer the motion and define X/Y, but insufficient for a `clean` operational migration verdict. In particular, OLD three-level hierarchy is design-level, NEW runtime/deployment parity is contradicted by the two incidents, and no fail-before/pass-after port has yet been implemented. The reviewed verification also found the same executable blocker in both checked trees: `launch-lane.test.sh` / OLD `dispatch-agent-spawn-contract.test.sh` failed `hydration rejects tmpfs before materializing node_modules` because the launcher proceeded to create the worktree instead of emitting the expected disk-backed-storage refusal. NEW fleet-nudge/model locks passed; OLD model-switch/mailbox-replay/coordination locks passed (8/8). Therefore attempt #2 execution remains `NO-GO` until the first bounded parity slice is built and independently reviewed.

commit: 7f15e7bd1491c7119e41f1ee541596b709beb4e6 consilium2-portability consilium opinion
verify: git rev-parse HEAD; git status --short; (cd /root/legacy-donors/bpa-master && git rev-parse HEAD && git status --short); bash -n orchestrator/fleet/launch-lane.sh orchestrator/fleet/fleet-nudge.sh orchestrator/watchdog.sh orchestrator/status.sh; bash orchestrator/fleet/launch-lane.test.sh; bash orchestrator/fleet/fleet-nudge.test.sh; bash orchestrator/model-command.test.sh; (cd /root/legacy-donors/bpa-master && bash tools/orchestrator/dispatch-agent-spawn-contract.test.sh); (cd /root/legacy-donors/bpa-master && bun test tools/claude-telegram-daemon/model-switch.test.ts packages/master-orchestrator/src/__tests__/mailbox-replay.test.ts packages/master-orchestrator/src/__tests__/coordination-audit.test.ts); pat=$(eval "$(sed -n 's/^[[:space:]]*secret_pattern=/REPLY=/p' gate/land-lib.sh)"; printf '%s' "$REPLY"); test -n "$pat"; ! git diff origin/main...HEAD | LC_ALL=C grep -aE "$pat"; ! LC_ALL=C grep -aE "$pat" orchestrator/runtime/reports/consilium2-portability.report.md
result: NO-GO
secret-scan: clean
remaining: none
