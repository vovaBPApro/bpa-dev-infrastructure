# Architectural recurrence-prevention plan

Date: 2026-08-01

Status: proposed, non-binding until independent architectural review

Scope: generic self-hosting control-plane architecture; no runtime change is authorized by this document

## Human requirement (verbatim)

> Підніми ще якогось потужного агента,
>
> який проаналізує всю цю поточну ситуацію
>
> і зробить план, як цього більше не допустити.
>
> Бо ти зараз фіксиш, стабілізуєш,
>
> а нам треба ще структурний архітектурний план якісний,
>
> як такого лайна більше не захистити, не допустити.
>
> Бо якщо це сталось раз,
>
> це може повторитись ще знов і знов,
>
> і знов просто з інших причин.

## Verdict and design rule

The collapse was systemic, not a single bad restart. Communication, orchestration,
observation, restart, and alert delivery shared processes, cgroups, session input,
and mutable host state. A daemon restart therefore killed its supervisor; an alert
returned through the supervised pane and became a new alert; a restart silently
re-enabled a deliberately disabled watcher; provider exits, external kills, and
daemon cascades initially looked alike; and fixes could be landed, deployed, or
running without those three states agreeing.

The governing invariant is: **no component may observe, recover, or communicate
about a failure from the same failure domain or feedback channel that it
supervises.** Promotion is one-way: candidate -> reviewed commit -> canonical
merge -> declared deployment -> observed runtime identity. No later state may be
claimed from evidence belonging to an earlier state.

This plan is deliberately generic. Product names, host paths, message IDs, and
current candidate SHAs appear only in the evidence appendix.

## Minimal target topology

```text
                         independent operator channel
                                    ^
                                    |
                  +-----------------+-----------------+
                  | Comms gateway (small, durable)    |
                  | inbox/outbox ledger; no lane exec |
                  +-------------^---------------------+
                                | signed/typed events only
              failure domain A  |                 failure domain B
  +-----------------------------+--+       +-----------------------------+
  | Recovery supervisor            |       | Orchestrator session         |
  | OS-owned singleton + lease      |------>| dispatch/land/rollup only    |
  | reads journal/identity/heartbeat|       | never owns its supervisor    |
  +---------^----------------------+       +----------+------------------+
            | health, never rendered chat                         |
            |                                            typed mission events
  +---------+----------------------+                    +---------v---------+
  | Observation/alarm evaluator   |                    | isolated lane units|
  | append-only event journal     |                    | own cgroup/tmp/db   |
  | dedupe + escalation state     |                    +-------------------+
  +--------------------------------+
```

The gateway, supervisor, observer, and orchestrator have distinct OS units,
cgroups, restart policies, writable directories, identities, and bounded APIs.
The supervisor and gateway are installed by the host/service manager, not spawned
by the orchestrator or daemon. At least one alert sink is outside the supervised
host and does not traverse the orchestrator pane. The pane may display a copy of
an event, but it is never detector input. The gateway can report durable state
while the orchestrator is absent, but cannot mutate product/runtime state.

## Failure-class control matrix

