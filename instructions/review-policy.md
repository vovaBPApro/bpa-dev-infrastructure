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
- Tier A requires an independent, preferably cross-vendor, implementation
  review before landing. A review of a plan never substitutes for diff review.
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

## Blocked-review fallback

Use a same-provider emergency consortium for urgent Tier A only after a normal
independent route was attempted and is unavailable, quota-blocked, stalled, or
timed out. Preserve the activation evidence and separate passes for security,
operations/runtime, and tests/regression. Every pass must review the same SHA;
any rejection parks the item. The record must say whether a deferred independent
review remains required. This fallback never lowers the tier or weakens a
required approval boundary.
