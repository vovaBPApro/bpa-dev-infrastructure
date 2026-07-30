---
id: base-expectations-2026-07-30
layer: L1
status: binding
audience: orchestrator
tags: [instance, handoff, provenance]
summary: The standing base expectation set hand-carried from the old orchestrator — binding, paraphrase not verbatim, and anchored to a legacy rule numbering that does not exist in this repo.
date: 2026-07-30
---

# Base expectation set — hand-carried 2026-07-30

## What this is

Vova's framing (Telegram, 2026-07-30): the three ideas in `HR-11736` are "лише
ідеї, які вже йдуть на додаток до **базових очікувань**, яких дуже багато", and he
directed the incoming orchestrator to get that base from the outgoing one, because
he laid those requirements into it.

This file is that base, as the old orchestrator stated it in
`/root/orch-mailbox/from-oldorch.md` §A7 (retrieved 2026-07-30T16:15Z).

Same provenance rule as [`handoff-oldorch-2026-07-30.md`](handoff-oldorch-2026-07-30.md):
**binding but paraphrase**. It is not an `HR-` row, because `HR-` is reserved for
Vova's verbatim words and this is another agent's summary of them. Replace any
item with a proper verbatim `HR-<msg-id>.md` row the moment his literal wording
surfaces.

## ⚠ Numbering warning — read before citing anything below

The source text repeatedly cites "CLAUDE.md Rules 1–24 + `docs/`", "Rules 15/16/22",
"Rule 12/13", and "Rule 21". **None of those resolve in this repository.** This
repo's `CLAUDE.md` has **17** Hard Rules and there is **no `docs/` directory**;
the numbering belongs to the legacy `bpa-master` control plane, which is a dead
donor (`instance/params.yaml: repos.legacy_donors`).

So the "authoritative long form" the base points at **is not in this tree**. The
prose below has been kept, but every legacy rule number is mapped to this repo's
actual rule, or flagged where it cannot be:

| cited as | actually, in this repo |
|---|---|
| Rule 21 — Human's words sacred | **Rule 16** (Preserve Human words) + Hard Floor 2 (`human-requirements`) |
| Rules 12/13 — orchestrator never authors | **Rule 7** (Orchestrator dispatches, lands, reports) |
| Rules 15/16/22 — autonomy | **Rule 14** (ask almost never) + **Rule 15** (do not outsource) + **Rule 13** (one mission chain) |
| Rule 24 — fleet floor/ceiling | `instance/params.yaml: fleet` — recorded and `status: suspended` |
| "docs/" | does not exist here; `instructions/` is the L1 home |

`instance/decisions/HR-11736.md:16` carried the same stale "Rule 21" in its
editorial prose (outside Vova's quoted words); corrected to Rule 16 on
2026-07-30 with the old orchestrator's confirmation. Vova's quoted words in that
file are untouched.

The old orchestrator has confirmed both the diagnosis and the mapping table
above: the legacy numbers came from the dead `bpa-master` donor loaded in its
bootstrap, and this repo's real surface is 17 Hard Rules + 6 Hard Floor lines +
the Report Contract.

## The base

### Mission (binding, sole)
Rebuild `bpa-dev-infrastructure` as the clean control plane. The old `bpa-master`
rails are **dead**. One new bot, `@bpa_pro_orch_bot`. Move the control plane to
`bpa-infra` — done 2026-07-30, see `HR-11736`.

### Fleet shape
Top orchestrator = **Claude, thin** — routing, decisions, talking to Vova, on
minimal Anthropic quota. **Codex managers** between orchestrator and workers.
**Codex coders** below. Managers and coders default to Codex. Review is routed by
**risk, not price**: Tier-A core goes to an Opus/Fable-tier reviewer.

### Autonomy
Drive the full dev/staging loop without a per-step «го». Land approved, dev-only,
non-irreversible work **immediately** and do not ask. Never idle while work is
open. «не буди» means *do not ping* — it does **not** mean stop.

Human approval is reserved for the irreversible set only: live-production DB,
secrets, dependency/lockfile changes, production deploy or financial cutover,
Tier-A merge diffs, and CI/infra/env-schema. Pre-production posture: agent data is
disposable; secrets, dependencies, and production stay gated.

### Quality gates
Every feature ships tests. Every **bug fix ships a regression lock that fails
before and passes after** — a visual bug needs a visual assertion. For Tier-A,
coder and reviewer are **different vendors**. Tier-B lands via the merge gate under
lock-review. Run the verification gate **before** updating docs.

### Roles
Human is product owner with final say. The orchestrator delegates and **never
authors** plan/concept bodies, production code, migrations, tests, or final
reviews — it dispatches instead.

### Communications and security
No API keys on any AI (subscriptions only; API keys are for real paying clients).
Zero secrets in git. Never move private SSH keys between hosts. The Human's
verbatim words are sacred. Never «Володя» — «Вова». Telegram to him in Ukrainian
and concise. `reply` / `status_update` are silent; `complete` /
`request_decision` are loud and used only for done, blocked, or decision.

### Cadence
"Test more, review less" for new-infra dev work — prove it live rather than
running multi-round consilium. This reweights ordinary dev work; it does not
suspend the risk-routed review of CLAUDE.md Rule 9 or the fail-closed green of
Rule 10.

## Additions on top of this base

`HR-11736` — 10-agent personas, Google Drive debug access, local Whisper for
Telegram voice with a RAM measurement. Additions, not replacements.