| Failure class | Invariant | Detection signal | Containment boundary | Automatic recovery | Human escalation | Executable failure injection | Deploy / rollback evidence | Exact owner/component |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Provider quota/API exit vs external kill vs daemon restart | Every session termination has one durable, mutually exclusive cause record: clean/provider, signal with sender, OOM/cgroup, parent-unit stop, or unknown. Unknown is not guessed. | OS service result, wait status, cgroup/OOM journal, signal audit, provider response class, daemon unit transaction ID, transcript end marker correlated by boot/session ID. | Session is outside daemon and observer cgroups; provider adapter is replaceable and cannot own the lease. | Supervisor applies class-specific backoff: quota switches only to an approved provider route; transient API retries with jitter; signal/OOM restarts once after resource check; parent-unit restart must not touch session. | Immediate on unknown, OOM, forbidden cross-cgroup kill, exhausted budget, or repeated class threshold; include cause bundle ID. | Stub provider returns 429/5xx/clean EOF; send SIGTERM/SIGKILL from a named disposable unit; pressure a disposable cgroup; restart a fake daemon parent. Assert distinct cause records and policy. | Candidate SHA + independent review; detached disposable-host rehearsal; observed cause record; rollback restores prior launcher and proves gateway/supervisor remain reachable. | `session-supervisor` + `provider-adapter`; OS service manager owns processes. |
| Shared-cgroup/cascade failure | Restarting any leaf leaves gateway, supervisor, observer, and orchestrator alive; stopping a parent cannot collect a sibling. | Startup asserts cgroup/unit identity and parentage; continuous topology drift check; restart transaction correlated with survivor heartbeats. | One unit/cgroup per role; no daemon-spawned tmux/session; lanes cannot invoke shared-unit restart. | Supervisor recreates only the failed leaf and fences duplicate identity. | Any survivor heartbeat gap or parentage drift; planned shared restart requires maintenance notice. | Disposable daemon-like unit launches its own child, then restart/kill it while independent session/gateway exchange nonce messages. | Pre/post cgroup tree, same-session identity, gateway round trip, zero sibling deaths/orphans; rollback rehearsal stops new scopes and restores old unit without losing comms. | `unit-installer`, `session-supervisor`, permission broker. |
| Self-observation feedback (alert echo) | Detector input is machine events from journal/OS/provider only; no rendered alert, chat injection, pane text, or detector vocabulary can return to detector input. Directed alert graph must be acyclic. | Static route-graph cycle checker; runtime event lineage/hop count; duplicate/content-rate circuit breaker; detector-source allowlist. | Observer has read-only event sources and write-only outbox; gateway delivery does not write observer inputs; pane scraping is prohibited for alarms. | On cycle/rate breach, open circuit, preserve journal, continue health supervision, deliver one summary through independent sink. Never auto-rearm a tripped route. | First cycle, route drift, or breaker trip immediately; re-arm requires reviewed config and announced action. | Feed every emitted line, truncation, quote, TUI chrome, CR/LF transform, adversarial nonce, and genuine adjacent failure back into every declared source. Property test proves no lineage returns. | Route DAG artifact + adversarial fixtures + live-format replay; deploy with route disabled, observe, enable one-way sink; rollback disables route without restarting supervisor. | `event-observer` owns classification; `alarm-router` owns DAG/breaker; gateway owns delivery only. |
| Watchdog restart, retry, alert, singleton | Exactly one fenced supervisor evaluates health; retry state survives its restart; health, restart, and delivery verdicts are separate; success requires acknowledged delivery or durable queued evidence. | OS singleton/lease identity, monotonic attempt ledger, heartbeat freshness from independent writer, acknowledged outbox receipt, duplicate-process alarm. | Supervisor cannot write the heartbeat it judges; restart executor is a narrow broker; alarm sink is independent of target and observer. | Bounded exponential backoff, attempt budget, cooldown keyed by failure signature, singleton fencing; exhausted recovery parks target instead of looping. | First failed recovery, unavailable independent channel, duplicate singleton, retry-budget exhaustion, or watchdog heartbeat loss. | Kill watchdog between decision and write; corrupt/stale lease; run two instances; make restart fail; make Telegram/API timeout/ack disappear; reboot between attempts. | Red/green race fixtures, state persistence across restart/reboot, exactly-once recovery claim, acknowledged alert, clean rollback with old state schema compatibility. | `recovery-supervisor`, `restart-broker`, `alarm-outbox`; external service manager enforces singleton. |
| Human transport vs language/content | Transport acknowledgement, durable capture, reply correlation, operator language, and semantic completion are five distinct fields; none implies another. | Inbound/outbound IDs and hashes, pending-reply age, locale/content policy check, delivery ack, mission/decision linkage. | Gateway stores append-only envelopes; orchestrator consumes typed directives asynchronously; fallback transport does not share orchestrator session. | Retry idempotently by message key; fall back to approved independent sink; queue while orchestrator is down; never fabricate `answered` from dispatch/spec/review. | SLA breach, wrong locale, unlinked directive, semantic `NO-GO`, or both transports unavailable. | Drop/delay/duplicate/reorder acks; malformed Unicode; orchestrator absent; wrong-language fixture; delivered reply with unresolved acceptance row. | Two-sided replay with exact IDs/hashes, restart persistence, locale check, unanswered ledger zero; rollback preserves queue format and does not double-send. | `comms-gateway` transport; `directive-ledger` capture; rollup owner content. |
| Self-hosting drift: local main, candidates, deployed code | Running identity is an ancestor of canonical remote main and equals a declared deployment record; candidate/review reports never count as landed or deployed. | Scheduled remote/local/deployed SHA and unit/template/config digest reconciliation; dirty-tree and untracked operating-script scan. | Immutable release directories; canonical tree alone lands; host runtime files generated from tracked templates plus enumerated secrets. | Drift guard disables mutation/restart actions, keeps read-only comms, and offers only an idempotent reviewed redeploy of the declared SHA. | Any mismatch immediately with four identities: remote, local, declared, observed; no `clean` while divergent. | Run old binary, local-only commit, edited unit, missing template, dirty release, candidate-only SHA; assert fail-closed and no restart. | Gate provenance, full incoming-range secret scan, canonical post-merge verify, release manifest, observed build SHA/digests, rollback to previous declared manifest. | `landing-gate`, `deployment-controller`, `drift-guard`. |
| Fleet collapse, silent stalls, lost mission visibility | Every accepted Human directive maps to one durable mission and acceptance rows; every lane has a lease/heartbeat/terminal report; fewer than configured minimum lanes is an explicit capacity event, not silence. | Durable mission event log, lane/service identity, independent heartbeat, acceptance-row aging, fleet count and resource saturation metrics. | Mission state is outside sessions/worktrees; lane death cannot erase prompts/evidence; rollup has one owner. | Reconstruct from event log; requeue idempotent open rows; reap only terminal landed lanes; park repeated failures with evidence. | Immediate below capacity floor while open work exists, unknown lane, stale row, or lost rollup; report numeric running count and tasks. | Kill orchestrator and lanes mid-write; truncate session transcript; reboot; lose worktree; duplicate completion; corrupt event tail. Replay must reconstruct identical state. | Before/after state digest, replay proof, exact terminal SHAs/commands, canonical verify, cleanup inventory. Rollback maintains event-schema reader. | `mission-ledger`, `fleet-controller`, rollup owner. |
| Shared-host test fixture damage/leak | Tests cannot address live units, sockets, databases, tmux servers, runtime directories, or default credentials; destructive integration runs only on disposable host/VM with deny-by-default capabilities. | Preflight resolves every target and proves namespace/prefix/owner; egress and system-bus policy audit; post-test leak/resource inventory. | Dedicated VM/container/systemd user, unique unit/socket/tmp/runtime/db namespace; scrubbed environment; no live service-manager or loopback-production access. | Trap plus external reaper removes all owned resources; TTL cleanup is a backstop, not proof; unsafe preflight refuses without cleanup. | Any unresolved target, live-prefix collision, orphan, forbidden access, or host/session death; quarantine test immediately. | Canary live names/sockets must remain untouched; crash test at every lifecycle phase; inject unbound HOME/missing deps; run parallel fixtures and reboot. | Red proof against unsafe harness, green in disposable environment, zero before/after resource delta, teardown and rollback logs. | `test-stand-controller` + `resource-reaper`; test author never grants capabilities. |
| Branch/worktree/resource accumulation | Every resource has mission, owner, created-at, TTL, base/source SHA, state, and safe disposition; only landed accepted resources are auto-reaped. | Git/worktree/unit/container/tmp inventories joined to ledger; unowned/stale/orphan alerts; disk/inode pressure. | Per-mission namespace and quotas; canonical tree excluded from reaper; protected/unmerged refs retained with reason. | Reap terminal landed resources after evidence preservation; quarantine unowned resources; never infer merge from matching content alone. | Stale protected/unmerged resource, quota pressure, ambiguous ownership, or cleanup failure. | Create merged/unmerged/protected/dirty worktrees, leaked scopes/containers/tmp dirs, same-SHA branches; assert only provably safe targets removed. | Dry-run manifest, independent cleanup review, post-inventory, recoverability of retained refs; rollback restores metadata, not deleted unmerged work. | `resource-registry`, `safe-reaper`, landing gate. |

