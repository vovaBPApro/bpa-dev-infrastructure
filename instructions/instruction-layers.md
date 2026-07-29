---
id: instruction-layers
layer: L1
status: binding
audience: all
tags: [routing, instruction-layers]
summary: The three instruction layers (infra / framework / agent) and the routing rule for updates.
decision: [hr-11557]
---

# Instruction Layers

How agent instructions are split across repositories so nothing gets lost and
every update has one obvious home. Decided with the Human on 2026-07-29
(`decision: hr-11557`; verbatim in `instance/decisions/HR-11557.md`). Full design
rationale: `migration-prep/INSTRUCTIONS_CONSILIUM_FINAL.md`.

## The three layers

- **L1 — Infrastructure** (`bpa-dev-infrastructure/instructions/` + `instance/`):
  everything generic — orchestration, lanes, gate, branching, review, process.
  Product-agnostic by construction. `instance/` holds this installation's facts.
- **L2 — Framework** (the agent-framework repo): framework architecture, stack
  and coding conventions, the design system, and how an agent integrates. Stack
  and conventions are L2 **by definition**. While no L2 repo exists, such content
  is `layer: L2-parked` in L1 with a row in `instance/parked.md`.
- **L3 — Agent** (each agent's own repo): domain knowledge, prompts, and
  everything specific to that one agent. A frameworkless adopter may merge L2
  into L3; the routing function below is unchanged.

Same skeleton in every repo: a short root `CLAUDE.md` (`AGENTS.md` symlinked), an
`instructions/` dir of frontmatter-tagged docs, and a generated `README.md` index.

## Routing rule (where does an instruction live / get updated)

**Step 0 — scope by location.** Binding instruction text may live only in root
`CLAUDE.md`, `instructions/`, `instance/` (params/registry), or an open
decisions-ledger row (interim). Journals, `migration-prep/`, subsystem READMEs,
memory, chat, and dispatch prompts are non-binding and may only cite ids
(evidence/history carries `status: informational`).

Split a compound directive into its smallest statements; for each, first "yes"
decides:

1. **Instance fact** — operator, host, repo registry, concrete numbers, phase,
   verbatim words, this project's history? → **L1 `instance/`**. A rule carrying
   an instance value SPLITS: rule text continues to Q2–Q4, the value goes to
   `instance/params.yaml`, in the same commit.
2. **Survives a stranger's completely different product** (after
   parameterization)? → **L1 `instructions/`**.
3. **Applies to every agent of this product family** (incl. stack, language,
   design system, integration contract)? → **L2** (or `L2-parked` in L1 + a
   `parked.md` row while L2 has no repo).
4. Otherwise → **L3**, that one agent's repo.

Tie-breakers: unsure L2-vs-L3 → **L3**; promote to L2 on the second consuming
agent as one move-and-delete commit with a 5-line tombstone (`moved-to: <id>`)
kept for one landing cycle. Precedence on conflict is a single order **L1 > L2 >
L3**; a lower layer narrows only via declared `overrides`. Updating is the same
lookup: grep the id in the generated index → exactly one home (checker-enforced
uniqueness), recorded once in frontmatter, never re-litigated.

## Delivery — compiled, not hand-pasted

Lanes never hand-copy L1 excerpts. `tools/instructions/compose.ts` packs a
role's mission preamble: the role's **baseline pack always in full**, plus docs
matched by `--tags` from the closed vocabulary (`instance/tags.conf`) — tags only
ADD, never remove the floor; an unknown tag is a hard refusal. Referenced docs
are **materialized** as pinned-SHA snapshots into the lane workspace, so ephemeral
lanes never chase foreign-repo paths. The preamble's manifest (id, hash, source
SHA) is echoed by the lane and diffed by the landing gate — a wrong echo is NO-GO;
break-glass (`DISPATCH_OVERRIDE`) is only for lanes repairing the tooling.

## Capture — mechanical at the source

Every Human directive is recorded in the decisions ledger as
`instance/decisions/HR-<telegram-msg-id>.md`: the verbatim block (sacred), date,
tentative routing, and a `state` of `pending | routed | parked | superseded`.
Open (`pending`) rows are **interim-binding** the moment they land — the composer
appends them to every pack until the routed doc exists, and aging checks re-redden
stale rows. A daemon auto-mirror into the ledger is **planned, not yet wired**;
until then triage is manual.

## Why

The previous split had no routing rule, so instructions were duplicated,
drifted, and lost. First-yes routing recorded as data, one home with references,
and machine checks make every instruction findable and updatable in one place.
Changes land through the gate like code — no silent edits.
