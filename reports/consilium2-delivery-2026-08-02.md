# Consilium round 2 — infrastructure delivery economics

## Consumption check

- review-policy sha256:6537ef28ad14 — Review Policy
- verification-and-locks sha256:07e760358365 — Verification and Regression Locks
- roles sha256:cd4c40c4e640 — Roles
- instruction-layers sha256:cd21f4ce0990 — Instruction Layers
- tool-permissions sha256:955630cc416e — Tool Permissions
- reproducible-from-git sha256:822d9efe694b — Reproducible From Git

Reviewer: `consilium2-delivery`, independent read-only delivery-economics lens. New tree reviewed at `7f15e7bd1491c7119e41f1ee541596b709beb4e6`; old donor at `d0a99b8439f2731654e23b5e7759961f4602d0d3`, including rescue tip `5c8206be024f49538696d6237021ce4e4a70b5ca`.

## Verdict

1. Yes: attempt #1 failed operationally, not because it produced nothing; its two nights ended in low-value/silent tails, including a proven 7h41m blackout with zero terminal lane evidence.
2. Recommend a defined hybrid: keep the new Bun/TS daemon, instruction compiler, ledger, isolation and fail-closed gates; port the old queue/manager, health, hierarchy and isolated parallel-gate mechanics behind parity locks.
3. Do not restart on the old tree: its 2,798-commit/product-coupled base makes re-porting the new generic control plane the longest critical path. Do not continue row-by-row: W-31/35/36/38/41–46 plus review debt preserve the same serialized queue.
4. Cost: continue 34–48 codex-lane-days nominal / 50–75 risk-adjusted; old-base restart 48–68 / 65–95; hybrid 28–40 / 38–55. Estimates include independent review and 30–40% stall/rework reserve.
5. Week plan: D1 inventory/parity/red locks; D2 recovery+channel spine; D3 queue and three-level leases; D4 parallel verification/landing; D5 daylight chaos rehearsal; D6 first trustworthy overnight; D7 evidence review and cutover decision.
6. Ten–twelve standing lanes are a capacity target, not ten uncontrolled writers: five coder/reviewer pairs plus 0–2 integration/diagnosis lanes, with bounded level-3 spawn rights and durable leases.
7. The overnight milestone is trustworthy only if semantic progress, next-wave dispatch, end-of-queue Telegram, independent recovery and morning SHA accounting all pass; service/timer health alone is not green.

## Evidence that attempt #1 failed

The failure is observable at the delivered boundary. `reports/hist-telegram-new-2026-08-02.md` bounds the second blackout from the last delivered bot message at 23:28:42Z to the first inbound recovery query at 07:09:46Z: 7h41m, with no lane-log terminal evidence. `reports/consilium-process-2026-08-02.md` adds `running=0` with work outstanding and shows that `orchestrator/fleet/fleet-nudge.sh` merely injects text into tmux, while `fleet-nudge-liveness.sh` measures heartbeat age rather than semantic progress. Thus nominal watchdog activity could be green while delivery was stopped.

The new workboard records concrete self-inflicted failures: W-31, a daemon restart that killed the orchestrator and left a 14-minute headless gap; W-33, repeated terminal-alert self-echo storms and ten correction rounds; W-37, the circular watched-pane alert topology; W-38, recovery logic still awaiting independent runtime review/rehearsal. W-35 and W-36 show verification infrastructure itself causing false failures. W-41–46 then re-open missing essentials: truthful night backstop, comprehensible status, next-wave/end-of-queue behavior, login relay, blackout postmortem, and the three-level team contract. These are control-plane acceptance gaps, not polish.

The new tree nevertheless contains genuine additions worth keeping: `daemon/*.ts` provides the Telegram control surface/history/model plumbing; `tools/instructions/compose.ts` and the ledger tools compile pinned instruction packs; `gate/land-lib.sh`, `gate/land.sh`, and `gate/review-policy.conf` implement exact-SHA review and secret/evidence gates; `orchestrator/fleet/launch-lane.sh` plus tracked units establish isolated Bun/TS lane operation. The current 764-commit tree is generic and already carries the meteorite-test documentation surface.

The old tree proves that stronger execution mechanics existed. At `d0a99b8`, `tools/orchestrator/mission-queue-dispatch.sh` and `orchestrator-loop.sh` implement a queue/loop spine; `launch-manager-pilot.sh`, `manager-wait-lanes.sh`, and their watchdog/re-entry/pipelining tests provide manager hierarchy mechanics; `dispatch-agent.sh`, `lane-survives-dispatcher-death.test.sh`, and the branch/report guards provide durable lane lifecycle; `run-health-checks.sh` and `health-checks/*` cover git drift, Telegram MCP, disk and dev services; `merge-gate-parallel-suites.test.sh`, `heavy-phase-semaphore.sh`, and B424 dispatch evidence explicitly address landing serialization using isolated clones and a short serialized merge phase. Those mechanisms are the donor quarry, not a safe wholesale base: the old repository mixes product apps, pnpm workspaces and 2,798 rescue-history commits.

## Option economics

One codex-lane-day means one focused coder, reviewer, runtime, or integration lane for one day; elapsed time cannot divide linearly by 10–12 because shared-host rehearsal, exact-SHA review, merge and deployment serialize.

| Option | Included work | Nominal | Risk-adjusted | Judgment |
|---|---|---:|---:|---|
| Continue hardening new tree | Close W-31/35/36/37/38/39/40/41–46, review debt, deploy parity and overnight proof | 34–48 | 50–75 | Lowest edit distance, but repeats narrow-round/review queueing without first replacing the execution spine. |
| Restart on old base | Generalize product/pnpm assumptions, port Bun daemon, instruction/ledger system, gates, instance split and current fixes | 48–68 | 65–95 | Working donor mechanics are outweighed by re-platforming and regression proof across two architectures. |
| Defined hybrid | Keep new system of record; port only donor execution mechanisms with red-before/parity tests | 28–40 | 38–55 | Recommended: smallest credible acceptance scope and preserves both trees' proven value. |