## Hard acceptance gates

1. **G0 — Evidence identity.** A termination taxonomy and correlation bundle can
   distinguish injected provider exit, external signal, OOM, and parent restart.
2. **G1 — Failure-domain separation.** Restarting daemon, gateway, observer, or
   orchestrator in a disposable stand leaves the other three alive; process and
   cgroup assertions are machine checked.
3. **G2 — Acyclic alarms.** A generated graph has no route from any alarm output
   to any detector input. Full live-rendering replay and arbitrary truncations
   cannot produce a second event. A breaker is proven independently.
4. **G3 — Recovery truth.** One fenced supervisor persists attempts over its own
   restart, never writes its judged heartbeat, never loops beyond budget, and
   records restart and delivery as separate verdicts.
5. **G4 — Communication survival.** With orchestrator and primary provider down,
   inbound capture and outbound acknowledged status remain available in the
   operator language; semantic `NO-GO` remains visible.
6. **G5 — Promotion truth.** Remote-main, local-main, candidate, declared deploy,
   and observed runtime identities are reported separately; every mismatch blocks
   `clean` and mutation.
7. **G6 — Durable fleet replay.** A cold process reconstructs the exact mission,
   row, lane, and terminal-evidence state after kill/reboot and reports numeric
   capacity below the configured floor.
