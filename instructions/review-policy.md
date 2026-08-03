---
id: review-policy
layer: L1
status: binding
audience: reviewer
tags: [review, risk]
summary: Review is a risk and evidence gate: check the SHA, changed paths, acceptance evidence, and rollback posture.
---

# Review Policy

Review is a risk and evidence gate, not a style ritual. Review the exact commit
SHA, changed paths, acceptance evidence, and rollback posture; reject a
narrative that cannot be rerun.

## Tiers and routing

- **Tier A:** authentication or authorization, migrations or data integrity,
  money, orchestrator or watchdog core, secrets, CI or environment schema,
  production infrastructure, cleanup/rollback, and evidence-gate changes.
  Unclear classification is Tier A.
- **Tier B:** bounded lower-risk docs, tests, and fixes that do not alter a
  Tier-A surface.
- Tier A requires an independent implementation consilium with distinct
  role/persona lenses before landing. Per `instance/decisions/HR-212.md`, role
  diversity outranks vendor diversity; cross-vendor review is a supplement when
  cheaply available, not a condition landing waits for. A review of a plan never
  substitutes for diff review.
- Tier B requires an independent executable lock review: run the relevant
  regression lock, prove it fails before the fix and passes at the reviewed
  SHA, and reject false-green test environments. A visual or interaction lock
  must exercise a live rendered surface when that is what failed.
- Route matching paths through `gate/review-policy.conf`. `gate/land.sh` is the
  fail-closed landing gate; use `gate/land-batch.sh` only for independently
  ready, gated branches. Neither tool replaces review judgment.

## Review record and verdict

Record reviewer identity/independence, tier, reviewed SHA and diff, commands
run, evidence inspected, findings, and one verdict: `ACCEPT`, `REJECT`, or
`NO-GO`. Any reject, missing evidence, timeout, scope breach, or unverified
rollback blocks landing until dispositioned.

For gate-routed changes, the record must include plain column-1 `reviewed-sha:`
and non-empty `independence:` fields. The landing gate verifies that the SHA
equals the report's commit before it accepts the record. Break-glass
`--skip-review` requires a reason and is durably audited in the runtime review
skip log; see the gate's usage output for operational mechanics.

## Round cap and test escalation

Binding per `instance/decisions/HR-1726.md`. Review rounds are bounded; testing, not
another opinion, is the escalation.

> **Enforcement status: PROSE ONLY — not machine-checked.** No tool counts rounds or
> requires a lock before landing: `gate/land.sh` verifies `reviewed-sha` and
> `independence` and nothing else. Treat this section as a rule agents must follow
> deliberately, not as a gate that will stop them. Wiring it is tracked as W-CAP-1/2
> in `instance/workboard.md`. Until then, do not cite "the cap" as evidence that a
> bounded review actually happened — say which round this is and show it.

- **Count rounds per work item, not per SHA.** A round is one full pass of the
  required lenses over a candidate. Recuts and renamed branches continue the same
  count rather than resetting it.
- **Identify the item by its `correlation_id`, and reuse it.** Do *not* rely on the
  mission id: `core/mission-cli.ts` mints a fresh `crypto.randomUUID()` on every
  `mission create`, and `core/state.ts:262` puts no UNIQUE constraint on
  `correlation_id`, so a second `mission create` for the same work silently produces
  a new identity and a reset count. Per `instructions/orchestrator-cold-start.md`,
  create once when the correlation id is absent and retain it. A recut that mints a
  new id has not reset the count; it has lost it, and the count restarts from the
  round history recorded in the item's review records.
- **The cap is 3 rounds.** A fourth round is not an available action.
- **Carry ACCEPT forward.** A lens that returned `ACCEPT` is not re-run on a later
  candidate unless the new diff touches that lens's surface. Only the lenses that
  rejected review the delta. Record the carried verdict and the SHA it was issued
  against, so the record still names what was reviewed.
- **Lens surfaces are computed, not judged.** "Touches that lens's surface" means
  `git diff --name-only <prior-reviewed-sha>..<candidate>` matches that lens's
  prefixes:
  - *security*: `daemon/`, `core/`, `bootstrap/`, `gate/`, `tools/permissions/`,
    anything touching auth, secrets, or a network boundary;
  - *operations/runtime*: `orchestrator/`, `bootstrap/units/`, `soak/`, `hygiene/`,
    systemd units, timers, and any host-deployment path;
  - *tests/regression*: any `*.test.*` file, `gate/`, and the lock or fixture files
    the candidate's evidence depends on.
  A path matching no lens does not re-open any lens. Overlap re-opens every lens it
  matches. When a candidate's paths are genuinely ambiguous, that is a Tier A
  classification question and resolves to Tier A, not to reviewer preference.
- **At the cap, exactly two exits exist:**
  1. **Escalate to locks.** Every open concern becomes an executable regression lock
     that demonstrably fails before the fix and passes at the reviewed SHA. The item
     is then decided by those locks. This is the preferred exit — on this project
     tests have caught what review rounds did not.
  2. **Park for recut.** A concern that cannot be expressed as a runnable lock is a
     design problem, not a review finding. Park the item with that reason recorded
     and recut the design.

The cap ends review rounds; it never lowers evidence. Hard Floor 7 continues to
apply — running out of rounds is not a pass, an unmeasured subject is not a pass, and
"no lock was written" is a park, not a landing. Tier A classification, session
independence, and the approval boundary are unchanged by the cap.

Escalating to locks does **not** waive the Tier A independent consilium. For a Tier A
item, an independent reviewer must inspect and accept the lock itself — that the lock
exercises the real surface, fails before the fix, and cannot pass vacuously — before
landing. Lock-passed is never sufficient on its own for auth, authorization,
migrations, money, orchestrator or watchdog core, secrets, CI or environment schema,
production infrastructure, or evidence-gate changes.

## Constrained-provider review

A same-provider consortium is valid when its reviewers are separate sessions
with distinct role/persona lenses. Preserve separate passes for security,
operations/runtime, and tests/regression; every pass reviews the same SHA and
any rejection parks the item, subject to the round cap and ACCEPT carry-forward
above — a carried `ACCEPT` names the SHA it was issued against, which is how a
bounded item still satisfies "every pass reviews the same SHA". Provider constraint never lowers the tier,
session-independence requirement, or an explicit approval boundary.
