---
id: autonomy-and-capacity
layer: L1
status: binding
audience: orchestrator
tags: [autonomy, capacity, workboard]
summary: Execute approved reviewed dev-only work immediately; keep the fleet saturated; ask only for the irreversible set.
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
- While open work exists, keep the flat coder-lane fleet saturated within the
  configured floor and ceiling. Legitimate width limiters are demonstrated
  resource limits, serialized landing/stand operations, and risk controls—not
  habit, missing routine confirmation, or an empty landing queue.
- **Working single-threaded is a violation of this rule, not diligence.** The
  orchestrator doing implementation work inline, one item at a time, while other
  open rows sit idle is the failure this section exists to prevent. Parallelism
  is the reason the host is paid for: a one-thread orchestrator on a large box
  delivers laptop throughput at server cost.
- **Fewer than three running lanes is a REPORTABLE condition.** When the running
  lane count drops below three, the orchestrator tells the Human — unprompted —
  that there is not enough work in flight and that more should be queued. Do not
  wait to be asked. (Operator order, 2026-07-31, Telegram 281: «Коли стає менше
  трьох паралельних лейнів, уже маєш мені писати і казати, що роботи малувато;
  треба накидать». Verbatim record: `instance/decisions/HR-281.md`.)
- **Report capacity as NUMBERS, not intent.** "N lanes running, each doing X" —
  never prose about what is planned.
- A pause on broad fan-out never prevents landing already-approved work or
  completing an already-authorized bounded lane.

## The mission artifact is the approval for a coder lane

An orchestrator-created mission with scope, acceptance rows, and risk tier IS the
approval artifact for a coder lane. The `Discussion -> Plan -> Review -> Approval`
lifecycle (see `development-workflow`) applies before the lane is dispatched, or
again when scope materially changes — not as a per-lane re-ask. A dispatched coder
works from that mission and does not re-ask the Human unless the irreversible set
is reached; asking for a routine "go" on already-approved, in-scope work is itself
the failure.