8. **G7 — Safe test boundary.** Host canaries survive every fixture and injected
   abort; zero owned scopes, processes, sockets, containers, worktrees, and temp
   paths remain.
9. **G8 — Resource lifecycle.** Inventory is ownership-complete; safe reaping is
   independently reviewed and proves retention of dirty, protected, and unmerged
   work.
10. **G9 — Meteorite rebuild.** A clean supported machine, using only a remote
    clone plus enumerated secrets/instance inputs, installs dependencies and all
    units, boots the minimal topology, passes G0–G8 in disposable mode, exchanges
    an operator round trip, and reproduces declared digests. `SKIP` at a required
    runtime boundary is failure.

No gate accepts a lane narrative. Required evidence is executable at the exact
reviewed SHA, rerun after canonical merge, then repeated against the deployed
identity. Risky gates require an independent architectural/reliability reviewer.

## Staged implementation order

1. **Freeze and classify.** Keep hazardous feedback routes off. Land termination
   cause records, correlation IDs, route inventory, resource inventory, and the
   candidate/deployed identity surface. No topology change yet.
2. **Build the independent safety spine.** Install the durable event journal,
   fenced supervisor, restart broker, and append-only outbox in separate units.
   Pass G0 and G3 without controlling live services.
3. **Break the cascade.** Move the orchestrator session outside daemon ownership,
   remove restart capability from lanes, and prove G1 in a disposable host.
4. **Break the feedback loop.** Replace pane classification with typed event
   sources, compile and verify an acyclic alert DAG, add circuit breaking, then
   pass G2. An inert display copy may follow delivery.
5. **Separate communications.** Introduce the small gateway and directive ledger;
   pass G4 before removing any legacy route.
6. **Make state promotable and replayable.** Enforce G5/G6 and immutable deploy
   manifests; only then allow automatic recovery to redeploy.
7. **Isolate destructive tests and resources.** Move host-affecting suites to
   disposable stands, install the registry/reaper, pass G7/G8.
8. **Rebuild and soak.** Execute G9, then the soak/chaos matrix. Only an
   independently reviewed plan and green gates may become binding operations.

## Maintenance-boundary procedure

1. Open one tracked boundary record: purpose, exact reviewed candidate, current
   and rollback manifests, owner, start/deadline, expected operator impact.
2. Announce through the independent channel and receive acknowledgement when the
   boundary can interrupt communication. Stop new dispatch; let safe lanes reach
   durable checkpoints. Record numeric fleet state.
3. Verify remote/local/candidate/deployed identities, clean canonical tree,
   independent review, complete-range secret scan, backup/restore proof, free
   resources, and an independently reachable supervisor/gateway. Any mismatch
   aborts before mutation.
4. Arm read-only capture first: journal, signal/OOM attribution, unit/cgroup tree,
   outbox, and rollback observer. Do not arm a detector route that can feed itself.
5. Run the risky rehearsal detached in a disposable failure domain. If it touches
   the live host, use a predeclared target allowlist and external supervisor; a
   session death must not erase evidence or communication.
6. Deploy one change, verify its exact observed identity and gate, and pause on
   contradiction. Never combine an unexplained failure with the next change.
7. Roll back automatically on deadline, health failure, identity mismatch,
   survivor loss, duplicate singleton, or unavailable alert channel. Rollback is
   incomplete until prior identity and communication are observed.
8. Close with before/after inventories, operator round trip, no orphan resources,
   evidence links, and explicit `clean` or `NO-GO`. Re-enable routes only as a
   separate announced action after soak.

## Soak and chaos matrix

