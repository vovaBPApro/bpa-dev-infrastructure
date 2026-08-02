# Consilium round 2 — infrastructure architecture

## Consumption check

- `review-policy` `sha256:6537ef28ad14` — Review Policy
- `verification-and-locks` `sha256:07e760358365` — Verification and Regression Locks
- `roles` `sha256:cd4c40c4e640` — Roles
- `instruction-layers` `sha256:cd21f4ce0990` — Instruction Layers
- `tool-permissions` `sha256:955630cc416e` — Tool Permissions
- `reproducible-from-git` `sha256:822d9efe694b` — Reproducible From Git

## Verdict

1. Так: attempt #1 провалився — не як повна відсутність коду, а як неповна міграція control-plane contract, що двічі допустила зупинку, outage і false green.
2. Не restart на OLD і не continue-as-is: зберегти NEW repo та вирізати/перебудувати його execution core як визначений hybrid.
3. Keep NEW: instruction composition, decisions/workboard, review/landing gates, SQLite leases/events, isolated worktrees та tracked install/drift discipline.
4. Gut NEW: 4318-line `daemon/server.ts`, tmux-centric recovery, one-lane/manual wave launcher і state model без manager/progress-generation/deadline/artifact evidence.
5. Port from OLD selectively: provider-agnostic dispatch lifecycle, manager→lane ownership/status, terminal lane reports, zero-commit detection, mission continuity and operator fleet view — not OLD product monorepo/history.
6. Three levels fit the NEW repository boundary but not its current launcher/state: implement orchestrator→manager→lane as durable entities; 10–12 is a capacity ceiling/floor policy, not twelve immortal processes.
7. Attempt #2 remains `NO-GO` until clean-clone restart, daemon/channel failure, launcher-death, stalled-manager, zero-commit and fail-before/pass-after landing rehearsals all pass at one reviewed SHA.

## Exact subjects

- NEW reviewed SHA: `7f15e7bd1491c7119e41f1ee541596b709beb4e6` (`origin/main` is the same SHA).
- OLD donor SHA: `d0a99b8439f2731654e23b5e7759961f4602d0d3`; rescue snapshot inspected at `5c8206be024f49538696d6237021ce4e4a70b5ca` (`origin/rescue/vm-final-20260728`).
- Independence: `consilium2-architecture`, reviewer-only lane; no implementation authored and OLD was read-only.
- Tier: A — orchestrator core, evidence gate, restart/recovery, cleanup and infrastructure architecture.

## Why attempt #1 failed

The incident evidence is decisive. `reports/hist-telegram-new-2026-08-02.md` proves the second night had no Telegram delivery event or lane-log activity for 7h41m and that dispatcher, low-fleet nudge, keepalive/watchdog and external backstop produced neither work nor a truthful alarm. `reports/consilium-process-2026-08-02.md` additionally records `running=0` with open work and a 7h47m nudge-log blackout, plus tracked/runtime drift where the liveness timer was absent. These are control-plane acceptance failures, irrespective of how many components exist.

The launcher regression is architectural evidence, not merely one typo. `git log -- orchestrator/launch.sh` shows repeated fixes across singleton, readiness, daemon-cgroup isolation, heartbeat and watchdog behavior. Commit `5856f467` documents the concrete inherited-fd deadlock class: the singleton descriptor reached tmux/liveness descendants, so a dead provider could leave a kernel lock behind. The current fix explicitly closes descriptors and adds bounded handoff/acquisition; that is useful code, but the recurrence demonstrates that process ownership and recovery were not modeled/tested end-to-end before cutover.

## NEW: what is sound and what must be replaced

### Keep

- `tools/instructions/compose.ts`, `tools/instructions/dispatch-check.ts`, `instructions/`, and `instance/decisions/`: pinned role packs, verbatim capture/routing and fail-closed dispatch are genuine additions absent as a coherent generic layer in OLD.
- `gate/land.sh`, `gate/land-lib.sh`, `gate/review-policy.conf` and the gate regression suites: review routing, canonical secret scan and integration verification belong in attempt #2. They require clean-clone evidence-gate rehearsal, not deletion.
- `core/state.ts`: SQLite WAL, transactional transitions, audit events and fencing leases are the correct substrate.
- `orchestrator/fleet/launch-lane.sh`: compose→marker gate→isolated worktree→system transient unit is a good narrow primitive. `bootstrap/deploy-host-mechanism.sh` and drift checks support the meteorite rule.

### Gut/refactor

