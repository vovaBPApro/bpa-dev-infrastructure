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

- **Count rounds per work item, not per SHA.** A round is one full pass of the
  required lenses over a candidate. The item is identified by its mission id, so
  recuts and renamed branches continue the same count rather than resetting it.
- **The cap is 3 rounds.** A fourth round is not an available action.
- **Carry ACCEPT forward.** A lens that returned `ACCEPT` is not re-run on a later
  candidate unless the new diff touches that lens's surface. Only the lenses that
  rejected review the delta. Record the carried verdict and the SHA it was issued
  against, so the record still names what was reviewed.
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

## Constrained-provider review

A same-provider consortium is valid when its reviewers are separate sessions
with distinct role/persona lenses. Preserve separate passes for security,
operations/runtime, and tests/regression; every pass reviews the same SHA and
any rejection parks the item, subject to the round cap and ACCEPT carry-forward
above — a carried `ACCEPT` names the SHA it was issued against, which is how a
bounded item still satisfies "every pass reviews the same SHA". Provider constraint never lowers the tier,
session-independence requirement, or an explicit approval boundary.
