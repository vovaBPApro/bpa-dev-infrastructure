---
id: migration-parity
layer: L1
status: binding
audience: orchestrator
tags: [instance, migration, parity, audit]
summary: What survived the migration to this control plane and what did not — measured against the real live old daemon, in four slices.
date: 2026-07-30
---

# Migration parity — what survived and what did not

## The question this answers

Vova, 2026-07-30: «я взагалі без поняття, що змігрувано, а що ні», after `/model`
turned out to have been lost silently. He asked not to discover the rest one
stubbed toe at a time. This is the single inventory, replacing the drip-feed.

## Why the earlier answer was wrong

The first audit compared this repo against `migration-prep/reference-daemon/`.
That is the **template** the live daemon was generated from — its own
`CLAUDE.md:3` says "This repository is a **template** … Keep it generic". The
live daemon ran from `tools/claude-telegram-daemon/` on the old host and had
diverged from that template over months.

So the earlier "we diffed and it matched" check was **green and meaningless**.
Proof: `grep -rn "'/model'" migration-prep/reference-daemon/` returns zero hits —
the baseline could not see `/model` either. Compounding it, 9 of the 25 paths the
snapshot itself declared required never landed, and
`migration-prep/verify_reference_daemon.sh` validates against the *remote clone*
rather than the local tree, so it exits 0 while what we hold is incomplete.

**The baseline is now `/root/orch-mailbox/live-daemon-src/`** — 29 files,
`server.ts` ~147KB, the real thing, delivered by the old orchestrator.

## Totals

Four slices, each verified with evidence on both sides (`file:line` live, and the
specific check here — a zero-hit grep counts, a hunch does not).

| slice | PRESENT | LOST | DROPPED | UNCLEAR |
|---|---|---|---|---|
| Commands and operator-facing surface | 33 | 30 | 0 | 2 |
| Supervision, alarms, autonomy | 11 | 25 | 0 | 1 |
| Status, telemetry, quota | 6 | 43 | 1 | 0 |
| Transport, delivery, state, hooks, launch | 42 | 40 | 1 | 1 |

