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

The still-open composition-interface requirement is retained in
`instance/decisions/HR-98.md`; this document owns its L1 routing mechanics.

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
tentative routing, and a **mandatory** `state` from this closed vocabulary:

| `state` | meaning | required field | disposition |
|---|---|---|---|
| `pending` | captured, not yet triaged or routed | — (72h SLA on `date:`) | **open** — delivered in full to every pack and session load |
| `owed` | triaged, obligation identified, work not done | `tracked-by:` | **open** — listed in every session load until closed |
| `routed` | binding force moved into a doc or param | `routes-to:` | closed |
| `parked` | deliberately set aside | `review-by:` (in the future, within the parked horizon) | deferred — neither delivered nor discharged, but counted |
| `superseded` | replaced by a later ruling | `superseded-by:` | closed |

`owed` exists because the older vocabulary conflated "ruling routed into a doc"
with "work request discharged". That conflation is why a perfect capture had
nowhere honest to sit, and it is what made a good capture the act that hid a
requirement.

**Absence is open, and unknown is a FAIL.** A file with no `state:`, or a value
outside this set, is a checker FAIL **and is treated as open and delivered**
until fixed — fail-visible, never fail-hidden. A stateless file must never be
quietly skipped by the thing that reads it.

**Every closure claim names ONE target, and it must resolve on every run.**
`routes-to:`, `tracked-by:`, `superseded-by:` and a triage row's structured
`closes:` take a single token — a workboard row id present in
`instance/workboard.md`, an existing repo path, or a doc id in the generated
index — and nothing else. Three shapes are refused, each with its own repair:

- **prose** — anything with whitespace in it. Write the target; put the sentence
  in the body. A value like `not done yet, tracked in instance/workboard.md`
  resolved under the first version of this rule, because one token in it named
  a real file. A claim whose own words say the work is not done must not pass.
- **a container** — `instance/workboard.md`, any directory, any `README.md`.
  These exist regardless of what happened to the thing the claim was about, so
  they discharge nothing. Name the row, doc or file inside.
- **a target that does not exist** — the original rule, unchanged.

Resolution is re-verified on every run rather than at write time. That is what
makes board renumbering safe: rename a row an HR file points at and the checker
goes red without the HR file being touched. **This catches only claims made in
the structured field.** Free-text `reason` prose cannot close anything, but
neither is it read: a triage row asserting completion in prose with
`answer_status: "answered"` is not currently checked against anything, which is
how the NI→V3 renumbering's three false closures survived. Requiring `answered`
to be backed by a resolving `closes:` is a separate, larger row (V3-2.18).

**A park is bounded in both directions.** `review-by:` is mandatory, FAILs once
past, and FAILs when set further out than `instance/params.yaml:
ledger.parked_horizon_days`. A date with no ceiling is not a bound — parking
something for seventy years and deleting it are the same act. Parked rows are
not delivered, so their COUNT is stated next to the open count in every pack
preamble and every session load: undelivered and uncounted is invisible.

Enforced by `tools/instructions/ledger.ts` (`checkHrStates`, `checkHrAging`,
`checkTriageClosures`), surfaced by `tools/instructions/check.ts`, and run by
`gate/lane-exit.sh` on every lane exit and by `gate/land.sh` on every landing —
there against the **merged result**, after the merge and before the push, on the
rollback path. A pre-merge run alone inspects the tree the candidate is about to
change; two lanes can each be green alone and red together, and only the merged
tree shows it. Pre-existing debt is enumerated with an owner and an expiry in
`instance/hr-state-exemptions.tsv`; a new violation is not in that file, so it
fails immediately.

A `state: routed` row is **provenance only** — its binding force lives
in the doc named by `routes-to`, which MUST actually carry the restriction. A
routed row whose target does not carry the restriction has silently dropped it;
before routing, land the restriction in its target (a doc, or `instance/params.yaml`
when it is an instance fact) so it stays pack-visible. Example: HR-11570 parks all
work except the L1 instruction mechanics; it is `state: routed`, so that active
scope restriction is carried pack-visibly by `instance/params.yaml: phase.active_scope`,
not left only in the routed row.

A daemon auto-mirror into the ledger is **planned, not yet wired**
(`instance/params.yaml: capture.mode` is `manual`); until it is proven live,
triage is manual.

## Why

The previous split had no routing rule, so instructions were duplicated,
drifted, and lost. First-yes routing recorded as data, one home with references,
and machine checks make every instruction findable and updatable in one place.
Changes land through the gate like code — no silent edits.
