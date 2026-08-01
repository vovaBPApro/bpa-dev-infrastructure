# Independent architectural review: infrastructure recurrence-prevention plan

reviewer: Codex independent reviewer lane
independence: reviewer did not author the plan
reviewed-sha: 853ca0a560be039cb94e2c0d65d99545c065e82d
reviewed-artifact: `reports/infrastructure-recurrence-plan-2026-08-01.md`
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

REJECT. The plan is materially stronger than the current topology and correctly
keeps itself non-binding, but three fail-closed gaps prevent architectural
acceptance. This verdict does not authorize a live probe, deployment, restart,
watcher change, or failure injection.

## Blocking findings

### B1 — the safety spine still shares an undeclared host failure domain

The governing rule says that observation, recovery, and communication must not
share the failure domain they supervise. The proposed topology proves only
distinct processes, OS units, cgroups, writable directories, and identities on
one host. `session-supervisor` and `event-observer` still depend on the same
kernel, service manager, filesystem, resource pool, and unit namespace as the
orchestrator they supervise. An external alert sink can report a host failure,
but the plan assigns no external recovery authority/component that can restore
or fence the failed host. G1 consequently proves sibling survival during leaf
restart, not the stated invariant at the host/service-manager layer.

Required closure: define a failure-domain hierarchy (process, cgroup/unit,
service manager/host, provider, transport, site), state the supervised scope of
each component, and assign an owner plus an outside-domain detector/recovery or
explicit Human-only recovery for every layer. G1/G4/G9 must inject host/service-
manager loss and prove that the outside-domain path remains observable; it must
not claim automatic recovery where only notification exists.

### B2 — candidate-to-gate disposition is stale and not exact

The mission explicitly requires identifying which current candidates can close
which gates and where new work is needed. At plan commit time
(`2026-08-01T16:50:01+02:00`), the W-37 chain already included round-2 through
round-10 work and repeated review evidence, including `d010755`, `2b49c9e`,
`637ad0d`, `14f9ebf`, `019180f`, and `ea30c7f`; the plan names none of them and
describes only generic “W-37 alert-routing candidates.” In particular,
`ea30c7f` predates the reviewed plan by approximately thirteen minutes. The plan
also calls `a92e6b2` a “reviewed delivery candidate,” although it is an ancestor
of `origin/main`; that loses the required landed-versus-candidate distinction
that G5 itself says must remain explicit.

Required closure: snapshot every relevant candidate/review/landing SHA and its
verdict/status as of the plan SHA, map the exact surviving candidate (if any) to
the narrow gate evidence it can supply, name rejected/superseded candidates as
such, and distinguish landed fixtures from unlanded candidates. If no current
candidate closes a gate, say so and create/name the new work item.

### B3 — the maintenance procedure leaves an unsafe shared-host injection path

The failure-class rows correctly require destructive tests in disposable
hosts/VMs, and the W-31 disposition correctly says not to rerun its rehearsal on
the shared host. Maintenance step 5 nevertheless permits a risky rehearsal to
touch the live host with only a target allowlist and external supervisor. An
allowlist does not isolate the shared service-manager, cgroup tree, tmux server,
runtime namespace, or resource pool; W-31 is direct evidence that apparently
isolated fixtures can kill the supervising session and leak sibling scopes.
This exception contradicts G7 and can recreate the incident class the plan is
meant to eliminate.

Required closure: prohibit destructive/failure-injection rehearsals on the
shared control-plane host. A live maintenance boundary may deploy a previously
proven artifact and exercise bounded non-destructive health/rollback checks;
signal, OOM, daemon-parent, reboot, service-manager, and cleanup-abort injections
must run in a disposable VM or a separately provisioned host failure domain.
Document the narrow emergency exception, if one is truly required, as an
irreversible operator decision rather than an architectural default.

## Non-blocking observations

- The nine requested failure classes are separately represented, and every row
  supplies invariant, signal, boundary, recovery, escalation, injection,
  deploy/rollback evidence, and component ownership.
- The typed-event DAG, lineage, hop limit, circuit breaker, and prohibition on
  pane/chat detector input are an appropriate architectural closure for W-33 and
  W-37. The plan does not falsely treat string suppression as topology closure.
- Promotion identity, durable mission replay, resource ownership, no-SKIP
  meteorite rehearsal, rollback identity, and operator-language semantics are
  all correctly fail-closed in principle.
- G2 should retain its strong arbitrary-rendering claim only after pane/rendered
  text has been mechanically excluded from detector sources; before that point,
  the declared payload-truncation residual remains a known red condition.

## Evidence inspected

- Exact plan commit and its parent/timestamp (`git show`, `git rev-parse`).
- `instance/workboard.md` rows W-29, W-31, W-33, W-37, ML-3, ML-7, and ML-12.
- Candidate/review history and ancestry for all SHAs named by the plan plus the
  W-37 chain; notably `a92e6b2` is contained in `origin/main`.
- `reports/ag-ml10-delivery-fallback.review.md`, incident/meteorite/drift report
  references, and the canonical secret-scan definition in
  `instructions/verification-and-locks.md`.

## Verification

```sh
test "$(git show 853ca0a560be039cb94e2c0d65d99545c065e82d:reports/infrastructure-recurrence-plan-2026-08-01.md | sha256sum | cut -d' ' -f1)" = "$(git show HEAD^:reports/infrastructure-recurrence-plan-2026-08-01.md | sha256sum | cut -d' ' -f1)" && git diff --check HEAD^
```

Expected result: exit 0, proving the reviewed plan is unchanged by this review
commit and the review diff is whitespace-clean.

result: REJECT
remaining: revise B1-B3, then obtain a fresh independent architectural review of the exact new plan SHA
