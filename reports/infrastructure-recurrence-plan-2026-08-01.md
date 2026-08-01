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
                  outside supervised host/site failure domain
       +---------------------------------------------------------+
       | External sentinel + durable operator gateway            |
       | independent compute, kernel, service manager, storage,   |
       | credentials and transport; remote fence/rebuild API      |
       +--------------------------^------------------------------+
                                  | authenticated health/recovery
                                  | (secondary provider/channel)
                         supervised control-plane host
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

The on-host supervisor, observer, and orchestrator have distinct OS units,
cgroups, restart policies, writable directories, identities, and bounded APIs.
They contain leaf failures but do **not** constitute independence from kernel,
service-manager, host, or site failure. The external sentinel/operator gateway
runs on separately provisioned compute outside the supervised host and preferably
outside its site; it shares neither kernel, service manager, filesystem, power,
resource pool, credentials nor primary transport/provider. It owns remote health,
durable operator inbox/outbox, and a narrow infrastructure-provider fence/rebuild
API. It never dispatches lanes or mutates product data. If no independent compute
or recovery API is configured, host/site recovery is explicitly Human-only and
the system reports `degraded: external-recovery-unavailable`; it may not claim
automatic host recovery or G1/G4/G9 clean.

Failure-domain hierarchy and ownership are explicit:

| Layer supervised | Inside-domain control | Outside-domain detector/recovery |
| --- | --- | --- |
| Process | per-role unit, identity, bounded restart | on-host supervisor in a sibling cgroup/unit |
| Cgroup/unit | service-manager fencing and survivor checks | external sentinel observes host attestation; on-host sibling handles only leaf recovery |
| Service manager/kernel/host | no trustworthy self-recovery claim | external sentinel detects missed signed heartbeat and either fences/rebuilds through the narrow provider API or escalates Human-only |
| Provider/API | provider adapter classifies and backs off | sentinel uses a separately budgeted approved provider or reports Human-only degradation; no unapproved failover |
| Communication transport | local durable queue | external gateway uses an independent secondary channel/provider and preserves acknowledgements |
| Site/power/network | local components can only persist last-known state | sentinel in another site detects loss; remote rebuild where configured, otherwise explicit Human recovery |

The on-host supervisor is installed by the host/service manager, not spawned by
the orchestrator or daemon. The external sentinel/gateway is installed from the
same generic repository contract with instance-specific provider/channel values.
The pane may display an event copy, but it is never detector input.

## Failure-class control matrix

| Failure class | Invariant | Detection signal | Containment boundary | Automatic recovery | Human escalation | Executable failure injection | Deploy / rollback evidence | Exact owner/component |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Provider quota/API exit vs external kill vs daemon restart | Every session termination has one durable, mutually exclusive cause record: clean/provider, signal with sender, OOM/cgroup, parent-unit stop, or unknown. Unknown is not guessed. | OS service result, wait status, cgroup/OOM journal, signal audit, provider response class, daemon unit transaction ID, transcript end marker correlated by boot/session ID. | Session is outside daemon and observer cgroups; provider adapter is replaceable and cannot own the lease. | Supervisor applies class-specific backoff: quota switches only to an approved provider route; transient API retries with jitter; signal/OOM restarts once after resource check; parent-unit restart must not touch session. | Immediate on unknown, OOM, forbidden cross-cgroup kill, exhausted budget, or repeated class threshold; include cause bundle ID. | Stub provider returns 429/5xx/clean EOF; send SIGTERM/SIGKILL from a named disposable unit; pressure a disposable cgroup; restart a fake daemon parent. Assert distinct cause records and policy. | Candidate SHA + independent review; detached disposable-host rehearsal; observed cause record; rollback restores prior launcher and proves gateway/supervisor remain reachable. | `session-supervisor` + `provider-adapter`; OS service manager owns processes. |
| Shared-cgroup/cascade failure | Restarting any on-host leaf leaves supervisor, observer, and orchestrator siblings alive; stopping the host leaves the external gateway/sentinel alive. | Startup asserts cgroup/unit identity and parentage; continuous topology drift check; restart transaction correlated with survivor and external heartbeats. | One unit/cgroup per on-host role; external gateway on separate compute; no daemon-spawned tmux/session; lanes cannot invoke shared-unit restart. | Supervisor recreates only a failed leaf and fences duplicate identity; external sentinel handles whole-host fence/rebuild or declares Human-only recovery. | Any survivor heartbeat gap or parentage drift; planned shared restart requires maintenance notice; host loss alerts externally. | Disposable daemon-like unit launches its own child, then restart/kill it while independent session/gateway exchange nonce messages; destroy disposable host for the external phase. | Pre/post cgroup tree, same-session identity, external gateway round trip, zero sibling deaths/orphans; rollback rehearsal stops new scopes and restores old unit without losing comms. | `unit-installer`, `session-supervisor`, permission broker; external `sentinel` owns host-loss verdict. |
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
2. **G1 — Failure-domain separation.** Restarting daemon, observer, supervisor,
   or orchestrator in a disposable stand leaves the other roles alive; process
   and cgroup assertions are machine checked. A second phase kills the entire
   disposable host/service manager: the external sentinel/gateway must remain
   reachable, classify the host loss, preserve the operator ledger, and prove
   either remote fence/rebuild or an honest Human-only recovery verdict.
3. **G2 — Acyclic alarms.** A generated graph has no route from any alarm output
   to any detector input. Full live-rendering replay and arbitrary truncations
   cannot produce a second event. A breaker is proven independently.
