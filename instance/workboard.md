---
id: workboard
layer: L1
status: informational
audience: orchestrator
tags: [instance]
summary: Open tracked work rows for this installation — every known-open item has exactly one row here until it lands or is explicitly dropped.
---

# Workboard — open tracked rows

One row per open item. A row leaves this file only by landing (record the SHA
in the row, then delete it next pass) or by an explicit dropped-with-reason
note. Derived-work items live here; Human directives stay in
`instance/decisions/` and are only referenced.

## Open

- **W-08 — memory-sweep defect triage**: live sweep + triage DONE (proposal at
  `.cache/infra-lanes/diag/ag-memory-sweep-triage.report.md`: 38 memory entries
  + 3 oversized `.mdc` rules files). APPLICATION pending — adding `home:` anchors
  / demoting rules bodies is deliberate judgment work (several entries concern
  dead bpa-master rails); to be done by the NEW orchestrator post-cutover.
  (Sweep tool landed 05689cdd; daily timer installer exists, not yet installed.)
- **W-10 — install memory-sweep daily timer** on the host once W-08 triage
  is done (orchestrator/install-memory-sweep.sh).
- **W-11 — confirm the top orchestrator's RESTING model tier with Vova** (low
  priority; ask on his next natural exchange, do NOT page him for it). The box
  now runs `claude-fable-5` (`instance/params.yaml: orchestrator.top_model`,
  pinned in the gitignored `runtime.env` per the old orchestrator's 2026-07-31
  ruling). That value is recorded **as run**, not as his decision — three
  positions are on record and they disagree: Vova, 2026-07-30, «верхній
  оркестратор має бути на Fable … щоб квота мінімально використовувалася»; the
  old orchestrator's A8, a lean tier at rest with Fable as the *escalation* tier;
  and `orchestrator/launch.sh`'s source default, `claude-opus-5`, which is what an
  unpinned launch silently resolved to. When he answers, open a proper
  `HR-<msg-id>.md` with his wording and point `top_model` at it. Until then the
  gap is provenance, not configuration — the box is not blocked.

- **W-14 — make /status human-useful** (`instance/decisions/HR-150.md`): the
  command currently prints raw daemon JSON + `plan: n/a`; Vova gets zero value
  from it. It should answer, in a few plain lines: what is being worked on, how
  many lanes and their states, last landed thing, anything blocked. Daemon
  runtime code → coder lane; keep the honest-fields work (W-13 relabel) intact.

- **W-15 — attachment-bearing Telegram messages are lost to the orchestrator**
  (found 2026-07-30 ~21:02Z): Vova sent 4 photo documents + BPA_ROLES_AND_REVIEW.md
  (inbox.jsonl msgs 156-160 record the filenames), but the `<channel>` tags with
  `attachment_file_id` never surfaced in the orchestrator session — text
  messages around them arrived fine. The file_ids are not recoverable from
  inbox.jsonl (it stores no file_id), so the content was unretrievable and the
  Human had to be asked to re-send. Two fixes to scope: (a) daemon-side — mirror
  attachment file_ids (and ideally auto-download to a spool dir) into a durable
  record the orchestrator can query later; (b) find and fix why the channel
  delivery dropped them (concurrent-turn buffering?). Daemon runtime code →
  coder lane; reproduce first with a test document before fixing.

### Migration-loss restore queue (2026-07-30)

Source: parity audit against the **live** old daemon at
`/root/orch-mailbox/live-daemon-src/` (29 files). An earlier audit used
`migration-prep/reference-daemon/`, which turned out to be the *template* the
live daemon was generated from — so it was blind to everything the live host
gained after diverging. Treat the live source as the baseline, not the snapshot.

**Enabler, verified**: the lost modules' own tests are in this repo's history —
`git ls-tree ffe05409:tools/claude-telegram-daemon/` carries
`alarm-router.test.ts`, `nudge-ledger.test.ts`, `status-collector.test.ts`,
`vendor-quota-scraper.test.ts`, `history-logger.test.ts`, `model-switch.test.ts`,
`mcp-rebind.integration.test.ts` and `test/orchestrator-watchdog.test.sh`. Start
every restore lane from `ffe05409`, not from scratch.

