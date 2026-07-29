---
id: orchestrator-fallback
layer: L1
status: binding
audience: orchestrator
tags: [orchestrator, playbook, vendor, restart]
summary: Extra binding rules for an orchestrator running on a fallback (non-Anthropic, e.g. GPT) model when Fable/Anthropic quota is exhausted.
decision: [hr-11573]
---

# Orchestrator on a Fallback Model

When Fable / Anthropic quota is exhausted, the Human raises the orchestrator on
a non-Anthropic model (for example GPT). That session runs a different harness
than the Claude one, so several defaults no longer hold. These rules add to
`orchestrator-playbook`; they never relax it.

## Session start — no Claude hook fires

A fallback harness does not fire the Claude `SessionStart` hook, so nothing
auto-loads the instruction context. The fallback orchestrator MUST make the
session-load tool its mandatory first step: run `bun tools/instructions/session-load.ts`
(may land slightly later than this doc — reference it by path). Until that tool
exists, load the equivalent by hand before dispatching anything: `instance/params.yaml`,
every open (`pending`/`routed`) row under `instance/decisions/`, and every
`audience: orchestrator` and `audience: all` binding doc. Skipping load is a
fail-closed `NO-GO` on the session, not a shortcut.

## Memory is vendor-local cache, not a source of truth

Claude's memory directories are invisible to a fallback orchestrator. Any fact
that work depends on must live in the repository — `instance/`, the decisions
ledger, and the instruction docs — never only in memory. Treat memory as a
per-vendor cache that a switched-in orchestrator cannot read (aligns with the
consilium's memory-as-cache rule). If something load-bearing exists only in
memory, promote it into the repo before it can be lost across a switch.

## Review independence under a shared vendor

When the orchestrator and its coder lanes share one vendor, cross-vendor review
independence is gone and must be recovered from elsewhere. Prefer a genuine
cross-vendor reviewer whenever any other quota allows it. Only when no
independent cross-vendor route is available, use the emergency same-provider
consortium of SEPARATE sessions per `review-policy` ("Blocked-review fallback"),
with its per-domain passes on one SHA. Every review record must state whether a
deferred cross-vendor review is still owed; the fallback never lowers the tier.

## Human-verbatim finalization stays deferred, never skipped

Any step reserved to the primary (Fable-tier) model — the final pass over a
Human verbatim artifact — cannot be performed on a fallback model. Do not
silently skip it and do not let a non-primary model reword the sacred verbatim
block. Mark the artifact `deferred-to-primary` and surface it the moment the
primary model returns.

## Switchover handoff — both directions

Switching orchestrator vendors is a state handoff, not a hot swap. Before and
after every switch, write a handoff note recording current fleet state so the
incoming orchestrator reads it first: open lanes and branches
(`git branch --list 'ag-*'` plus the worktree list), unlanded terminal reports
in the reports dir, and open decision rows. Switching back reverses the same
step. An orchestrator that starts without reading the latest handoff is
operating blind — reconstruct from durable records first (see `restart-recovery`).

## What needs no special action

The Telegram daemon and Human-capture path are vendor-independent: the daemon
inbox mirror keeps writing regardless of which model runs the orchestrator, so
no special handling is required there.
</content>
