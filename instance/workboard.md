---
id: workboard
layer: L1
status: informational
audience: orchestrator
tags: [instance]
summary: Open tracked work rows for this installation — every known-open item has exactly one row here until it lands or is explicitly dropped.
---

# Workboard — open tracked rows

One row per open item. A row leaves this file only by landing (record the SHA
in the row, then delete it next pass) or by an explicit dropped-with-reason
note. Derived-work items live here; Human directives stay in
`instance/decisions/` and are only referenced.

## Open

- **W-01 — teardown/startup overlap zero-count lock** (history sweep A3,
  `migration-prep/HISTORY_SWEEP_MISSED_COMPLAINTS_2026-07-29.md`): acceptance
  test that fleet width never reads 0 while the workboard is non-empty during
  lane teardown/startup overlap. Home when built: orchestrator/ + daemon
  status source of truth. Source complaint: Vova msg 9557.
- **W-02 — watchdog chases task progress, not headcount** (history sweep A4):
  verify/extend the watchdog so ping/escalation targets a stalled mission's
  completion, not raw agent count; recovery/replay test. Source: Vova msg 5196.
- **W-03 — session-load v2** (sol verdict finding 2 residue): add to the
  startup bundle: repo SHA + dirty-state warning, durable mission/lane/lease
  state, explicit startup verdict line. (Handoff freshness landed 8c0de918.)
- **W-04 — scaffold L1 pinning + fresh-Codex integration test** (consilium
  wave 3): scaffolded repo pins an L1 reference/bootstrap manifest; test = a
  fresh Codex session in a generated repo discovers and validates its rules.
- **W-05 — orchestrator cold-start doc** (consilium wave 3, sol F5):
  copy-pasteable command walkthrough for mission/dispatch/review/land/report
  on either harness; becomes an orchestrator-baseline doc.
- **W-06 — sandboxed-lane capability contract** (consilium wave 3, terra F7):
  declare trusted-executor vs sandboxed-lane capabilities; `NO-GO
  capability=<…>` evidence instead of stalls.
- **W-07 — batch --skip-review test coverage** (wave2-gate review LOW
  finding): land-batch.test.sh cases for bare rejection, per-branch audit
  rows, `BATCH review=SKIPPED` output.
- **W-08 — memory-sweep defect triage**: first real (non-dry) sweep filed
  39 rule-stating memory entries without `home:` ids; run the sweep live,
  then triage rows into instruction homes or drop. (Sweep tool landed
  05689cdd; daily timer installer exists, not yet installed.)
- **W-09 — handoff minor findings** (wave2-tools review, 3 LOW): write-time
  future-ts guard; document absolute-vs-relative path asymmetry in the
  schema; note the 2-space YAML assumption in readInstanceFacts.
- **W-10 — install memory-sweep daily timer** on the host once W-08 triage
  is done (orchestrator/install-memory-sweep.sh).

## Parked (needs Human go or a phase flip)

- **P-01 — VM migration to the 64 GB machine** (`instance/migration-day.md`)
  — parked by HR-11570 («Поки роби лише 1») until Vova's go.
- **P-02 — stack Phase-0 spike with go/no-go numbers**
  (`migration-prep/STACK_CONSILIUM_FINAL.md`) — parked by HR-11570.
- **P-03 — daemon cutover to this repo's daemon/** (flips
  `capture.mode: manual → daemon` in `instance/params.yaml`; inbox ledger
  check then fail-closes) — needs the migration/cutover moment.