Only ONE of these losses had a recorded decision. The rest went silently — see
the governance row below.

- **ML-1 — terminal failure-alert bridge**: live classified 8 failure classes off
  `tmux pipe-pane` (usage limit, 429/overload, auth, stalled, failed, exited,
  network, fatal); ours has 3 regexes, all context-limit. We are blind to quota
  exhaustion and provider overload — they read as a generic stall. *lane*
- **ML-2 — autonomy keep-alive layer**: four live paths pushed the orchestrator
  (hourly `/compact`, 15-min fleet ping, maintenance audit, per-message reply
  chase). All gone; every `tmuxPasteText`/`tmuxSend` call site here is
  operator-initiated. The direction inverted — live pushed the orchestrator, ours
  pushes the Human. Contradicts `autonomy-and-capacity`. *lane*
- **ML-3 — heartbeat multi-signal liveness**: one ongoing writer (turn end), and
  stale heartbeat → kill with no alive-check, so a long Codex turn is killed
  mid-work. IN FLIGHT: `ag-watchdog-restores`.
- **ML-4 — `/health` `connected` is fail-open**: live computed
  `transportConnected && alive`; ours reports `activeServer !== null`, so it reads
  connected with a dead socket. *trivial*
- **ML-5 — preflight auth depth**: live banned 9 env vars incl.
  `CLAUDE_CODE_USE_BEDROCK`/`USE_VERTEX`/`GEMINI_API_KEY` and grepped
  `~/.codex/auth.json` for an embedded key; ours checks 3. A metered-billing leak
  through the Human's "subscriptions only" rule. IN FLIGHT: `ag-watchdog-restores`.
- **ML-6 — vendor quota display**: Codex 5h/7d, Claude weekly/credits, and the
  "session expired — re-login" warning. Local `.jsonl` parsing, no browser. *lane*
- **ML-7 — alarm audience routing**: live split `internal` (orchestrator TUI) from
  `human` (Telegram) via an `x-bpa-alarm-audience` header; ours is single-audience,
  so all fleet telemetry pings the Human's phone. *lane*
- **ML-8 — per-message unanswered ledger**: live tracked every inbound per chat and
  nudged the orchestrator at 60s/90s before escalating. Ours keeps
  `most-recent-inbound-wins`, so a burst of 5 messages collapses to 1. *project*
- **ML-9 — `MISSION:` text parsing**: live parsed `MISSION: <text> | ttl=…` and
  `MISSION DONE/CLEAR` pre-dispatch. `grep parseHumanMissionCommand` → 0 hits
  here. Related dead seam: we still write `mission-inbox.log` and nothing reads
  it. *lane*
- **ML-10 — delivery fallback + detach detection**: `/reply`, `/ack`,
  `/mcp/rebind`, `/sendDocument`, `/sendPhoto` and `isMcpChannelDetached` all
  absent, so a dropped MCP channel has no alarm and no fallback. *lane*
- **ML-11 — bidirectional history logging**: no outbound record exists, so
  post-incident forensics is impossible. *lane*
- **ML-12 — watchdog escalation ladder**: collapsed to a flat hourly repeat; lost
  stall-tick ladder, multi-signal progress signature, 6 alert classes with
  signature-keyed suppression, and `HAS_TASK` passivity. *lane*
- **ML-13 — docker disk remediation**: ours detects and alerts only; live pruned
  at ≥80% and escalated at ≥88%, written after a real ENOSPC outage.
  IN FLIGHT: `ag-watchdog-restores`.
- **ML-14 — restart context re-analysis**: last ~12h of chat injected on restart
  with newest-wins reconciliation; a restarted orchestrator now resumes stale
  intent. *lane*
- **ML-15 — fleet/manager/lane visibility in `/status`**: manager tier, per-lane
  provider/model/branch/age, capacity gauge, spawn-failure signals. *project*
- **ML-16 — small user-visible losses**: `модель` bare-word alias; `/model`
  applying to the RUNNING session via `tmuxSend` (ours pins for next launch only);
  `/start_claude <plan>` argument; Codex updater-prompt skip; `Notification` hook
  → loud ping. *trivial each*

