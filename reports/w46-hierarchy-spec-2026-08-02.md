# W-46 review — three-level hierarchy specification

reviewer: Codex reviewer lane `ag-w46-hierarchy-spec`, independent of the v3 authoring lane
independence: separate reviewer worktree/session; no authorship of reviewed `origin/v3` SHA
tier: Tier A (orchestrator core, leases, cleanup, evidence gate)
reviewed-sha: 99db22d5bda00381653b9fd9da5c2c5de5d7a882 (`origin/v3`)
base-sha: f866b0ef96168ff887a7992fd82fcb46b8b237e7
donor-sha: d0a99b8439f2731654e23b5e7759961f4602d0d3 (`/root/legacy-donors/bpa-master`)
scope: specification only; no runtime implementation
verdict: ACCEPT (specification); implementation remains NO-GO until the gaps and Tier-A executable locks below land

## Consumption check

- review-policy sha256:6537ef28ad14 (baseline) # Review Policy
- verification-and-locks sha256:b6f8862a801d (baseline) # Verification and Regression Locks
- roles sha256:cd4c40c4e640 (baseline) # Roles
- instruction-layers sha256:cd21f4ce0990 (baseline) # Instruction Layers
- tool-permissions sha256:955630cc416e (baseline) # Tool Permissions
- reproducible-from-git sha256:822d9efe694b (baseline) # Reproducible From Git

## Source inventory and disposition

- Binding inputs: `instance/decisions/HR-1374.md` defines level 1 orchestrator, a hard-maintained 10–12 level-2 fleet, and selectively permitted level-3 delegation; `instance/decisions/HR-1430.md` permits Codex coder/agent parents to use cheap API juniors only for draft-grade work and parks that provider until paid-quota infrastructure is stable and measured first.
- OLD donor: `docs/concepts/CONCEPT_orchestration_fleet_architecture.md` specifies the approved `1 -> 3 -> 9` ceiling, manager-owned bounded workers and proof compression. `tools/orchestrator/dispatch-agent.sh`, `launch-manager-pilot.sh`, `manager-wait-lanes.sh`, and `prompts/manager-pilot-system.md` provide mission ownership, bounded dispatch, foreground waiting, heartbeat, terminal lane reports and proof-bearing rollups. The concept's D-007 explicitly requires the reliability substrate before hierarchy; neither the concept nor these one-generation scripts proves a recursive three-level keeper. They are behavioral donors, not code to import blindly.
- LANDED v3 at `99db22d5`: `core/schema.ts` durably represents mission → manager(depth 1) → lane(depth 2), generation, owner lease, fencing token, acknowledgement, semantic evidence and terminal proof. `orchestrator/dispatcher.ts` persists process identity before release, adopts authentic persisted intents after dispatcher restart, kills identified pre-persist intents, fences stale owners and fails invalid/missing terminal evidence. Its tests exercise the spawn-to-record kill and post-persist adoption windows. These mechanics are the required substrate for every level-3 child.

## Five contract lines

