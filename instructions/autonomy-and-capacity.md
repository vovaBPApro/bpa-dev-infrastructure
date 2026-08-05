---
id: autonomy-and-capacity
layer: L1
status: binding
audience: orchestrator
tags: [autonomy, capacity, workboard]
summary: Execute approved reviewed dev-only work immediately; run the fleet to its capped width; bound repair to what blocks the product; ask only for the irreversible set.
---

# Autonomy and Capacity

Default posture: execute approved, reviewed, dev-only work immediately. Do not
ask for a routine “go” when the work is outside the irreversible set.

- Human approval is required for secrets, dependency or lockfile mutations,
  production deployment/cutover, live production-data mutation, CI or
  infrastructure-policy changes for this control plane, and destructive cleanup
  whose safety cannot be proven. Tier-A landing follows its required approval
  boundary.
- Route approval requests through an asynchronous decision channel. Never hold
  a lane on a blocking prompt; record the decision request and continue eligible
  work.
- A blocked or gated item parks only itself. Keep dispatching other autonomous,
  open work and preserve the parked item as `NO-GO` with evidence.
- While open work exists, run the flat lane fleet at its **capped width**, not at
  an aspirational one. Legitimate width limiters are the operator's cap,
  demonstrated resource limits, serialized landing/stand operations, and risk
  controls—not habit, missing routine confirmation, or an empty landing queue.
- **The cap is a correctness control, not a comfort setting.** Width above the
  host's real capacity does not merely slow the fleet, it corrupts the fleet's
  evidence: the suite is the measurement instrument and it stretches under load
  until deadlines kill passing runs. A wider fleet that produces less trustworthy
  greens is a worse fleet. The current cap is `instance/params.yaml: fleet.cap`,
  ruled by `instance/decisions/HR-2456.md` and measured by workboard row
  V3-0.34; `instance/decisions/HR-2342.md` carries the reasoning it was first
  written with.
- **A reviewer is a lane.** Count review slots against the cap, so a cap of N
  buys N−1 coder lanes plus one review slot, and a row on an escalated review
  tier consumes two of the N. Read the number from `fleet.cap` rather than from
  this sentence — a cap written into prose is the drift `tools/check-fleet-cap.ts`
  exists to catch.
- **The cap is per repository; the host limit is not.** Each repository may run
  up to the cap (`instance/decisions/HR-2398.md`), because concentrating lanes on
  one repository buys merge work rather than progress. Caps do **not** sum across
  repositories: the total stays inside measured host capacity, and when the two
  rules conflict the host wins and the orchestrator says so rather than quietly
  exceeding it.
- **Working single-threaded is a violation of this rule, not diligence.** The
  orchestrator doing implementation work inline, one item at a time, while other
  open rows sit idle is the failure this section exists to prevent. Parallelism
  is the reason the host is paid for: a one-thread orchestrator on a large box
  delivers laptop throughput at server cost.
- **Running below the cap with open work is a REPORTABLE condition.** When lanes
  are idle and the board still has work the fleet could be doing, the orchestrator
  tells the Human — unprompted — that there is not enough work in flight. Do not
  wait to be asked. (Operator order, 2026-07-31, Telegram 281: «Коли стає менше
  трьох паралельних лейнів, уже маєш мені писати і казати, що роботи малувато;
  треба накидать». Verbatim record: `instance/decisions/HR-281.md`.)

  HR-281 was given when the configured floor was ten, so "fewer than three" named
  a fleet that had nearly stopped. Under a cap of three or five the literal
  threshold collapses — "below three" is ordinary operation at either cap, and
  reporting it every time would be noise, which is the opposite of what he asked
  for. The **intent** is preserved and the arithmetic is not: report when the
  fleet is idle against available work, not on a fixed number. If the operator
  wants the literal threshold back, that is his call to make, and this paragraph
  is the flag that it was changed rather than quietly ignored.
- **Report capacity as NUMBERS, not intent.** "N lanes running, each doing X" —
  never prose about what is planned.
- A pause on broad fan-out never prevents landing already-approved work or
  completing an already-authorized bounded lane.

## Repair is bounded by what blocks the product

Infrastructure work is **not** finished, it is **bounded**. Repair what obstructs
product work. Everything else discovered on the way is reported and recorded, not
scheduled: an open row that blocks nothing is a measurement, not a task.

Before scheduling any infrastructure row, ask: **does this block product work
today?** If not, it is reactive — fix it when it actually obstructs.

The reasoning matters as much as the rule, because a self-hosting control plane
argues against it by default. The orchestrator builds the orchestrator, so every
repair exposes further defects as soon as the repaired part is used; a board can
take on rows faster than it closes them and still look busy. Self-hosting repays
that through **compounding** — fix one bottleneck, every lane benefits — and
compounding is a function of fleet width. At a wide fleet it repays. At a narrow
capped one, with a reviewer holding a slot, the multiplier approaches 1 and the
argument for "infrastructure first" largely disappears. Do not keep paying for
leverage that the current width does not provide.

Binding ruling and the measurements behind it: `instance/decisions/HR-2369.md`.

## An estimate is an estimate under this infrastructure

When the Human asks how long something takes, he is asking **under this
infrastructure and this approach** — a fleet of lanes working in parallel at the
current cap — not how long one worker would take in one thread.

- State the assumed concurrency with every estimate. A lane-hour total with no
  stated denominator is not an answer to his question.
- Convert at the **measured** width, not the configured one. A configured floor
  that the fleet has never actually reached is not a denominator; using it
  produces a number that describes no possible world.
- Prefer wall-clock under the current cap over an abstract lane-hour total.

Binding ruling, and the cost of not having recorded it sooner:
`instance/decisions/HR-1494.md`.

## The mission artifact is the approval for a coder lane

An orchestrator-created mission with scope, acceptance rows, and risk tier IS the
approval artifact for a coder lane. The `Discussion -> Plan -> Review -> Approval`
lifecycle (see `development-workflow`) applies before the lane is dispatched, or
again when scope materially changes — not as a per-lane re-ask. A dispatched coder
works from that mission and does not re-ask the Human unless the irreversible set
is reached; asking for a routine "go" on already-approved, in-scope work is itself
the failure.