The reserve is evidence-based. Two overnight incidents make unattended shared-host work a material stall risk; W-33 consumed ten implementation/review rounds; W-31 rehearsals correlated with session exits and leaked scopes; W-38 cannot yet be rehearsed. Review and landing also serialize at exact SHA, and old B424 evidence identifies the same gate bottleneck. Maintaining 10–12 honest lanes costs about 3–5 lane-days initially for lease/queue/capability instrumentation and thereafter roughly 1–2 lane equivalents per day for independent review, integration, reaping and diagnosis; treating all twelve as writers increases branch inventory faster than landing capacity.

## Defined hybrid: keep X, take Y

Keep X in the new tree:

- `daemon/` Telegram server, durable history and control plumbing;
- `tools/instructions/` composer, validation, ledger, triage and session-load system;
- `instructions/`, `instance/` and generated pack/decision provenance;
- `gate/land-lib.sh`, `gate/land.sh`, `gate/land-batch.sh` and exact-SHA review artifacts;
- current worktree isolation, secret scan, W-33/W-37 alert-boundary fixes and Bun/TypeScript runtime rule.

Take Y selectively from the old donor, rewritten as generic Bun/TS or thin tracked shell launchers where appropriate:

- queue/continuous dispatch semantics from `tools/orchestrator/mission-queue-dispatch.sh` and `orchestrator-loop.sh`;
- manager re-entry, pipelining, bounded waits and sub-agent supervision from `launch-manager-pilot.sh`, `manager-wait-lanes.sh`, and their tests;
- dispatcher-independent lane survival and report/branch guards from `dispatch-agent.sh` and `lane-survives-dispatcher-death.test.sh`;
- health inventory from `run-health-checks.sh` and `health-checks/*`;
- isolated parallel verification plus short serialized landing from `merge-gate-parallel-suites.test.sh` and `heavy-phase-semaphore.sh`.

Every port starts with a source/parity row and a named red-before lock against the new tree. No donor merge, product path, host constant, pnpm assumption, credential, or historical branch is imported.

## Week-shaped milestone plan

- Day 1 — freeze unrelated mechanics; inventory W-31/35/36/37/38/39/40/41–46 and donor Y; create a parity matrix with owner, exact source, acceptance lock, reviewer and deletion/rollback rule. Demonstrate red locks for silent zero-lane work, missing queue notification, stale semantic progress and dispatcher death.
- Day 2 — land/deploy the recovery and channel spine: W-37/W-31/W-38 disposition, independent alert path, installed-unit parity, bounded restart retry and Telegram delivery acknowledgement. Run only announced daylight failure drills.
- Day 3 — land the durable mission queue and hierarchy: orchestrator → 10–12 standing role slots → level-3 sub-agents only for declared manager/research/review roles. Each child receives a mission id, generation, deadline, path/capability scope, parent lease, terminal artifact and recursive cleanup obligation.
- Day 4 — remove landing serialization where safe: verify candidate SHAs concurrently in isolated clean clones, cache evidence by tree+command digest, then serialize only review confirmation, merge, post-merge verification and deploy. Prove stale evidence cannot cross a rebase.
- Day 5 — daylight chaos rehearsal: kill a lane, manager, orchestrator session and Telegram delivery path separately; restart daemon; exhaust the queue; force a failed launch. Each case must recover or escalate without killing healthy work, leaking units/worktrees, or reporting green.
- Day 6 — first trustworthy overnight run: admit 6–8 bounded independent missions plus ready reviews, not twelve speculative branches. Supervisor requires a newer durable generation by deadline, refills useful slots to 10–12, and sends a direct end-of-queue/escalation message outside the watched pane. Morning reconciliation maps every planned row to SHA/review/result/cleanup; any gap is NO-GO.
- Day 7 — independent security, operations/runtime and regression consilium on the same SHA; clean-clone bootstrap and rollback; choose cutover only if the overnight record is complete and rerunnable.

## Three-level honesty contract

The top orchestrator owns queue admission, integration and operator availability. Level 2 contains 10–12 standing slots, but useful concurrency is normally five coder/reviewer pairs; one or two slots may be diagnosis/integration when the critical path needs them. Level 3 is bounded delegation, not an uncounted fleet: only roles with explicit spawn rights may create children, child capacity counts against the same global budget, depth is capped at three, and the parent cannot finish until every child has terminal evidence and cleanup. A lease expires on missing semantic progress, not on a dead process alone. Repeated launch failure triggers the independent Telegram path; it never resets the progress clock merely because a timer fired.

## Review disposition

This opinion is `NO-GO` for immediate unattended cutover or for declaring either tree the completed base. First bounded action: produce the Day-1 two-tree parity matrix and executable red locks, then land/deploy/rehearse the Day-2 recovery/channel spine in an announced window. The hybrid recommendation becomes actionable only when those artifacts exist at one reviewed SHA.

commit: 7f15e7bd1491c7119e41f1ee541596b709beb4e6 consilium2-delivery consilium opinion
verify: test "$(git rev-parse HEAD)" = 7f15e7bd1491c7119e41f1ee541596b709beb4e6 && test "$(git -C /root/legacy-donors/bpa-master rev-parse HEAD)" = d0a99b8439f2731654e23b5e7759961f4602d0d3 && rg -n '^(## Verdict|commit:|verify:|result:|secret-scan:|remaining:)' orchestrator/runtime/reports/consilium2-delivery.report.md
result: NO-GO
secret-scan: clean
remaining: none
