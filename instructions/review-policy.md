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

Classify every finding as `closed`, `moved`, or `open`; for each disposition,
cite its evidence and mark whether the evidence was read or executed. A finding
is `closed` only when its new evidence would have caught the original failure.

For gate-routed changes, the record must include plain column-1 `reviewed-sha:`
and non-empty `independence:` fields. The landing gate verifies that the SHA
equals the report's commit before it accepts the record. Break-glass
`--skip-review` requires a reason and is durably audited in the runtime review
skip log; see the gate's usage output for operational mechanics.

## Constrained-provider review

A same-provider consortium is valid when its reviewers are separate sessions
with distinct role/persona lenses. Preserve separate passes for security,
operations/runtime, and tests/regression; every pass reviews the same SHA and
any rejection parks the item. Provider constraint never lowers the tier,
session-independence requirement, or an explicit approval boundary.
