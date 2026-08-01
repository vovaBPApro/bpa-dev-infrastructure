---
id: instance-readme
layer: L1
status: informational
audience: all
tags: [instance]
summary: What the instance/ bucket is — this-installation facts, explicitly non-portable.
---

# instance/

This-installation facts for this specific BPA control-plane deployment:
operator, phase, repo registry, concrete numbers, and the verbatim Human
directives that drive the work. Everything here is **non-portable** — it names
this operator, this VM, these repos, these decisions.

Generic, product-agnostic rules live in `instructions/` (L1) and must never
hard-code names or numbers; they cite parameters defined here instead (e.g.
`instance/params.yaml`). Splitting a rule from its instance value keeps the
generic layer give-to-a-friend clean while this bucket holds the specifics.

Contents: `params.yaml` (named instance values), `decisions/HR-<msg-id>.md`
(verbatim Human directives, sacred), `parked.md` (L2/L3 content parked here
until its repo exists). No secrets, tokens, or keys ever live in this bucket.

Operator-specific retained sources and their concise routed contract are indexed
by `instance/operator/README.md`.

`decisions/inbox.jsonl` and `decisions/triage.jsonl` are runtime capture
artifacts (the daemon's auto-mirror of raw inbound Human messages, §2.4) — they
carry verbatim chat text and are git-ignored, never committed; only the
routed `HR-<msg-id>.md` files are tracked.

## Where the full Telegram history actually lives (2026-08-01)

Found while answering the operator's demand to re-read the whole log: the
in-repo bidirectional history-logger (ML-11, `daemon/history-logger.ts`) is
landed in code but is not writing on the live host — see workboard row W-29.
The two sources that DO hold real verbatim history right now:

- `instance/decisions/inbox.jsonl` — live capture, one JSON object per line
  (`msg_id`, `chat_id`, `ts`, `text`), inbound only, 2026-07-30 11:53 onward.
  Git-ignored (see above).
- `/root/orch-mailbox/vova-telegram-archive/` — archive handed over by the
  prior orchestrator: `vova-telegram-FULL-two-sided.txt` (his messages AND
  bot replies, chronological, 2026-06-30 through 2026-07-31 16:32) and
  `vova-telegram-by-message-id.txt` (his messages only, same range). This
  directory is **outside this git repo entirely** (`/root/orch-mailbox/`, not
  under `bpa-dev-infrastructure/`) and is not tracked anywhere — it would not
  survive the meteorite test (Hard Floor 5). Not yet fixed; tracked as
  workboard row W-30.

Together these two sources cover 2026-06-30 through the present with no gap.
Neither is a substitute for fixing W-29 — until that lands, every new message
depends on `inbox.jsonl` alone, which is inbound-only and itself untracked.

## Retired generated-only rows

- `HR-11552` was removed because it contained no captured Human words and
  duplicated the retained HR-11549/HR-11555 branching and layout provenance.
- `HR-11562` and `HR-11564` were removed because they contained only generated
  descriptions of completed consilium procedure; the retained consilium
  artifacts remain the evidence.
