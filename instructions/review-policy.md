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

## Round cap and test escalation

The landing gate checks the caller's item against the tracked instance review-item
registry on the target branch. That registry maps a durable mission/acceptance id
to a stable branch root; disposable `-rN` recuts therefore share one counter and
unknown ids fail instead of minting state. The gate records every reviewed landing
attempt in an origin-visible, non-branch Git ref before continuing the landing.
The target-branch JSON and Git-common-dir copy are reconstructable caches over
those refs, so restarting the orchestrator, deleting the cache, or making a fresh
clone does not reset either measure. Existing malformed or unsafe state still
fails closed.

An item receives at most three review rounds. A fourth is refused and parked as
`cap`. There is no lane-callable reset or override. At the cap, unresolved
concerns become executable fail-before and pass-after locks; if that cannot be
done, the item remains parked for recut.

Root-equivalent lanes can still edit Git-common-dir state or the gate itself;
mode bits and an audit log cannot prevent that. Tamper resistance therefore
depends on V3-1.9's non-root lane boundary plus independent landing review. This
mechanism prevents supported-interface evasion; it does not claim protection
from a malicious root process.

Separately, consecutive reviewed attempts without a landed SHA are counted as
no progress. Reaching the configured limit parks the item as `no-progress`.
Every successful landing records its SHA and resets only this consecutive
no-progress measure; it does not erase the total review-round count. Missing,
unreadable, non-regular, symlinked, or malformed state fails landing closed.