- `daemon/server.ts` is 4318 lines and mixes HTTP/MCP/Telegram transport, commands, media, permission replies, mission input, attachments and provider delivery. OLD `tools/claude-telegram-daemon/server.ts` is similarly worse at 3974 lines; copying it would preserve the same coupling. Split transport/adapters from command routing, mission service and outbox delivery, with crash isolation between them.
- `orchestrator/fleet/launch-lane.sh` launches exactly one lane and records no durable manager ownership or completion into `core/state.ts`. `orchestrator/dispatch-lane.sh` itself admits its default is gate-only. The checked-in `as-run-wave*.sh` files are historical manual transcripts, not a scheduler.
- `core/state.ts` has only `missions`, direct child `lanes`, leases and events. It has no manager entity, parent/child depth, required role, acceptance row, deadline, progress generation, terminal report path/SHA, review disposition or retry budget. Process heartbeat can therefore masquerade as mission progress.
- `orchestrator/fleet/fleet-nudge.sh`/liveness are explicitly STOPGAP and tmux injection cannot be authoritative recovery. Supervisor decisions must consume durable semantic progress and use an independent delivery path.

## OLD: donor value and rejection boundary

OLD proves mechanisms existed that attempt #1 did not carry over. `tools/claude-telegram-daemon/status-collector.ts` models active managers, manager-owned lanes, manager heartbeat/status files, terminal lane reports, stale/dead counts and zero-commit exits; its formatted status renders the hierarchy. `launch-orchestrator.sh` in rescue SHA `5c8206be` directs a provider-agnostic dispatcher, up to 15 lanes, commit-count validation, mission-inbox continuity and a direct Telegram fallback. `orchestrator-fleet-ping.sh`, hourly compact and maintenance audit show independent cadence hooks.

But OLD is not a sound base wholesale: the daemon/status collector total thousands of coupled lines, the rescue history/backlog records cgroup-killed children, stale lane reports, dispatcher hydration/path bugs and zero-commit false outcomes, while the donor exposes a very large remote-branch tail and embeds product files. Its cron/tmux nudges also use `|| true` and prove delivery of keystrokes, not progress. Port contracts and regression fixtures after source inventory; do not copy the tree or its runtime state.

## Attempt #2 target architecture

1. **Durable hierarchy:** extend the NEW store to `mission → manager → lane`, with parent id, role/persona, generation, acceptance ids, deadline, retry budget, terminal artifact SHA/report and review verdict. Every mutation is fenced and audited.
2. **Scheduler:** one top orchestrator owns intent/landing/reporting; 10–12 standing slots are leased capacity. It starts enough managers/lanes for ready independent rows, replenishes on terminal events, and loudly reports insufficient ready work below the configured floor. Managers may spawn only bounded child lanes and cannot land their own work.
3. **Process topology:** daemon transports, scheduler, provider sessions, lane units and supervisor use separate service/cgroup failure domains. No recovery lock is inherited; provider readiness and death use PID+starttime/lock identity. Restarting Telegram must not kill scheduler/managers/lanes.
4. **Channel/outbox:** inbound Telegram is durably mirrored before acknowledgement; outbound messages have idempotency id, attempt/delivery state and an independent Bot-API escalation route. `/status` reads the durable hierarchy and labels degraded/unknown honestly.
5. **Evidence gates:** parity inventory maps every OLD capability to `ported`, `rejected-with-reason`, or `pending`; no silent disappearance. Each failure class gets named red-before/green-after locks, and Tier-A changes receive separate security, operations/runtime and tests passes on the same SHA.
6. **Cutover:** restore from clean clone, install only tracked units/config, compare host drift, then rehearse provider crash, leaked-lock predecessor, daemon restart, channel outage, stalled/zero-commit child, supervisor retry/escalation, landing/rollback and teardown. Only then run an unattended overnight soak with morning artifact accounting.

## Review finding

Verdict: `NO-GO` for landing/cutover of attempt #2 today. The NEW repository is the right generic shell, but its current execution core does not implement the Human's three-level team or semantic-progress recovery, and the existing incident reports leave required Tier-A runtime/deployment evidence open. Next bounded action: write and gate a capability-parity matrix plus the durable hierarchy/state schema before porting any OLD implementation.

commit: 7f15e7bd1491c7119e41f1ee541596b709beb4e6 consilium2-architecture consilium opinion
verify: git rev-parse HEAD; git status --short; git -C /root/legacy-donors/bpa-master rev-parse HEAD; git -C /root/legacy-donors/bpa-master log -1 --format='%H %s' origin/rescue/vm-final-20260728; wc -l daemon/server.ts orchestrator/launch.sh core/state.ts tools/state-contract/check.ts /root/legacy-donors/bpa-master/tools/claude-telegram-daemon/server.ts /root/legacy-donors/bpa-master/tools/claude-telegram-daemon/status-collector.ts; sed -n '1,180p' orchestrator/fleet/README.md; sed -n '1,180p' orchestrator/fleet/launch-lane.sh; sed -n '1,220p' core/state.ts; git log --oneline --all -- orchestrator/launch.sh; git log -p -S'flock' --all -- orchestrator/launch.sh; rg -n 'manager|lane|zero-commit|commits=0' /root/legacy-donors/bpa-master/tools/claude-telegram-daemon/status-collector.ts; sed -n '1,180p' reports/hist-telegram-new-2026-08-02.md; sed -n '1,220p' reports/consilium-process-2026-08-02.md
result: NO-GO
secret-scan: clean
remaining: none
