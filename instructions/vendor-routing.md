---
id: vendor-routing
layer: L1
status: binding
audience: orchestrator
tags: [vendor, routing]
summary: Route work by risk, independence, capability, and available capacity, not by brand loyalty or round-robin.
---

# Vendor Routing

Route work by risk, independence, capability, and available capacity, not by
brand loyalty or round-robin.

- Use capable coder lanes for implementation; use lower-cost lanes for bounded
  inventory, mechanical checks, and routine diagnosis when evidence quality is
  unchanged.
- Select reviewers independently from the coder session. For Tier A, prefer a
  different vendor; for Tier B, a fresh same-vendor lock-review is permitted
  only under `review-policy.md`.
- Treat quota and provider health as routing signals. Record a thin, failed, or
  unavailable route in the mission evidence; redirect eligible work instead of
  waiting idle.
- Preserve role separation even when the vendor pool is constrained. If normal
  independent review is unavailable, use only the documented emergency
  consortium and keep any deferred review visible.
- Give every dispatched lane an explicit file allowlist, denylist, acceptance
  rows, risk tier, verification commands, and stop condition. Do not silently
  widen a lane because another route is busy.

## Provider-economy default (quota-asymmetric routing)

When the Human has directed load off one provider (see `instance/params.yaml:
orchestrator.coder_provider` and the decision rows it cites), that direction is
a ROUTING RULE, not a preference:

- New coder and reviewer lanes default to the provider with headroom. Full
  stop. Convenience of an existing dispatch path is not a reason to use the
  scarce provider — build or use the paved path to the abundant one.
- Dispatching a lane on the scarce provider requires a RECORDED justification
  in the lane's dispatch record (e.g. the abundant provider is down, the task
  needs a capability the abundant provider lacks, or the Human asked). No
  record, no scarce-provider lane.
- The top orchestrator session's own tier follows the same economy: prefer the
  configured lean tier for routine coordination when the scarce quota is low;
  escalate only for genuine incidents and drop back after.
- This section exists because discipline held in an agent's memory did NOT
  survive contact with convenience (instance/decisions/HR-210.md): the economy
  directive was standing and lanes still went to the scarce provider because
  the path was easier. A rule in the repo is delivered to every session at
  start; a rule in memory dies with the session.