1. **Topology and spawn rights.** Level 1 `orchestrator` may create/replace level-2 standing lanes but may not bypass them to manufacture level-3 work; level-2 `manager` may spawn bounded level-3 coder, tester, diagnostic and reviewer children; level-2 `coder/agent` may spawn only bounded draft/triage/scaffold juniors, with cheap-API children disabled while HR-1430 remains parked; level-2 `reviewer`, `integrator`, `watchdog/status`, and every level-3 child have `spawn=deny`. Every allowed spawn goes through the same dispatcher with an explicit `parent_id`, `root_mission_id`, role/capability, depth exactly 3, per-parent cap, global cap, scope/denylist and acceptance id; unknown roles/capabilities fail closed.
2. **Level-3 lease, cleanup and evidence.** A child has its own generation, fencing token, owner lease, process identity/intent, acknowledgement, semantic-evidence path and terminal report, plus a parent-generation token; parent terminality, lease expiry, fencing/replacement or cancellation atomically fences all non-terminal descendants, then the reconciler authenticates PID/start-time/command identity, sends TERM then KILL, waits for confirmed absence, reaps child worktree/unit/runtime state under policy, and records terminal `NO-GO`/cleanup evidence before the parent may finish. Children die with parents: an absent, mismatched or unverifiably dead process is `UNMEASURED`/`NO-GO`, never orphaned success. This extends v3 dispatcher intent persistence/adoption: persisted authentic children may be adopted only while both child and parent-generation leases remain live; pre-persist, stale-parent or identity-mismatched intents are terminated, never adopted.
3. **Hard 10–12 maintenance and truthful progress.** A singleton durable keeper continuously measures level-2 slots from schema state *and* authenticated live process identity: target is configurable within 10–12 and the observed count must stay in that band except a bounded replacement grace window; below target it leases and starts eligible queued work or an explicitly useful standing maintenance task, above maximum it refuses spawn and safely drains excess. Slot occupancy, acknowledgement/heartbeat, and semantic progress are separate: a live PID or heartbeat does not count as progress; progress requires new externally verifiable evidence tied to the current fencing token and acceptance row. Missing/stale evidence, an unavailable measurement boundary, or inability to refill is surfaced as `UNMEASURED`/`NO-GO` with deficit and age—never green, never synthetic busywork, never a silently smaller fleet.
4. **Delegation description supplied by the orchestrator.** Every spawnable parent receives this required template and must materialize it before dispatch: `why delegation is necessary; parent mission/acceptance row; child role and bounded objective; allowed/denied paths and tools; expected artifact plus exact verification command; lease/timeout/retry budget and per-parent/global slot cost; progress evidence and terminal report path; cleanup/rollback action; aggregation rule (how the parent validates and compresses child proof); escalation condition`. Missing or vague fields deny spawn; delegation never transfers the parent's responsibility for scope, review tier, evidence validity, child cleanup or final verdict.
5. **Schema/dispatcher implementation gap gate.** Before level 3 is enabled, v3 must add a generic node/child record (or explicit child table) supporting depth 3, role/capability and provider policy, root/parent ids plus parent generation/fencing, per-parent/global counters with transactional reservation, child leases and cancellation cascade, durable cleanup state/evidence, and upward proof aggregation; the dispatcher must enforce spawn authorization and caps, recursively reconcile/adopt only live-parent children, kill and prove absence of every descendant on parent death/replacement, and run the durable 10–12 keeper with semantic-progress measurement. Required Tier-A locks: unauthorized/depth-4/parked-provider spawn fails; concurrent cap race cannot exceed limits; parent crash in every intent window leaves zero child processes/worktrees/units; stale parent/child tokens cannot report; restart adopts only authentic eligible descendants; terminal parent waits for child terminal+cleanup proof; keeper deficit/excess and unmeasured progress fail closed; clean-clone recovery reconstructs the hierarchy and reruns teardown/rollback. Until all locks show fail-before and pass-after at one reviewed SHA, runtime hierarchy status is `NO-GO`.

## Findings

- No contradiction between HR-1374 and the OLD donor: the donor ceiling supplies manager grouping, while HR-1374 changes the standing level-2 width to a hard 10–12 and permits one bounded child generation.
- HR-1430 is not authorization to implement or enable a provider now. The matrix reserves a narrow capability, defaults it off, and requires measurement of in-quota tiering before W-47 can unpark it.
- The v3 dispatcher has the correct single-lane intent/adoption mechanics to generalize, but current `depth` checks and SQL constraints categorically reject level 3. Claiming the hierarchy is already implemented would be false green.
- Rollback posture: feature flag/default-deny level-3 spawning; disabling it stops new children, drains or cancels existing descendants through the same cascade, proves zero live identities, then leaves the existing level-2 v3 path intact. Schema migration must be additive/reconstructible and tested against a pre-feature database.

## Review evidence

Commands inspected the exact refs and donor checkout: `git show origin/v3:core/schema.ts`, `git show origin/v3:orchestrator/dispatcher.ts`, `git show origin/v3:orchestrator/dispatcher.test.ts`, the two HR files, the donor concept, manager prompt and launcher/wait/dispatch entry points. No implementation or runtime claim was accepted from narrative alone.

remaining: implement the five gap-gate groups on a new coder lane, capture fail-before/pass-after locks, then obtain independent Tier-A diff review before landing
