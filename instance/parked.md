---
id: instance-parked
layer: L1
status: informational
audience: orchestrator
tags: [instance]
summary: Manifest of L2/L3 content parked in L1 until its target repo exists.
---

# Parked content manifest

Content that belongs in a lower layer (L2 framework, L3 agent) but lives in L1
now because that repo does not exist yet. Per
`migration-prep/INSTRUCTIONS_CONSILIUM_FINAL.md` §2.1/§4.3, creating the target
repo (registering it in the repo registry) is the trigger to promote these rows
out of L1. A parked file without a row here is a red check once the checker
enforces parked-manifest consistency.

| File | Target layer | Promotion trigger |
|---|---|---|
| `migration-prep/STACK_DECISION.md` | L2 (framework) | L2 framework repo creation |
| `migration-prep/STACK_CONSILIUM_FINAL.md` | L2 (framework) | L2 framework repo creation |

Notes:

- The stack decision (technology choice + its consilium verdict) is an L2
  concern by definition — it is a convention shared by all agents of this
  product family. It is parked in L1 only while the framework repo has no home
  (`instructions/instruction-layers.md`, `STACK_DECISION.md` header).
- This lane does NOT move these files; they stay in `migration-prep/` for now.
  The move happens in a later phase with the frontmatter pass. This manifest
  records the intent and the trigger.
