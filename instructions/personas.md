---
id: personas
layer: L1
status: binding
audience: all
tags: [personas, roles]
summary: Phase-1 static persona mechanism — behavior-only profiles attached to compose packs; never authority.
decision: [hr-146, hr-161]
---

# Personas — phase-1 static behavior profiles

A persona is a hand-authored, static behavior profile attached to a lane's
context pack at compose time. It shapes HOW a lane reasons, what questions it
asks first, and how it communicates — the anti-monoculture layer that keeps ten
lanes from being ten copies of one model (NI-1, `hr-146`; brainstorm status and
convergence in `hr-161`).

## The invariant: behavior, never authority

«Поведінку, а не повноваження.» A persona NEVER changes authority, permissions,
review tiers, reviewer independence, capabilities, or evidence gates. Confirmed
by the operator (Telegram 203): behavior never weakens review tiers or gates.
Concretely:

- A persona "veto" is expressed only through the existing ACCEPT/REJECT/NO-GO
  verdicts and the landing gate — no new authority channel, no vote weights,
  no trust-based check skipping.
- Personas are vendor-neutral text. The same persona on two sessions is still
  two independent reviewers; persona reuse never substitutes for cross-vendor
  review independence.
- Every profile MUST begin (first body line, exact match, validator-enforced)
  with:

  > BEHAVIOR ONLY: this persona changes how a lane reasons and communicates.
  > It NEVER changes authority, permissions, review tiers, capabilities, or
  > evidence gates.

- On any conflict, the pack's instruction documents and interim directives win.

## The model (decided, Telegram 203)

Personas are a PERSISTENT roster of named individuals, stable across missions.
Per mission or consilium, a sub-team is selected from that roster and each
selected lane gets its persona attached at compose time. Phase 1 implements
exactly this: persistent profile files + compose-time selection. The QA and
Security personas exist now as review-lens personas — human qualities layered
on the existing reviewer role's review passes (Telegram 210).

## What phase 1 is NOT

«Без навчання. Без пам'яті. Без адаптації. Без складних моделей.» No learning,
no memory, no runtime adaptation, no operator-model persistence, no confidence
scores, no trust matrix, no reputation, no weighted consilium votes, no learned
relationships. Auto-adaptivity is parked in the backlog at LOW priority
(operator ruling, Telegram 203). The RPG competence matrix, mutual agent
models, and the adaptive operator model are future-RFC material only.

## Where things live (instruction-layers routing)

- Mechanism (this doc, the profile format, `tools/instructions/personas.ts`,
  the `--persona` flag): generic, survives a stranger's product → L1
  `instructions/` + `tools/`.
- Roster (the actual named profiles, built around THIS operator's
  counterbalances): this-installation facts → `instance/personas/<name>.md`,
  one file per persona. The registry directory IS the registry.

## Profile format

Frontmatter (closed key set, validated):

- `persona:` kebab-case name, must equal the filename.
- `role:` a REAL infra role — orchestrator | manager | coder | reviewer
  (`instructions/roles.md`). Nothing else exists.
- `role-mapping:` `real`, or `proposed` when the roster wants a role the infra
  lacks (architect, researcher, operations, PM, UX…). `proposed` requires
  `proposed-role:` and grants NOTHING — the persona rides the named real
  role's ordinary authority. Extending the role model itself is wanted but is
  a separate, later, evidence-based step gated on observed persona usage
  (Telegram 203).
- `status:` `draft-for-discussion` — every phase-1 profile is draft data
  awaiting the three-way finalization (`hr-161`).
- `summary:` one line.

Body: the mandatory BEHAVIOR ONLY header line, then exactly these sections:
`## Optimization target`, `## Strengths`, `## Review & communication style`,
`## Consilium participation`, `## Blind spots`. Communication styles are
grounded in the operator collaboration guide
(`instance/operator/How-to-Work-With-Vova.md`).

## Mechanics

- Attach: `bun tools/instructions/compose.ts --role coder --persona denys` —
  appends the profile as a delimited `## PERSONA (behavior only)` section plus
  a manifest row. Unknown or invalid persona: hard error, exit 2. Without
  `--persona`, output is byte-identical to the persona-less composer
  (test-locked).
- Validate the registry: `bun tools/instructions/personas.ts --repo .` — exit
  non-zero on any invalid profile. This is standalone by design:
  `bun tools/instructions/check.ts` walks `instructions/` docs, and the roster
  deliberately lives in `instance/` with its own schema.

## The five open questions from the study — and their answers

Copied from the NI-1 study (top-★ set); answered by the operator on 2026-07-30
(Telegram 203), which is what authorized this doc's "decided" statements above.

1. **Persona ↔ real-role mapping.** Should the 10 personas map onto the real
   lane types, or should the infra role model be extended with new functional
   roles? — *Answered: map onto CURRENT real roles now; extending the role
   model is a separate evidence-based later step.*
2. **Persistent individuals vs lane flavors.** Stable named team members
   re-cast into every mission, or reusable profiles with no cross-mission
   identity? — *Answered: a persistent roster of named individuals; sub-teams
   composed from it per mission/consilium.*
3. **Authority boundary.** Do personas ever relax review tiers, reviewer
   independence, evidence gates, or fail-closed rules? — *Answered: never;
   veto stays expressed only through the existing verdicts + gate.*
4. **Scope and trigger.** Static hand-authored profiles only — and when does
   implementation start? — *Answered: phase 1 static, implemented
   immediately.*
5. **What does "adaptive" minimally mean for phase 2?** — *Answered:
   auto-adaptivity goes to the backlog at low priority; nothing adaptive is
   built now.*
