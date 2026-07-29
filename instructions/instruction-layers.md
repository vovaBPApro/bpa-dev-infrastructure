# Instruction Layers

> **Status note (2026-07-29):** an adversarial consilium ordered by the Human
> (Telegram 11562/11564) reviewed this document. Its verdict KEEPS the three
> layers, the first-yes routing spine, and one-home-reference-never-copy, and
> HARDENS everything else: an `instance/` bucket for this-installation facts,
> machine-checked frontmatter routing, compiled context packs instead of
> hand-injected excerpts, and daemon-side capture of every Human directive.
> The operative design and its implementation order:
> `migration-prep/INSTRUCTIONS_CONSILIUM_FINAL.md` (§4 is the diff plan for
> this file — the rewrite lands after the checker tooling exists, per its own
> sequencing rule). Until then this document remains the binding routing rule.

How agent instructions are split across repositories so nothing gets lost and
every update has one obvious home. Decided with the Human on 2026-07-29
(Telegram 11557; full verbatim in `migration-prep/STACK_DECISION.md`). Key
verbatim (Vova):

> «…все, що generic, все, що пов'язано безпосередньо з оркеструванням, з
> інфраструктурою, бранчуванням, процесом розробки, оці речі, що спільні для
> всіх, їх тримати самі в цій інфраструктурі репозиторію. […] І щоб, коли нам
> треба оновити інструкції, то оркестратор одразу розумів дуже чітко, де саме
> цю інструкцію треба оновити, в якому репозиторії, і чого саме це стосується.»

## The three layers

- **L1 — Infrastructure** (`bpa-dev-infrastructure/instructions/`): everything
  generic — orchestration, lanes, gate, branching, review, verification,
  process. Product-agnostic by construction: this layer must make sense for a
  completely different project run by different people.
- **L2 — Framework** (the agent-framework repository): framework architecture,
  the design system and its quality tooling configuration, conventions shared
  by ALL agents, and how an agent integrates into the framework.
- **L3 — Agent** (each agent's own repository): domain knowledge, prompts, and
  everything specific to that one agent.

## Routing rule (where does an instruction live / get updated)

Ask in order; the first "yes" decides:

1. Would this instruction survive unchanged if the product were completely
   different? → **L1**.
2. Does it apply to every agent of this product family? → **L2**.
3. Otherwise → **L3**.

## Binding rules

- One instruction, one home. Never copy an instruction between repositories;
  reference it. The dispatching orchestrator injects the needed L1 excerpts
  (lane contract, report shape, binding process rules) into each mission
  prompt, so product lanes obey L1 without L1 files being duplicated into
  product repos.
- Every repository keeps the same shape: a short root `CLAUDE.md` entry point
  (with `AGENTS.md` symlinked to it) plus an `instructions/` directory with a
  `README.md` index line per document.
- Each repository's root `CLAUDE.md` states this routing rule, so any agent in
  any repo can answer "which repo do I update" without asking.
- Instruction changes land through the same gate as code: lane, review per
  `gate/review-policy.conf`, landing record. No silent instruction edits.

## Why

The previous split across three repositories had no routing rule, so
instructions were duplicated, drifted, and lost. A first-yes-decides question
plus one-home-with-references makes every instruction findable, updatable in
exactly one place, and auditable through git history.
