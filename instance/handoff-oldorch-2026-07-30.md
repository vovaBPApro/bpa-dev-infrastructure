---
id: handoff-oldorch-2026-07-30
layer: L1
status: binding
audience: orchestrator
tags: [instance, handoff, provenance]
summary: Context hand-carried from the old (Codex) orchestrator on cutover day — binding, but paraphrase, not Vova's verbatim words.
date: 2026-07-30
---

# Hand-carried context from the old orchestrator — 2026-07-30

## Provenance and why this is not an `HR-` row

`instance/decisions/HR-<msg-id>.md` is reserved for **Vova's verbatim words**
(CLAUDE.md Rule 16 / `human-requirements`). The items below reached this
installation differently: on cutover day the outgoing Codex orchestrator wrote
them into `/root/orch-mailbox/from-oldorch.md` as its own **summary** of things
Vova had told it in a session whose transcript is not on this host.

They are therefore **binding but paraphrased**. Storing them as `HR-` rows would
launder a paraphrase into "the Human's words", which is exactly what Rule 16
forbids. When Vova's literal wording for any item surfaces, open the proper
`HR-<msg-id>.md` row with that wording and replace the corresponding entry here
with a pointer to it.

Source: `/root/orch-mailbox/from-oldorch.md` §A2, retrieved 2026-07-30T15:40Z by
the incoming Claude orchestrator (session `51581504-a41a-4f77-8b71-a194f81b0bc6`,
host `bpa-infra`). Old orchestrator's framing: "treat as authoritative, route
into your ledger".

## 1. Agent architecture (binding)

The top orchestrator is **Claude**, and it is deliberately kept **thin** —
routing, decisions, and talking to Vova, on minimal Anthropic quota. Beneath it
sit **Codex managers**; beneath those, **Codex coders**.

This is the first statement in this repo of a provider/vendor shape, so
`instance/params.yaml` now carries an `orchestrator:` block citing this file.
Note the consequence: the top orchestrator being thin is a *cost* posture, not
just a style preference — heavy authoring work belongs below it.

## 2. "Review less, test more" (binding, new-infra dev work)

For new-infrastructure development, favour **live testing** over heavy
multi-round consilium review. Rationale given: live testing found every real bug
in this cutover, while review rounds did not.

Bounded — this does **not** touch CLAUDE.md Rule 9 (risk-routed independent
review for auth, migrations, money, secrets, CI, orchestrator core) or Rule 10
(green is fail-closed). It reweights *ordinary new-infra dev work* toward proving
things live. A live test that is not actually run is still `NO-GO`.

## 3. Channel decisions of 2026-07-30

- Vova now uses **only** the new bot `@bpa_pro_orch_bot`, and talks to the
  Claude orchestrator. He has stepped off the old-bot channel.
- The Claude orchestrator escalates to the **old orchestrator** via
  `/root/orch-mailbox/` (`to-oldorch.md` out, `from-oldorch.md` in, ~60 s poll).
  The old orchestrator is the backstop and absorbs trifles instead of
  forwarding them to Vova.
- A literal three-way Telegram group was **rejected**: two bots cannot hear each
  other in Telegram.

## 4. Git access

Vova does **not** want to add the deploy key by hand. Resolution: the **old host
bridges GitHub** — it holds account push access, and commits flow
old-host → gate → origin, then origin → this host. Durable self-sufficiency still
eventually wants the deploy key (`/root/.ssh/id_github_deploy` is already
generated here, unauthorized as of this writing), but it is not required now.

## 5. Security posture (hard)

- **No API keys on any AI, anywhere.** Subscriptions only; API keys exist solely
  for real paying clients.
- **Zero secrets in git** (already CLAUDE.md Rule 2 / Hard Floor 4).
- **Never move or share private SSH keys between hosts** — public halves only.
- The Human's verbatim words are **sacred**; never edit or prune them.
- Never address him as «Володя» — «Вова».
- Telegram to him in Ukrainian, concise.
- `reply()` / `status_update()` are **silent**; `complete()` /
  `request_decision()` are **loud**. Ping only on done, blocked, or decision.

## 6. Pre-production posture

All agent data is **disposable** until Vova declares go-live. Only live
production data is untouchable. Secrets, dependency policy, and production
deploy remain gated regardless (CLAUDE.md Rule 14).
