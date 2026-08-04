# Consilium synthesis — sprints 05–07 and the road to cutover, 2026-08-04

Requested by the operator (Telegram 2203): *"імей консиліум, готуйте спринт. Готуйте
перші три спринта по черзі: як воно буде виглядати, який скільки часу займе. І по них ви
мені даєте … план до cutoff і скільки часу це займе."*

Three members, one brief, three different models, **no member saw another's answer**:
`instance/consilium-sprints-2026-08-04-opus.md`, `-fable.md`, `-sonnet.md`, all tracked
verbatim. This document is the orchestrator's synthesis. Where they disagree, the
disagreement is recorded rather than resolved into a consensus that hides it.

## The one thing all three reached independently

**Sprint 05 must fix the landing and evidence machinery, not advance the chain.**

Three members, three framings, one conclusion:

| member | its name for sprint 05 |
|---|---|
| Sonnet | "make `done` trustworthy again" |
| Fable | "land what is finished, and stop the machinery from eating rounds" |
| Opus | "pay off the gate tax" |

Independent convergence is the strongest signal a consilium can give, and the receipts are
all from a single day's measurement:

- **V3-0.39** threw away a 481-line ACCEPT over the field name `identity:` vs `reviewer:`.
- **V3-0.31** cost two review rounds on V3-0.16 because the guard checks
  `$LANE_REPORT_PATH` while every brief named `<branch>.report.md`.
- **V3-0.44**: 14 of 14 reviewer lanes end `state: failed`, including two whose ACCEPTs
  landed. Half the fleet's status signal is false.
- **V3-0.47** caused three interruptions today and forced one complete ten-minute landing
  to be re-run.
- **V3-0.52** blocks two rows with finished, independently accepted work.
- **V3-0.51** — the 120-second harness kill — has been corrupting the evidence of every
  lane whose suite run crosses two minutes.

Opus states the economics plainly: this is **the only sprint whose rows return lane-hours
instead of spending them**.

## Measured unit cost, and a correction the orchestrator owes

> **~5.8 lane-hours per landed row** today, at the current difficulty mix — 12 landings
> across 11.75 hours at 5–8 concurrent lanes. On 2026-08-03 it was ~1.7, because those were
> Phase-0 rows.

The orchestrator told this consilium that **three** rows landed today. The real number is
**12** (`git log origin/main --since="2026-08-04 00:00" | grep -c "land lane"`, 00:20 →
10:49). The briefing's number counted only the four hours in which the orchestrator was
absorbing the Fable review and filing rows — the day's least representative stretch, used
as the denominator. A member caught it by measuring `origin/main` instead of trusting the
brief; every member that had inherited the number would have padded its estimates fourfold.

## The three sprints

### Sprint 05 — the gate tax

Land what is already finished and stop the machinery charging every future row.

**Queue (work done, cost is review + gate only)**: V3-0.28, V3-0.40+V3-0.38, V3-2.9,
V3-3.8, V3-0.23 r3, V3-0.29, V3-0.30, V3-0.43 r2.
**New work**: V3-0.51 (the harness kill), V3-0.44, V3-0.31, V3-0.47, V3-0.37, V3-0.52,
and a minimal V3-3.10 so the ladder's economics become measurable.

**Estimate**: Sonnet 25–30 lane-hours · Fable 35–45 · Opus ~50. Call it **35–50
lane-hours, about one working day of wall clock** at present width.

### Sprint 06 — the operator door, then the privilege boundary

V3-0.29 to a landed trust root, then unpark V3-1.9, then V3-1.9b, then V3-1.10.

**Estimate**: 55–75 lane-hours, **open-ended if V3-0.29 does not close at the escalated
tier**. It is at round 5 with two fresh self-authorisation paths found by the escalated
reviewer, so treat the upper bound as real.

### Sprint 07 — the machine's memory

V3-2.9 landed, then restore proven into the meteorite container, V3-2.10's credential
runbook, and the backup HR-2171 defines.

**Estimate**: 55–70 lane-hours.

## The road to cutover

| | lane-hours |
|---|---|
| Sprint 05 | 35–50 |
| Sprint 06 | 55–75 |
| Sprint 07 | 55–70 |
| Sprint 08 — V3-4.1, V3-4.2, then the operator's go | 25–35 |
| **Total, zero new discovery** | **170–230** |

At six concurrent lanes and ~70% utilisation: **43–56 hours of wall clock, roughly 4.5–6
working days.**

### Why no member would give that as a date, and neither will the orchestrator

Because "zero new discovery" is contradicted by every day of measurement so far.
**32 rows were filed today against 10–12 closed.** Their sources split three ways and only
one responds to engineering:

| stream | rows today | decays with engineering? |
|---|---|---|
| operator requirements | 9 | **No** — unbounded, and healthy; it is him steering |
| one external audit (Fable) | 8 | one-time; recurs only when another is commissioned |
| defects found by working | ~15 | **yes**, and sprint 05 is aimed at exactly this stream |

A date is honest only once the third stream visibly decays. **That is measurable**: track
rows-filed-by-working against rows-closed across sprint 05. If the ratio inverts, the
totals above become a date. If it does not, the totals are fiction and saying so is the
only honest answer.

## Where the members disagree

- **Does V3-0.23 gate the chain?** Fable: no — its premise was never reproduced, and
  V3-0.29 r4 produced a clean report with V3-0.23 open, which settles it empirically.
  Opus: the row is real but misdiagnosed, and its §0 measurement closes it — the 120-second
  harness kill composed with V3-0.40 *is* the recorded symptom. **Both agree nothing should
  wait on it.** The orchestrator adopts Opus's diagnosis, having reproduced the kill
  directly, and keeps the round-3 watchdog work on its own merits.
- **Close sprint 04 first?** Fable: yes, explicitly — "a plan whose own measuring
  instrument stopped being used cannot ask the operator to trust its estimates." Adopted;
  closed at `990b8db`.
- **One row or six for the contract class?** Sonnet argues the orchestrator has been
  dispatching each instance of one defect class as an independent row, and points out that
  V3-0.44's own text says "fourth instance" — after which the fifth and sixth were filed the
  same way. Its recommendation, adopted: do not re-scope the six already in flight, but file
  the audit **before the seventh appears**. Filed as V3-0.50.

## Operator asks, batched at sprint open rather than sequenced late

Fable's operational point, adopted and already sent: unbounded human latency must be
**overlapped**, not absorbed at the end where it becomes the critical path.

1. Share a My Drive folder with `bpa-dev-orch@bpapro-agents.iam.gserviceaccount.com`.
2. Which credentials besides Drive and GitHub must the machine hold (V3-2.10's runbook)?
3. Should an unpark authorisation that meets no park expire, and after how long
   (V3-0.29 F7)?
4. V3-1.7 awaits his restatement.

## What each member said the orchestrator is getting wrong

Recorded because it is the part most likely to be quietly dropped.

- **Sonnet**: triaging one recurring defect class as N independent rows. Correct.
- **Fable**: measuring its own throughput on the wrong window, by 4×, and feeding that
  number to the people it asked to plan. Correct, and corrected above.
- **Opus**: not measuring the harness its own fleet runs inside — a two-minute experiment
  that nobody had run in four rounds of work on the row it explains. Correct.
