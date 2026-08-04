# Sprint 04 — close, 2026-08-04

Opened `1f81831` on 2026-08-03 evening at the operator's request (Telegram 1944).
Closed a day late: the orchestrator stopped keeping the sprint frame and ran the
following day's work straight off the workboard queue. That drift is recorded here
rather than smoothed over, because the sprint closes are the only place this
installation records throughput as re-executed numbers — and the estimates the
operator asked for on 2026-08-04 are built on exactly those records.

## Outcome of the eight planned rows

Every state below is derived from landing evidence — ancestry against
`origin/main` — and **not** from the workboard's own text. The durable counter was
consulted and holds an entry for only one of these rows, which is V3-0.41 in
practice: the tracked state is rebuilt from the target branch and records only what
landed through it.

| lane | row | outcome | evidence |
|---|---|---|---|
| s5-1 | V3-1.9 round 3 | **parked at the HR-1726 cap** | three rounds, no ACCEPT; park record retained |
| s5-2 | V3-1.1 stage 2 recut | **partial** — stage 1 only | `88361ff`, ancestor of `origin/main`; stage 2 did not land |
| s5-3 | V3-2.2 | **landed** | `d01cd1c`, ancestor of `origin/main`; two rounds |
| s5-4 | V3-2.3 | **parked at the cap** | `a1faf8c` "park V3-2.3 at the HR-1726 cap with evidence" |
| s5-5 | V3-2.4 | **parked at the cap** | `2542247` "park V3-2.4 at the cap" |
| s5-6 | V3-3.4 | **landed** | `7c428e0`, ancestor of `origin/main` |
| s5-7 | V3-2.6 | **landed** | `8f96908`, ancestor of `origin/main`; each input unset in turn, verified 2026-08-04 |
| s5-8 | V3-0.15 | **landed** | `c8e52f6`, ancestor of `origin/main`; round 3 ACCEPTed |

**Four landed, three parked at the round cap, one partial.**

## What this sprint is actually evidence for

Three of eight rows hit the review cap in a single sprint. That is the empirical
case for HR-2166 — the operator's 3+2+2 ladder — and it was produced before he
proposed it. The rows did not park because their designs were wrong; each park
record names a specific missing proof. A phase that spends rounds on *proving*
rather than redesigning is aimed at exactly this failure.

It is also the case for V3-0.32: none of the three parks is visible to
`gate/review-rounds.ts check`, because a rejection charges no round and the tracked
state records only landings. The cap that parked them was counted by hand.

## Throughput, measured — and a correction

The orchestrator told its own consilium that three rows landed on 2026-08-04. That
was wrong and the error was in the pessimistic direction by roughly four times. Run
against `origin/main`:

```
git log origin/main --since="2026-08-04 00:00" --oneline | grep -c "land lane"
→ 12    (00:20 → 10:49, one landing per ~52 minutes)
```

The "three" counted only the four hours during which the orchestrator was
simultaneously absorbing the Fable global review and filing ten new rows — the
day's least representative stretch, chosen as the denominator. A consilium member
caught it by measuring `origin/main` instead of trusting the briefing, and every
member that had inherited the number would have padded its sprint estimates
fourfold. Recorded here because an installation whose hard rule is "report capacity
as numbers, not intent" fed its own planners a bad number.

## Carried forward

- **V3-1.9** stays parked; its release is V3-0.29, which is at round 4 with four
  blocking findings closed and an escalated review in flight.
- **V3-2.3 and V3-2.4** stay parked with their records. Both are candidates for the
  HR-2166 proving phase, since both parked for missing proof rather than for a
  disputed design — they are the first honest subjects the trial has.
- **V3-1.1 stage 2** returns to the queue.

## Why sprint 05 is planned by a consilium and not by the orchestrator

The operator asked for it directly (Telegram 2203), and the reason is visible in
this close: the orchestrator planned sprint 04 alone, and three of its eight rows
parked. Three independent members on different models planned sprints 05–07 without
seeing each other's answers; their disagreements are recorded with the plan rather
than resolved into a consensus that hides them.
