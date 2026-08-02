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
- Preserve role and session separation even when the vendor pool is constrained;
  use the normal same-provider consortium defined by `review-policy.md` rather
  than inventing deferred cross-vendor debt.
- Give every dispatched lane an explicit file allowlist, denylist, acceptance
  rows, risk tier, verification commands, and stop condition. Do not silently
  widen a lane because another route is busy.

## Review-diversity priority (roles over vendors)

When choosing review shape, ROLE/PERSONA diversity outranks vendor diversity
(instance ruling: `instance/decisions/HR-212.md`):

- The default review for gated work is a consilium of reviewers with DIFFERENT
  roles/optimization targets (e.g. correctness/QA lens, security lens,
  delivery lens) running on the provider with headroom. Different targets
  catch different defect classes; identical reviewers on two vendors mostly
  catch the same ones twice.
- Cross-vendor review remains a SUPPLEMENT for the highest-risk gates when it
  is cheaply available — it is no longer the thing a review waits for.
- Session independence between coder and every reviewer is mandatory and
  unchanged; a consilium seat is a separate session, not a second opinion from
  the coder's own context.

## Role-first model selection (any provider, per seat)

HR-212 originally pinned the default review consilium to GPT models. That
provider pin is lifted (instance ruling: `instance/decisions/HR-1565.md`):

- Role/persona diversity (above) remains the primary axis. Provider and model
  choice for each consilium SEAT is a capability-fit decision, not a fixed
  default: raise a seat wherever its role and task are best served, including
  on Anthropic, independent of which provider hosts the rest of the consilium.
- Capability fit, quota/headroom, security tier, and exact provider/model
  provenance for the seat are recorded with the review, same as any other
  routing decision under this document.
- Anthropic roles are appropriate wherever their capabilities fit the seat;
  the constrained-cost/simple-mechanical tier (Spark-class routing, see
  `HR-1430.md`) stays limited to non-Tier-A, simple/mechanical work regardless
  of provider.
- This does not relax the provider-economy default below or session
  independence (`review-policy.md`): a scarce-provider seat still needs a
  recorded justification, and every seat remains a separate session.

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