| Scenario | Cadence / duration | Required observation | Pass condition |
| --- | --- | --- | --- |
| Provider 429, 5xx, clean EOF, malformed stream | each build; 1,000 randomized sequences | cause ledger, bounded retry, operator status | exact class, no cross-provider switch outside policy, no duplicate mission |
| SIGTERM/SIGKILL/OOM and daemon restart | each build in disposable VM; nightly 24h | sender/cgroup/result, survivor heartbeats | G0/G1; gateway and supervisor uninterrupted |
| Watchdog crash/race/reboot | each build; 10,000 state-machine schedules | singleton, persisted attempts, ack ledger | at-most-one recovery lease; bounded attempts; no lost alert |
| Alert echo transformations | property test each build; 24h shadow stream | lineage/hop count, breaker | zero output-to-input paths; real foreign failures still detected |
| Transport faults and orchestrator absence | each build; weekly 4h outage | inbox/outbox hashes, locale, pending SLA | no loss/double-send; Ukrainian status; semantic state honest |
| Drift permutations | each build; daily deployed check | five promotion identities and digests | every mismatch blocks mutation and `clean` |
| Fleet/session/reboot loss | nightly replay; weekly host reboot | state digest and numeric capacity | identical durable rollup; open work requeued once |
| Fixture aborts and parallel collisions | each host-affecting suite; 100 abort points | canaries and resource delta | no live access and zero leaks |
| Resource aging/pressure | daily dry run; weekly reviewed reap | owned/unowned/retained inventory | only provably landed terminal resources reaped |
| Full topology soak | 72h before live promotion, then 7d monitored | all SLOs, zero unknown causes/cycles/drift | no unknown termination, circular event, silent stall, or orphan |

## Candidate-to-gate disposition

Current candidates are inputs, not completion:

- The W-31 scoped-session chain (`d790bc1`, `a3ad228`, round-3 review
  `041fe6e`, round-4 `71b8770` + evidence `0648138`) targets G1. It cannot close
  G1 while its shared-host rehearsal is prohibited/unexecuted and sibling-scope
  cleanup remains part of the candidate. Run only at the maintenance boundary
  after G2 protection, in a disposable/scrubbed environment.
- W-33 landed rounds through `9afd5cd` close known string/nonce echo paths but
  explicitly leave payload reclassification. They are regression fixtures for
  G2, not architectural closure.
- W-37 alert-routing candidates provide journal-first routing and hardened nonce
  handling. They can help close G2 only after an independent review proves the
  whole route graph is acyclic and the live detector no longer consumes pane/chat
  rendering. A new work item is required for the typed event journal, DAG checker,
  hop lineage, and circuit breaker.
- The landed watchdog restoration/escalation and delivery fallback work
  (`0cc5215`, `3854864`, reviewed delivery candidate `a92e6b2`) supplies fixtures
  for G3/G4. New work is required to separate restart broker, observer, gateway,
  and external sink into distinct failure domains and to persist a fenced retry
  state machine.
- W-29 history logging (`d743a12`) supplies append-only transport evidence but
  does not close G4; new work is required for durable per-message semantic state,
  independent gateway availability, and locale/content gates.
- Existing drift/bootstrap work and the previous meteorite rehearsal are inputs
  to G5/G9. New work is required for one promotion manifest containing all five
  identities and for a no-SKIP clean-host topology rehearsal.
- Existing mission state and fleet nudges are inputs to G6. New work is required
  for event-sourced replay, duplicate-completion fencing, and explicit recovery
  after worktree/transcript loss.
- Existing lane isolation, disposable database, and reaper tests are inputs to
  G7/G8. New work is required for a disposable systemd-host harness, capability
  preflight, host canaries, abort-point matrix, resource registry, and independently
  reviewed ownership-based reaping.

## Meteorite rebuild verification

The rebuild runner must create a blank supported VM (a container without the
declared service-manager boundary is insufficient), clone the canonical remote
at an exact SHA, and supply only values enumerated in the instance onboarding
contract. It must install pinned provider CLIs/runtime dependencies, render and
enable all required units, prove four distinct cgroups/identities, initialize an
empty durable mission/event store, and boot with watchdog routes disabled by
tracked policy. It then runs G0–G8 against disposable targets, restarts the host,
replays state to the identical digest, exchanges one acknowledged operator
message while the orchestrator is stopped, verifies deployed digests against the
manifest, performs rollback and forward recovery, and reports zero unexplained
files, units, processes, containers, worktrees, or secrets. Required dependencies,
systemd, authentication, and runtime checks may not be `SKIP`; absence is
`NO-GO`. The proof bundle is committed or stored in a declared durable evidence
store referenced by a tracked manifest.

