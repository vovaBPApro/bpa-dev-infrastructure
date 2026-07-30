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

## Session start — verify the load happened, never assume it

A fallback session started by `orchestrator/launch.sh` DOES get the standing
context: the launcher declares the shared `SessionStart` hook on the codex
command line (`--config hooks.SessionStart=…` plus
`--dangerously-bypass-hook-trust`, which is required — without it the hook is
dropped and nobody can answer the trust prompt in a detached pane). The hook is
the same script the Claude harness runs, so the load is identical. It arrives
with the first turn, and the session shows `SessionStart hook (completed)`.

A fallback session started any other way — by hand, or on a harness whose hooks
are not wired — auto-loads nothing. If the confirmation above is not visible,
treat the load as not done and follow this deterministic sequence — do not stop
on a missing tool:

1. First try `bun tools/instructions/session-load.ts`.
2. If that file is missing or exits non-zero, do not stop: manually read, before
   any dispatch, `CLAUDE.md`, `instance/params.yaml`, every
   `instance/decisions/*.md` whose `state` is `pending`, and every binding doc
   with `audience: orchestrator` or `audience: all`.
3. Record the exact files loaded in the mission rollup.

Skipping load entirely is a fail-closed `NO-GO` on the session, not a shortcut.

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

Only one act is reserved to the primary model: the finalization or pruning of a
Human verbatim source block. A fallback session must not perform that act, and
must not let any non-primary model reword the sacred verbatim block. Everything
else around Human requirements stays the fallback session's job: it still
preserves, quotes, routes, implements from, and reports on them. When the
reserved act is reached, mark the artifact `deferred-to-primary` with a durable
marker (so it can be found and resumed) and surface it the moment the primary
model returns — a deferral is never a silent skip.

## Switchover handoff — both directions

Switching orchestrator vendors is a state handoff, not a hot swap. Before and
after every switch, write the versioned JSON handoff with
`bun tools/instructions/handoff.ts write --ts <ISO> --from <name> --to <name> --from-vendor <vendor> --from-session <id> --to-vendor <vendor> --to-session <id> --reports-dir <path>`.
The runtime artifact lives at
`orchestrator/runtime/handoffs/<ISO-ts>-<from>-to-<to>.json` (gitignored);
the tracked contract is `tools/instructions/handoff.schema.json`. The tool
collects the source SHA, all Git worktrees with lane branches, terminal reports
in the supplied reports directory, and pending decision rows.

The incoming session runs
`bun tools/instructions/handoff.ts validate --file <handoff.json> --now-ms <epoch-ms>`
before relying on it; the default freshness window is 30 minutes. Then it runs
`bun tools/instructions/session-load.ts`, whose output includes the latest
handoff or the exact warning "no handoff found — degraded start". Switching
back reverses the same procedure. A missing, invalid, or stale handoff is a
degraded start: reconstruct from durable records first and do not claim a clean
startup verdict (see `restart-recovery`).

## Human capture — read `capture.mode`, do not assume the mirror is live

Human-capture behavior is governed by `instance/params.yaml: capture.mode`
(`manual | daemon`), not by the model. While `capture.mode: manual`, the daemon
inbox mirror is NOT a proven live transport: the incoming orchestrator captures
every Human directive into the decisions ledger by hand before dispatch and
verifies it with the ledger checker. A missing inbox transport is a visible
degraded mode — `NO-GO` on a binding "capture is live" claim — not "no special
handling required". `capture.mode` flips to `daemon` only once the mirror is
proven to be writing `inbox.jsonl` live; only then does capture become
vendor-independent with no per-session hand-capture step.
