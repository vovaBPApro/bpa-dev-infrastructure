# {{REPO_NAME}} Agent Rules

## Mission

{{MISSION}}

This is a {{LAYER}} repository in the BPA instruction hierarchy. It carries only
what belongs to its layer; generic infrastructure law stays in L1 and is
referenced, never copied.

## Instruction Routing

Instructions live in three layers — L1 infra, L2 framework, L3 agent — plus L1
`instance/` for installation facts. One instruction has one home; reference,
never copy. Full routing rule (Step 0 + Q1–Q4, delivery, capture) lives in L1:
`instructions/instruction-layers.md`.

<!-- hard-floor:begin -->
## Hard Floor

Generated from `instructions/*` docs carrying `floor: true` (edit the source doc's `floor-line:`, then regenerate — hand-edits here fail the checker).

<!-- hard-floor:end -->

## Load Map

- `instructions/` — this layer's binding law, one frontmatter-tagged doc per
  rule. `instructions/README.md` is the GENERATED index (do not hand-edit).
- `CLAUDE.md` — this contract. `AGENTS.md` is a symlink to it; do not add
  vendor-specific rule forks.
- For any generic orchestration, lane, gate, branching, or review rule, route to
  L1 `instructions/` via the id in the generated index.

## Report Contract

Every report to the Human must contain:

1. the exact commit SHA;
2. the command the Human can run to verify it;
3. the result: `clean`, `NO-GO`, or the concrete blocker.

No SHA means not done. A percentage, explanation, screenshot, heartbeat, or
promise is not completion evidence. If evidence is absent, stale, contradictory,
or unverifiable, report `NO-GO` and the next bounded action.