## Evidence basis and limitations

This plan used repository evidence and read-only inspection. It does not treat
unlanded candidates or historical lane claims as runtime truth. Where the record
cannot distinguish external kill from provider exit, it calls that an attribution
gap and makes closing that gap G0. No live service, watcher, timer, session,
credential, unit, or runtime file was changed while producing this plan.

## Instance-specific evidence appendix

- Telegram inbox messages 795–1024: msg 795 proposed splitting communication
  from orchestration; msg 800 parked premature redesign; msgs 811/812 asked why
  it fell and how it recovers; msgs 817/820 reported three losses in an hour;
  msgs 843/844/846 called the next event the sixth; msg 890 reported 12% provider
  quota; msgs 908/914/987 identify injected terminal-alert feedback; msgs
  923/925/927 ask whether the watcher returns and what alarms mean; msgs
  957/963/998 report broken Telegram delivery; msg 989 warns it could remain dead
  half a day unnoticed; msgs 1018/1020 distinguish durable instruction capture
  and Ukrainian replies. Source: ignored local primary inbox
  `instance/decisions/inbox.jsonl` lines 281–364 in the installation's canonical
  worktree, corroborated by `reports/telegram-history-audit-2026-08-01.md` and
  `instance/workboard.md`. No raw inbox content is copied into this tracked plan.
- W-29 proves tracked history code was not live until restart; the restart exposed
  W-31. W-31 records the daemon cgroup cascade, 14 headless minutes, ambiguous
  later deaths, zero captured external signals in one death window, unsafe host
  rehearsal, and leaked sibling scopes. Source: `instance/workboard.md`.
- W-33 records six self-echo ignitions, including approximately two alerts per
  second, TUI truncation, self-referential vocabulary, and the fact that restart
  re-armed a deliberately disabled watcher. W-37 is the architectural return-path
  work and was not closed by string suppression. Source: `instance/workboard.md`.
- Watchdog rows ML-3/ML-12 and associated reports show multi-signal liveness and
  an escalation ladder, while ML-7 and other open rows show alert-audience and
  visibility work is incomplete. Sources: `instance/workboard.md`,
  `reports/ag-ml12-escalation.coder.md`, and candidate/review reports under
  `reports/`.
- The incident timeline documents six live-stand failures caused by Git/runtime
  divergence: orphan schema state, unsafe migration rollback, non-idempotent
  repair, lost grants, missing configuration, and validator/live-data mismatch.
  Source: `reports/incidents-2026-08-01.md`.
- The overnight report records five production/Git divergences, eight independently
  found landing-gate bypasses, and live product SHA behind main. Source:
  `reports/overnight-2026-08-01.md`.
- Unit reconciliation found missing units and content drift; prior meteorite
  rehearsal exited zero while provider tools, Docker, user systemd, authentication,
  and the portable orchestrator boundary were absent or skipped. Sources:
  `reports/units-and-drift.coder.md` and `reports/meteorite-test.md`.
- Branch/resource evidence includes candidate-only SHAs, repeated rejected review
  rounds, orphaned scopes, accumulated refs/worktrees, and W-20's recorded 4/8
  lane conflict loss. Sources: `instance/workboard.md`, `reports/stack-postmortem.md`,
  and exact candidate/review reports under `reports/`.

## Instruction-pack consumption

- orchestrator-playbook sha256:2c5d9a8dc6b3 — Orchestrator Playbook
- orchestrator-fallback sha256:811f13bc3373 — Orchestrator Session Portability
- autonomy-and-capacity sha256:18c43aaf7e14 — Autonomy and Capacity
- landing-and-merge sha256:951d9781cffa — Landing and Merge
- roles sha256:cd4c40c4e640 — Roles
- instruction-layers sha256:cd21f4ce0990 — Instruction Layers
- reproducible-from-git sha256:822d9efe694b — Reproducible From Git

## Binding boundary

This is an architectural proposal. It becomes binding only after an independent
architectural review verifies the exact commit and executable gates, rejects
same-domain communication/recovery and circular alert routes, and the accepted
result lands through the canonical gate. Until then the result is `NO-GO` for
declaring recurrence prevention complete.
