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
