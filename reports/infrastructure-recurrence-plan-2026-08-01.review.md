# Independent architectural review: infrastructure recurrence-prevention plan

reviewer: Codex independent reviewer lane
independence: reviewer did not author the plan
reviewed-sha: 92bde771adabc0d60f7462f91ca7d9c9348d6ac8
reviewed-artifact: `reports/infrastructure-recurrence-plan-2026-08-01.md`
prior-reviewed-sha: 853ca0a560be039cb94e2c0d65d99545c065e82d
verdict: REJECT

## Instruction-pack consumption

- orchestrator-playbook sha256:2c5d9a8dc6b3 — Orchestrator Playbook
- orchestrator-fallback sha256:811f13bc3373 — Orchestrator Session Portability
- autonomy-and-capacity sha256:18c43aaf7e14 — Autonomy and Capacity
- landing-and-merge sha256:951d9781cffa — Landing and Merge
- roles sha256:cd4c40c4e640 — Roles
- instruction-layers sha256:cd21f4ce0990 — Instruction Layers
- reproducible-from-git sha256:822d9efe694b — Reproducible From Git

## Decision

REJECT. The revision materially closes the unsafe live-host rehearsal path and
specifies a genuinely outside-host communication/recovery component, but the
full plan still contains two contradictory acceptance/ordering paths and its
candidate snapshot is not cryptographically reproducible. This verdict does not
authorize any live probe, deployment, restart, watcher change, or injection.

## Prior blocker disposition

- **B1 — substantially closed.** The plan now defines process, cgroup/unit,
  service-manager/kernel/host, provider, transport, and site layers. The external
  sentinel/operator gateway is on separately provisioned compute with independent
  kernel, service manager, storage, power/site, credentials, provider/transport,
  and a narrow fence/rebuild API. It supervises the control-plane host, not its
  own failure domain; rendered chat/pane text remains excluded from detector
  input. No circular recovery route is introduced.
- **B2 — partially closed.** The W-31/W-33/W-37/watchdog mappings now name exact
  candidate, evidence, review, and landed SHAs, including the W-37 chain through
  `ea30c7f`. The remaining reproducibility defect is F3 below.
- **B3 — closed.** Maintenance step 5 now unambiguously forbids destructive or
  failure-injection rehearsal on the shared live control-plane host, explicitly
  including signal, OOM, parent, reboot, service-manager, and cleanup-abort
  injection. Live maintenance is limited to non-destructive deployment,
  identity, health, communication, and rollback checks. An emergency exception
  requires an explicit irreversible Human decision.

## Blocking findings

### F1 — staged order tries to pass G1 before its external dependency exists

Revised G1 requires a second phase that destroys the entire disposable host and
proves that the external sentinel/gateway remains reachable and classifies,
preserves, and fences/rebuilds or escalates. Stage 3 nevertheless says to “prove
G1,” while the external gateway/sentinel is not provisioned until stage 5. The
declared implementation order therefore cannot execute its own hard gate and
could encourage a false partial G1 based only on sibling-cgroup survival.

Required closure: provision and verify the outside-domain sentinel/gateway
before any stage claims full G1, or split G1 into explicitly named leaf-domain
and host-domain gates and make later stages depend on both before topology
promotion. No stage may use the same gate name for partial evidence.

### F2 — Human-only recovery both blocks and appears to satisfy G1/G9

The topology section says that without independent compute or a recovery API the
system “may not claim automatic host recovery or G1/G4/G9 clean.” G1 then says
its host-kill phase can prove “either remote fence/rebuild or an honest
Human-only recovery verdict.” G9 likewise permits an explicitly configured
Human-only policy and says the runner either rebuilds/fences or merely records
that verdict. As written, the hard gates have two incompatible pass rules: one
forbids `clean`, while the gate text appears to accept the Human-only branch.
That is not a decidable fail-closed acceptance gate.

Required closure: make remote automated fence/rebuild evidence mandatory for a
clean G1/G9 (and therefore G4 if that is the intended dependency), or define a
separate degraded gate/verdict that is explicitly `NO-GO` for promotion. Human-
only escalation may be a safe operating mode, but it cannot occupy the same
successful branch as demonstrated automatic recovery.

### F3 — the candidate snapshot omits the immutable canonical-main SHA

The disposition says “Landed means ancestor of `origin/main` at that snapshot,”
but it never records what exact `origin/main` SHA was observed. `origin/main` is
a moving ref; a fresh reviewer cannot reproduce the ancestry classification from
the declared timestamp alone. Pinning plan SHA `853ca0a` does not pin the remote
ref, and `853ca0a` itself is a lane candidate rather than the canonical main tip.
This weakens the exact landed-versus-candidate distinction required by G5.

Required closure: record the full canonical remote-main SHA used for the
snapshot (and, ideally, the read-only fetch/reconciliation command), then state
ancestry relative to that immutable SHA. Candidate/evidence/review refs should
remain classified as surviving, superseded, accepted, rejected, or landed at
that exact pinned main.

## Full-mission re-audit

- All nine demanded failure classes remain separate and each matrix row contains
  invariant, signal, containment, automatic recovery, Human escalation,
  executable injection, deploy/rollback evidence, and component ownership.
- The plan separates provider/API exit, signal/OOM, and daemon-parent restart;
  prohibits guessing unknown causes; and makes G0 executable.
- Typed event sources, a generated route DAG, source allowlist, lineage/hop
  limits, and breaker prevent the known self-observation path. Gateway output
  cannot write observer input; pane/chat rendering is not a detector source.
- Watchdog singleton, persisted retry budget, restart verdict, and acknowledged
  delivery remain separate. Human transport, durable capture, locale, reply
  correlation, and semantic completion remain distinct fields.
- Promotion identities, durable mission replay, capacity reporting, isolated
  fixtures, ownership-based reaping, rollback identity, soak/chaos scenarios,
  and no-SKIP meteorite evidence are present and generic. Installation paths,
  message IDs, and candidate SHAs remain in the evidence appendix/disposition.
- The plan remains proposed and non-binding pending an accepted review, which is
  correct under this REJECT verdict.

## Evidence inspected

- Exact candidate, parent, timestamps, full plan, and diff from prior reviewed
  SHA (`git show`, `git diff`, `git rev-parse`).
- `instance/workboard.md` W-29/W-31/W-33/W-37 and ML-3/ML-7/ML-12 evidence.
- Existence, timestamps, ancestry, and review status of every SHA in the revised
  candidate disposition, including W-37 through `ea30c7f`.
- Incident, overnight, meteorite, drift, Telegram audit, candidate, and review
  reports cited by the plan; canonical secret-scan instructions.

## Verification

```sh
test "$(git show 92bde771adabc0d60f7462f91ca7d9c9348d6ac8:reports/infrastructure-recurrence-plan-2026-08-01.md | sha256sum | cut -d' ' -f1)" = "$(git show HEAD^:reports/infrastructure-recurrence-plan-2026-08-01.md | sha256sum | cut -d' ' -f1)" && git diff --check HEAD^
```

Expected result: exit 0, proving this review commit did not alter the reviewed
plan and the review diff is whitespace-clean.

result: REJECT
remaining: close F1-F3 and obtain a fresh independent architectural review of the exact new plan SHA