**DROPPED is 2 out of ~140 losses.** That is the governance finding: almost
nothing that left this tree left it on purpose, or at least on a purpose anyone
wrote down. The two recorded drops are the lane-counting method
(`instance/decisions/HR-11582.md`, done right, and it fixed his "0 coders while 3
running" complaint) and the `systemd-run --scope` confinement — and the second is
cited only by a test assertion and a code comment, not a decision row.

## Two of his own directives were silently reverted

This is the part that matters most, because it is not a feature gap.

1. **The 📭 placeholder.** Live carries his request in the code
   (`server.ts:1791-1800`): "Human asked NOT to see the '📭 No reply forwarded …'
   placeholder — it is pure noise during long heads-down turns (the orchestrator
   is busy, not stuck)." Live logs it to stderr. We send it to his chat — and
   today's watchdog tune *softened the wording* of a message he had banned
   outright.
2. **Auto-restart of a live session.** Live disabled it by default
   (`orchestrator-watchdog.sh:219-222`) because it "caused more harm than good —
   every MCP detach / stale binding killed a working session", with a two-level
   flag for explicit wedged-session recovery only. We re-enabled it
   unconditionally. Worse, the two causes it named — MCP detach detection and the
   stale-binding false-absence guard — are both LOST here, so we have *fewer*
   protections against them, not more.

Neither has an `HR-` row. Two independent instances is a pattern.

## How things were lost — three mechanisms

Naming these matters more than the individual rows, because they predict the next
loss.

1. **Wrong baseline.** Anything the live host gained after diverging from the
   template was invisible to every check we ran.
2. **Reader migrated, writer stayed behind.** The code that consumes a state file
   came across; the code that produces it did not. Each half looks healthy in
   isolation and no test fails. This silently disarmed the dead-orchestrator
   alarm, made `/done` tell him the watchdog was asleep when it was not, and left
   seven `/status` fields printing `n/a` forever. The inverse also happened:
   `mission-inbox.log` is still written here, but its watchdog and launcher
   readers stayed behind.
3. **Invisible to a switch-case grep.** The live daemon has **three** pre-dispatch
   interceptors ahead of the `text.startsWith('/')` gate: permission-reply, model,
   and human-mission. `/model` was missed because it has no `case '/model'`. The
   same blind spot still hides `MISSION:` / `MISSION DONE` / `MISSION CLEAR`.

## What is confirmed intact — the honest other half

Not a pure regression list. Verified present and working: all 7–8 MCP tools
(byte-identical surface); permission approval buttons and the `y <id>`/`n <id>`
text intercept; decision buttons; both Codex tmux relays end to end; every slash
command; message buffering, flush, ordering and dedup; `relay.ts` byte-identical;
the SSE alive-wins takeover and `state_restore`; pairing, allowlist and group
gating; attachments in and out over MCP; long-message splitting; reactions.

And several places **this** tree is better: `/status` is tri-state honest
(distinguishing "unknown" from a verified zero — the fix for his original
complaint); the mission store moved to SQLite with a *declared writer*; the
turn-end relay writes its heartbeat before delivery, so a delivery misconfig
cannot fake death; per-launch MCP config instead of global settings pollution;
directory-trust preflight; singleton lock with lease fencing; and a Claude Stop
relay the live daemon never had.

## The ranked restore queue

Tracked as `ML-1..16` in [`workboard.md`](workboard.md). Highest impact first:

1. **Vendor re-login warning** — an expired login now reads as a generic stall;
   every lane fails and nobody can tell why. Cheapest high-value restore.
2. **Heartbeat multi-signal liveness** — ours writes only at turn end, and a stale
   heartbeat goes straight to kill, so a long turn gets a *working* orchestrator
   killed mid-work.
3. **Terminal failure-alert bridge** — 8 failure classes live (quota exhausted,
   429/overload, auth, network, crash) versus our 3, all context-limit.
4. **Alarm audience routing** — everything rings his phone; there is no internal
   channel. Restore this *before* the alert bridge, or one loss becomes a
   phone-spam incident.
5. **Delivery fallback** (`/reply`, detach detection) — when the MCP channel
   drops, there is currently no way to reach him at all.
6. **`MISSION:` interceptor**, the third missing pre-dispatch parser.
7. **The autonomy keep-alive layer** — four paths that pushed the orchestrator are
   gone, and the direction inverted: live pushed the orchestrator, ours pushes
   Vova.

## The enabler

The lost modules' **own tests are in this repo's history**. `git ls-tree
ffe05409:tools/claude-telegram-daemon/` carries `alarm-router.test.ts`,
`nudge-ledger.test.ts`, `status-collector.test.ts`,
`vendor-quota-scraper.test.ts`, `history-logger.test.ts`, `model-switch.test.ts`,
`mcp-rebind.integration.test.ts` and a 26KB `test/orchestrator-watchdog.test.sh`.
That snapshot's `server.ts` differs from the live copy by only 32 lines. Start
every restore lane at `ffe05409`; most drop a cost tier.

**But port with judgement, not verbatim.** The old code ran on a different host
under different conditions, so a faithful restore can import a signal that is
simply false here. Measured example: live's watchdog took tmux
`#{session_activity}` as its primary liveness signal for Codex. On this box, tmux
3.4, that field does **not** advance for a *detached* session — and detached is
the only shape an orchestrator ever has. On the live orchestrator session it read
13521s stale while the pane was producing output that same second;
`#{window_activity}` read 0s. A verbatim restore would therefore have judged every
healthy session dead and killed it — turning a fidelity win into a
kill-everything watchdog. Restore the intent, verify the mechanism.

## What stops the next one

`tools/state-contract/check.ts` fails the build when a durable artifact is read
with no writer in this repo — mechanism 2 above, caught automatically. It works
and fail-closes.

Two gaps in it, both open: its extension list is
`json|db|lock|lease|heartbeat|outbox|watermark|tsv|pid`, so `.log`, `.txt`,
`.jsonl`, `.state` and `.startup` are invisible **by construction** — which is
exactly the set that went lost. And `ML-GOV` on the workboard: the rule that a
capability may not leave the tree without a recorded reason already exists in
prose (`migration-prep/INSTRUCTIONS_CONSILIUM_FINAL.md:315`) and was ignored ~140
times. It belongs at the gate, not in prose.
