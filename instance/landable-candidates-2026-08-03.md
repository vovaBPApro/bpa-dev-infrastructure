# Landable candidates — 2026-08-03

Read-only scan. **Nothing was landed.** Produced so that an approval to "land what
is ready" has a concrete, decidable list attached instead of an estimate.

## The precondition that decides everything

`gate/land.sh:160-163` refuses any candidate whose report does not pin the exact tip:

```sh
report_sha=$(sed -n 's/^commit:[[:space:]]*\([0-9a-fA-F]\{40\}\).*/\1/p' "$report" | head -n 1)
if [ -z "$report_sha" ] || [ "${report_sha,,}" != "${branch_sha,,}" ]; then
  echo "LAND branch-tip mismatch report=${report_sha:-missing} branch=$branch_sha" >&2
```

A branch is landable only if a terminal report exists whose `commit:` SHA equals the
branch tip. That is correct and should not be relaxed — it is what stops a report
from vouching for code that is not the code being landed.

## What that predicate returns today

Scanned every report-shaped file in both places reports actually live — the canonical
tree (`orchestrator/runtime/`, 31 files carrying a 40-hex `commit:`) and the lane
worktrees (`/root/.cache/infra-lanes`, 93 files) — and matched each report's `commit:`
against the tip of all 1371 branches.

**Of 1314 unmerged branches, exactly 6 satisfy the precondition.**

| branch | files | touches review-required paths | report source |
|---|---|---|---|
| `ag-landing-contract-audit-1565` | 1 | 0 | lane worktree |
| `ag-database-loopback-r2-1565` | 4 | 0 | canonical tree |
| `ag-w35-daemon-deps-r10-1565` | 5 | 0 | canonical tree |
| `ag-landing-contract-r2-1575` | 8 | 5 | lane worktree |
| `ag-generator-buildkit-r3-1565` | 30 | 3 | canonical tree |
| `ag-test-resource-inventory-r11-1565` | 51 | 4 | canonical tree |

"Review-required paths" counts files under the prefixes in `gate/review-policy.conf`
(`gate/ core/ daemon/ bootstrap/ .github/ tools/instructions/ templates/`). The three
branches with a non-zero count additionally need an independent ACCEPT artifact before
`land.sh` will proceed; the other three do not.

Four further reports match tips that are **already ancestors of `main`** — that work
landed and the branches are simply stale refs (`ag-hr1275-instruction-completion`,
`ag-infrastructure-recurrence-plan-2`, `ag-v3-gap5-r8-1544`, `ag-w37-alert-routing-10`).
They belong in Tier 1 of `instance/branch-reap-plan-2026-08-03.md`.

## What this changes about the diagnosis

The consilium estimated ~10% of the 403 coder branches were gate-ready and ~16-20%
worth recovering. Measured against the actual gate predicate, the number is **6
branches, under 0.5%**. The earlier figure came from sampling branch *properties*;
this one runs the gate's own rule over the whole population.

So the bottleneck is upstream of review and upstream of the merge: **lanes are not
leaving a terminal report pinned to their final commit.** Every other landing symptom
— the 893 review branches, the recut chains, the 67-commits-per-1314-branches ratio —
sits downstream of that one missing artifact. A lane that ends without a tip-pinned
report cannot land, no matter how good its code is, and nothing in the current flow
notices at the moment the lane ends.

Note the shape of the surviving six: five of them carry the `-1565`/`-1575` message-id
suffix, i.e. they come from the narrow window where lanes were dispatched with the
report convention actually enforced. That is evidence the convention works when
applied, not that it is unworkable.

## Consequence for the fix order

Bounding the review gate (round cap, ACCEPT carry-forward) is still worth doing, but
it is **not** the first constraint — it governs branches that mostly cannot reach the
gate at all. The first fix is making the terminal report a hard, checked lane exit
condition, so that finishing a lane and being landable stop being different states.

`gate/completion-guard.ts` already encodes the report contract; what is missing is
that nothing runs it at lane exit, only at land time — by which point the lane, its
session and its context are gone, and re-cutting the report means re-running the work.

## Proposed order, for the Human

1. Land the 3 candidates needing no review (`ag-landing-contract-audit-1565`,
   `ag-database-loopback-r2-1565`, `ag-w35-daemon-deps-r10-1565`) — smallest possible
   proof that the landing path works end to end today.
2. Route the 3 review-requiring candidates to a single-round review each.
3. Make the tip-pinned terminal report a checked lane exit condition (v3 scope per
   HR-1720, since it changes supervision).
4. Only then bound the review gate.
5. Reap per `instance/branch-reap-plan-2026-08-03.md`, moving the 4 already-landed
   refs above into Tier 1.