- **ML-GOV — no capability may leave the tree unrecorded**: none of ML-1..16 was
  routed through `instance/parked.md` and no `dropped: <reason>` row exists for
  any of them, though `migration-prep/INSTRUCTIONS_CONSILIUM_FINAL.md:315`
  requires exactly that. The one well-done drop is the Python removal — rationale
  in a doc, ideas preserved as a checklist in `daemon/ACCEPTANCE.md:5-9`. Make the
  requirement enforceable at the gate rather than in prose; an instruction nobody
  runs is how this happened. *lane*

### New-infra queue (post-cutover, from the Human 2026-07-30)

Build on the NEW orchestrator, planned WITH the Human there. Verbatim seed:
`instance/decisions/HR-11736.md`; expanded verbatim detail (2026-07-30 evening
brainstorm): `instance/decisions/HR-146.md`. A further brainstorm exists as a
ChatGPT share link (msg 144/59); Vova will send it as PDF — study on arrival.
- **NI-1 — team personas**: give "characters"/personas to the whole 10-agent
  team — per-persona role + strengths, and a rule for which personas join which
  discussion level (consilium composition). Detail: HR-146 §NI-1. EXPANDED by
  the 2026-07-30 evening brainstorm (HR-161: adaptive user model, RPG matrix,
  mutual agent models — explicitly BRAINSTORM not a decision per his msg 167;
  an RFC + chat history + BPA_ROLES_AND_REVIEW.md are incoming (ARRIVED
  2026-07-30 ~23:15 via old-orch relay: orch-mailbox/vova-inbound-20260730/);
  HR-185 authorizes implementing the CERTAIN subset (phase-1 static
  compose-pack personas) ahead of the RFC; orchestrator
  phased opinion given in reply 169: static personas as compose-pack profiles
  first, adaptive modeling as a separate metrics-backed RFC; finalize
  three-way before implementation).
- **NI-2 — Google Drive debug access**: service account so the orchestrator and
  any agent can read/verify Drive contents for debugging (e.g. QuickBooks/Gmail
  import testing) without Vova screenshotting. He can do the one-time connect
  himself. Detail: HR-146 §NI-2.
- **NI-3 — local Whisper voice transcription**: local Whisper (STT only) on this
  server; multi-language (uk first, en required, possibly pl); consumed BOTH by
  the orchestrator (Telegram voice messages) and by the product's chat (voice
  record button in the framework) — ONE model, TWO consumers, but product and
  development stay separated things (HR-146 §147). Needs testing + RAM
  measurement (251 GB headroom). Detail: HR-146 §NI-3.

## Deep consilium residuals (2026-07-29)

Source: `migration-prep/DEEP_CONSILIUM_AUDIT_2026-07-29.md` (4 Codex auditors).
The CRITICAL/HIGH findings already LANDED: /status honesty (running_agents vs
lane_worktrees, git timeout) `7fe97222`; gate provenance 7 fixes incl.
self-review reviewer!=author + partial-identity + NUL-byte `b3a42d14`; dispatch
marker/override 3 fixes `c1ad0c7e`; flaky lease-race test `d1b64754`. These rows
were the remaining MEDIUM/LOW.

This audit is now FULLY CLOSED. All residuals landed (all review=accepted,
cross-vendor Claude Sonnet): W-07 batch --skip-review test coverage `274672f`;
W-09 handoff future-ts guard `e1af73c`; W-11 gate secret-scan decoded-match
lock `e172ff6` (base64-decode detection already shipped in `77f3fa9f`; entropy
excluded as too false-positive-prone; split-string documented as the residual
boundary); W-12 gate reviewer-identity hardening `1c920ba`; W-13 /status
process-local honesty relabel `fa2a974`.

## Parked (needs Human go or a phase flip)

- **P-01 — VM migration to the 64 GB machine** (`instance/migration-day.md`)
  — parked by HR-11570 («Поки роби лише 1») until Vova's go.
- **P-02 — stack Phase-0 spike with go/no-go numbers**
  (`migration-prep/STACK_CONSILIUM_FINAL.md`) — parked by HR-11570.
- **P-03 — daemon cutover to this repo's daemon/** (flips
  `capture.mode: manual → daemon` in `instance/params.yaml`; inbox ledger
  check then fail-closes) — needs the migration/cutover moment.
