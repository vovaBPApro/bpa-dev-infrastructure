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
- A pause on broad fan-out never prevents landing already-approved work or
  completing an already-authorized bounded lane.