4. **G3 — Recovery truth.** One fenced supervisor persists attempts over its own
   restart, never writes its judged heartbeat, never loops beyond budget, and
   records restart and delivery as separate verdicts.
5. **G4 — Communication survival.** With orchestrator, supervised host, and
   primary provider/transport down, the external gateway preserves inbound
   capture and acknowledged status through its independent channel in the
   operator language; semantic `NO-GO` and recovery authority remain visible.
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
10. **G9 — Meteorite rebuild.** Two clean targets in distinct host/site failure
    domains, using only a remote clone plus enumerated secrets/instance inputs,
    install the supervised host and external sentinel/gateway, boot the minimal
    topology, pass G0–G8, then destroy the supervised host/service manager. The
    external side must preserve communication and either rebuild/fence it or
    record Human-only recovery without false automation claims. It exchanges an
    operator round trip and reproduces declared digests. `SKIP` at a required
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
5. **Separate communications.** Provision the gateway/sentinel on independent
   compute and transport, then introduce the directive ledger; pass G4 including
   supervised-host loss before removing any legacy route.
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
5. Run every destructive or failure-injection rehearsal only in a disposable VM
   or separately provisioned host failure domain. It is forbidden on the shared
   live control-plane host, even with an allowlist, detached unit, namespace, or
   external supervisor: signal, OOM, daemon-parent, reboot, service-manager, and
   cleanup-abort injection all exercise shared boundaries. A live maintenance
   boundary may deploy an artifact already proven in the disposable target and
   run only bounded non-destructive identity, health, communication, and rollback
   checks. An emergency exception is not an architectural default: it requires an
   explicit irreversible operator decision naming the destructive action, impact,
   and recovery evidence after safer alternatives are exhausted.
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

Snapshot below is as of the original plan base (`853ca0a`, 2026-08-01
16:50 +02:00). “Landed” means ancestor of `origin/main` at that snapshot;
review/evidence commits on candidate refs do not become landed by association.
Current candidates are inputs, not completion:

- The W-31 scoped-session chain (`d790bc1`, `a3ad228`, round-3 review
  `041fe6e`, round-4 `71b8770` + evidence `0648138`) targets G1. It cannot close
  G1 while its rehearsal is unexecuted. The early candidates are superseded;
  `71b8770` + `0648138` is the surviving unlanded round-4 harness candidate at
  the snapshot and remains `NO-GO`. Run it only in a disposable VM/separate host,
  never in the announced live maintenance boundary. A new permission-surface
  item must prohibit lanes from restarting shared services. A separate new item
  must add external host-loss detection/fence/rebuild before full G1 can close.
- W-33 landed rounds through `9afd5cd` close known string/nonce echo paths but
  explicitly leave payload reclassification. They are regression fixtures for
  G2, not architectural closure.
- W-37's exact unlanded chain at the snapshot was: round 1 `1409cf6` + evidence
  `013c3bf`, REJECT `699e5ff`; round 2 `d010755` + evidence `2b49c9e`, REJECT
  `35221ab`, then superseded; topology-severing candidate `637ad0d`, with
  round-3 REJECT `f63c93a` and round-4 REJECT `14f9ebf`; round-5 REJECT
  `c52ac95`; round-6 REJECT `e3abd7b`; round-7 coder `019180f`, ACCEPT
  `7eee7db`; cumulative round-8 REJECT `1c81e33`; cumulative round-9 REJECT
  `54d7abf`; and surviving round-10 coder tip `ea30c7f`. Thus `ea30c7f` is the
  only current W-37 candidate from that snapshot that could supply narrow G2
  journal-first/pane-edge/cleanup evidence, but it had no fresh cumulative ACCEPT
  and was not an ancestor of `origin/main`; it closed no gate. Even an ACCEPT
  would leave new work for the typed event journal source allowlist, generated
  DAG checker, lineage/hop limit, and circuit breaker required for full G2.
- The watchdog restoration `0cc5215`, escalation `3854864`, and acknowledged
  delivery fallback `a92e6b2` were already ancestors of `origin/main`; they are
  landed fixtures for G3/G4, not candidates. New work is required to separate
  restart broker and observer on-host, deploy the gateway/sentinel on independent
  compute/transport, persist a fenced retry state machine, and implement the
  remote fence/rebuild-or-Human-only verdict.
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

The rebuild runner must create two blank supported targets in distinct host/site
failure domains (containers without the declared service-manager boundary are
insufficient), clone the canonical remote at exact SHAs, and supply only values
enumerated in the instance onboarding contract. One target becomes the
supervised control-plane host; the other becomes the external sentinel/operator
gateway with a separately budgeted transport/provider and remote fence/rebuild
authority, or an explicitly configured Human-only recovery policy. It installs
pinned provider CLIs/runtime dependencies, renders and enables all required
units, proves distinct identities/failure domains, initializes empty durable
mission/event and operator ledgers, and boots with watchdog routes disabled by
tracked policy. It then runs G0–G8, destroys the supervised host/service manager,
proves the external gateway still exchanges an acknowledged operator message,
and either rebuilds/fences the host or records the Human-only recovery verdict.
After recovery it replays state to the identical digest, verifies deployed
digests, performs rollback and forward recovery, and reports zero unexplained
files, units, processes, containers, worktrees, or secrets. Required dependencies,
systemd, authentication, external transport, host-loss, and runtime checks may
not be `SKIP`; absence is `NO-GO`. The proof bundle is committed or stored in a
declared durable evidence store referenced by a tracked manifest.

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
