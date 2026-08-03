# Branch reap plan — 2026-08-03

Read-only inventory of every local branch, built to let the Human decide the reap
without guessing. **Nothing has been deleted.** Companion evidence:
`instance/evidence/branch-inventory-2026-08-03.tsv` (one row per branch: tip, tag,
commits ahead of main, last commit date, merged-into-main, recut group, round).

Answers Vova's Telegram 1652 ask ("які там бранчі є, хто які створював, скільки
бранчів є і які вони") and recommendation 3 of
`instance/consilium-2026-08-03-sprint-review.md`.

Method: `git for-each-ref` over `refs/heads`, plus `git merge-base --is-ancestor`
per branch to decide merged status, plus `git rev-list --count main..<tip>`. Recut
groups are formed by stripping a `-r<N>` round token and a trailing message-id
suffix from the branch name.

## Counts

1371 branches besides `main`.

| bucket | count | disposition |
|---|---|---|
| tip is already an ancestor of `main` | **57** | safe to delete — content is in main |
| unmerged | **1314** | see below |

Unmerged by tip commit tag:

| tag | count |
|---|---|
| `[REVIEW]` | 893 |
| `[CODER]` | 415 |
| `[ORCH]` | 5 |
| untagged | 1 |

Correction to `instance/consilium-2026-08-03-sprint-review.md` §2: that report gave
889 / 403 / 3. Those came from `git log --no-walk` over all tips, which collapses
branches that share an identical tip commit. The per-branch counts above are the
accurate ones; the totals and every conclusion drawn from them are unchanged.

Unmerged by last-commit date: 2026-08-02 → 646, 2026-08-03 → 492, 2026-08-01 → 131,
2026-07-31 → 44, 2026-07-30 → 1.

## Recut chains

123 recut groups have more than one surviving branch, and in **every one** of those
123 groups an older round is superseded by a higher one. **335 branches are
superseded older rounds** — 25% of all unmerged refs, kept alive for nothing.

Largest chains:

| branches | group |
|---|---|
| 11 | `ag-runtime-loopback` |
| 10 | `ag-rev-test-resource-inventory` |
| 10 | `ag-test-resource-inventory` |
| 10 | `ag-v3-dispatch` |
| 10 | `ag-w20-path-authority` |
| 8 | `ag-rev-internal-unit-authority` |
| 8 | `ag-rev-w20-path-authority` |
| 8 | `ag-runner-event-protocol-plan` |
| 8 | `ag-test-executor-foundation` |
| 8 | `ag-w15-media-hermetic` |

This is the review-oscillation of §2a of the consilium report, measured from the
branch side: each rejected round leaves its branch behind, and nothing reaps it.

## Proposed disposition — needs the Human's go

Tier 1, mechanically safe (**57 branches**): delete branches whose tip is already an
ancestor of `main`. No content can be lost; the commits are in main by definition.

Tier 2, safe under the stated rule (**335 branches**): delete superseded older rounds,
keeping the highest round in each of the 123 groups. The rule is decidable from the
TSV (`recut_group` + `round`), so the deletion set is reviewable before it runs.

Tier 3, needs judgement (**~922 remaining unmerged**): triage per the consilium's
sampled distribution — 41% never produced a `.review.md`, 26% have no terminal
report, 10% are gate-ready but were never landed, 8% were rejected. The gate-ready
ones should be landed rather than deleted; the no-report ones are not recoverable as
branches and should be re-dispatched only if the mission is still wanted.

Recommended order: land the gate-ready set first (so nothing recoverable is lost),
then Tier 1, then Tier 2, then re-triage what remains. Worktree reaping follows
branch reaping, not the reverse — `/root/.cache/infra-lanes` is at 6382 dirs / 14 GB
with no automatic backstop.

## What is deliberately not proposed here

No protected-ref policy change, no history rewrite, and no deletion of anything
outside Tiers 1 and 2 without a further decision. Per
`instructions/branching-policy.md` unmerged refs may only be retained with a
recorded reason — Tier 3 currently has no such record, and producing one is the
follow-up work, not this document.
