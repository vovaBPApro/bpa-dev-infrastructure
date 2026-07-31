---
id: workboard
layer: L1
status: informational
audience: orchestrator
tags: [instance]
summary: Open tracked work rows for this installation — every known-open item has exactly one row here until it lands or is explicitly dropped.
---

# Workboard — tracked rows

Every row starts with exactly one machine-readable `<!-- status: ... -->` marker.
Allowed values are `open`, `done`, `blocked`, and `superseded`. A `done` row
also cites the landing/evidence SHA that proves it. Missing or malformed status
is a hard parse failure, never an implicit zero. Derived-work items live here;
Human directives stay in
`instance/decisions/` and are only referenced.

Source inventories and open directives that feed this board include
`instance/migration-parity.md`, `instance/decisions/HR-101.md`, and
`instance/decisions/HR-203.md`. The operator-guide routing wrapper is
`instance/decisions/HR-254.md`.

## Product (HR-330) — the rebuild

Directive and his verbatim words: `instance/decisions/HR-330.md`. Document
pointers: `instance/product-docs-index.md`. Evidence:
`reports/stack-postmortem.md`, `reports/product-docs-inventory.md`.

- <!-- status: blocked --> **PR-1 — ONE repo, not three** (blocked: the Human must create the named empty repository; no landing SHA exists). Decided 2026-07-31 after the post-mortem
  contradicted the initial plan). He first chose `bpa-shell-v2` / `bpa-bill-v2` /
  `bpa-mila-v2`; `reports/stack-postmortem.md` theme 2 identifies the multi-repo,
  independently-versioned topology as a root cause in its own right. Surfaced to
  him, and he agreed to consolidate. Named by him and CONFIRMED 2026-07-31: **`agentic-bpa`**. Layout: `apps/shell`,
  `apps/bill`, `apps/mila` (no `bpa-` prefixes inside — his call), shared `packages/` — one lockfile, one React version,
  one routing tree, one CI graph. He creates the empty repo (an SSH key can push
  but cannot CREATE a repo on GitHub); porting starts the moment it exists.
- <!-- status: open --> **PR-2 — kill iframes, keep the feel.** No implementation or landing evidence exists. Post-mortem theme 1, confirmed against
  commit history: iframes bought instant switching by keeping apps mounted but
  exported browser boundaries into product behaviour. Replacement: one SPA
  document, client-side routing, persistent shell chrome, route-level prefetch.
  Prior art already exists — `docs/concepts/CONCEPT_spa_agent_modules.md` on
  `bpa-shell` origin/main. Read it before designing.
- <!-- status: open --> **PR-3 — Bill's first scope is SOURCE DOCUMENTS, not reports.** No implementation or landing evidence exists. Import ALL
  QuickBooks transactions; import from email to supplement them with documents;
  match and finalize. Acceptance bar, his words: reports must reconcile
  ONE-TO-ONE with QuickBooks. Reports themselves come later; statutory (the
  second double-entry layer) is designed later still.
- <!-- status: open --> **PR-4 — Mila is a dumb empty stub.** No implementation or landing evidence exists. Nobody ever tested it.
- <!-- status: open --> **PR-7 — email means GMAIL** (no porting/landing evidence exists; confirmed 2026-07-31: «Gmail а під Outlook там затичка»).
- <!-- status: open --> **PR-8 — the transaction create/edit form is the most important form in Bill** (HR-535, 2026-07-31). Statutory is NOT a later layer: statutory data is entered, synced and matched inside the same form as all managerial transactions, so the form cannot be built managerial-only and extended later. Requires: his verbatim Telegram complaints (archive delivered by old-orch), old-repo plans both implemented and open, and how it was actually implemented. He explicitly allows rebuilding rather than porting HERE — the only such area. Sequence: gather -> design with Impeccable -> consilium -> his approval -> implement.
- <!-- status: open --> **PR-9 — the site chat is a core capability, not a support widget** (HR-537, 2026-07-31). Must drive the UI, query the database, work with a knowledge base, and train Bill by managing matching/categorization rules. None of the four is currently ported (inventory: chat PARTIAL — composer plus one text turn). Plans describe it thoroughly and are the starting point. Test surface is part of the requirement, and the read/WRITE split matters: a chat that mutates matching rules can do damage.
- <!-- status: open --> **PR-10 — nothing visual reaches Vova without a consilium first** (HR-537, 2026-07-31). Binding on all roles: a consilium must analyze his ORIGINAL WORDS and judge the artifact consistent with them before he is shown anything. Sequence: gather -> design -> consilium -> Vova -> implement. Supersedes sending him screenshots directly. Onboarding was approved before this ruling and is not retroactively invalidated.
  Port the Gmail path, which is the proven one — `packages/integrations/src/gmail/`
  (~7,129 LOC with tests, history checkpoints, attachment materialization).
  The MS Graph/Outlook code under `packages/integrations/src/email/msgraph/`
  stays a STUB and is explicitly out of scope.
- <!-- status: open --> **PR-5 — shell first**: no implementation or landing evidence exists; chat properly connected and the agent switcher, with
  ALL shell functionality carried over before Bill work starts.
- <!-- status: open --> **PR-6 — storage layout**: no product-repo implementation or landing evidence exists; `/srv/projects/<product>/` for repos and
  `/srv/lanes/<product>/` for lane worktrees. Isolation is between PRODUCTS, not
  between repos of one product. Legacy repos (`bpa-shell`, `agent-bill`,
  `agent-mila`) are READ-ONLY archives — never pushed to, never modified.

## Open

- <!-- status: done --> **W-18 — triage verdicts are governance but are gitignored** — landed with independent ACCEPT at `48eb85c`. Found 2026-07-31
  while clearing three aged inbox warnings). `instance/decisions/triage.jsonl`
  holds the orchestrator's verdicts on inbound Human messages — "chatter" vs
  "directive" — which is decision content, yet `.gitignore` excludes it alongside
  `inbox.jsonl`. So a triage decision dies with the host, which contradicts Hard
  Floor 5 (`reproducible-from-git`) and re-opens every aged row on a rebuild.
  The ignore has a REAL rationale, stated in that `.gitignore`: the jsonl carries
  verbatim Human messages that may contain sensitive words — so this is a genuine
  tension, not an oversight to reverse casually. Likely resolution: TRACK
  triage.jsonl but forbid verbatim message text in it (msg_id + verdict +
  category only, no quotes), leaving `inbox.jsonl` ignored as raw capture. Needs
  a lane: decide the format, enforce "no raw text" mechanically, migrate the
  existing rows. Note the state-contract already flagged this file as having a
  human writer and no tooling.

- <!-- status: open --> **W-17 — the live daemon unit lost its security hardening** (no evidence that the live daemon was safely restarted with the hardening restored; drift detection alone does not close it). Found 2026-07-31
  by diffing deployed units against their templates for the first time).
  `bootstrap/units/bpa-telegram-daemon.service.in` sets `NoNewPrivileges=true`
  and `PrivateTmp=true`; the deployed
  `/etc/systemd/system/bpa-telegram-daemon.service` has NEITHER. Evidence and the
  full drift table: `instance/as-built-units/README.md`. NOT fixed in passing —
  restoring these changes the running daemon's behaviour (`PrivateTmp` gives it a
  private `/tmp`, which can break anything sharing paths through it) and the
  daemon is the Human's only channel, so it needs a lane with a restart plan and
  an external recovery backstop. Also decide the general question this exposes:
  nothing compares deployed units against templates, so this drift was invisible
  — that check belongs in the gate or the state contract.

- <!-- status: open --> **W-08 — memory-sweep defect triage**: `631a4ce` improved the sweep/installer, but no tracked evidence proves the judgment-heavy application described by this row completed. Live sweep + triage evidence was at
  `.cache/infra-lanes/diag/ag-memory-sweep-triage.report.md`: 38 memory entries
  + 3 oversized `.mdc` rules files). APPLICATION pending — adding `home:` anchors
  / demoting rules bodies is deliberate judgment work (several entries concern
  dead bpa-master rails); to be done by the NEW orchestrator post-cutover.
  (Sweep tool landed 05689cdd; daily timer installer exists, not yet installed.)
- <!-- status: open --> **W-10 — install memory-sweep daily timer**: `631a4ce` tests the installer but contains no durable evidence that the timer was installed on the host; install on the host once W-08 triage
  is done (orchestrator/install-memory-sweep.sh).
- <!-- status: open --> **W-14 — make /status human-useful** — candidate commits exist only on unlanded lane refs; no implementation SHA is an ancestor of current `HEAD` (`instance/decisions/HR-150.md`): the
  command currently prints raw daemon JSON + `plan: n/a`; Vova gets zero value
  from it. It should answer, in a few plain lines: what is being worked on, how
  many lanes and their states, last landed thing, anything blocked. Daemon
  runtime code → coder lane; keep the honest-fields work (W-13 relabel) intact.

- <!-- status: done --> **W-16 — lane-reported test counts are not trustworthy evidence** — independent ACCEPT landed at `c42fd06`. Found
  2026-07-31, three independent occurrences in one night): `ag-status-human`
  claimed `168/168` (reviewer executed 162/6), then claimed a "genuine 179/0"
  (reviewer executed 158/0 under the mandated frozen-install command); a third
  lane's suite exit-2 turned out to be a `/tmp`-checkout artifact. Root causes
  so far identified: blind random test ports colliding with the kernel
  ephemeral range (fixed in that branch by OS-assigned ports), and
  environment-dependent discovery/invocation differences that change the file
  set actually executed. The governance defect is that a REPORTED count is
  currently accepted as evidence at all: the report contract requires a
  `verify:` command, but nothing forces the reported numbers to come from THAT
  command in a reproducible environment. Fix direction (own lane): make the
  completion-guard/verify path the only source of a claimed count — e.g. the
  gate re-runs `verify:` and compares, or the lane must paste the mandated
  command's own output — so "N pass / 0 fail" cannot be a sentence someone
  typed. Same false-green class as the reap `status=pass` and the CI
  green-on-SKIP holes closed earlier tonight.

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

- <!-- status: done --> **ML-1 — terminal failure-alert bridge** — implementation and independent ACCEPT landed at `2c6e3f7`; live classified 8 failure classes off
  `tmux pipe-pane` (usage limit, 429/overload, auth, stalled, failed, exited,
  network, fatal); ours has 3 regexes, all context-limit. We are blind to quota
  exhaustion and provider overload — they read as a generic stall. *lane*
- <!-- status: open --> **ML-2 — autonomy keep-alive layer**: `e4eb246` landed the reviewed 15-minute/exit-nudge slice, but hourly `/compact`, maintenance audit, and per-message reply chase remain explicitly unimplemented. Four live paths pushed the orchestrator
  (hourly `/compact`, 15-min fleet ping, maintenance audit, per-message reply
  chase). All gone; every `tmuxPasteText`/`tmuxSend` call site here is
  operator-initiated. The direction inverted — live pushed the orchestrator, ours
  pushes the Human. This lane restores the 15-minute fleet ping plus a lane-exit
  event nudge with acknowledged retry. Still open: hourly `/compact`, maintenance
  audit, and per-message reply chase. Contradicts `autonomy-and-capacity`. *lane*
- <!-- status: done --> **ML-3 — heartbeat multi-signal liveness** — watchdog restoration landed at `0cc5215`; one ongoing writer (turn end), and
  stale heartbeat → kill with no alive-check, so a long Codex turn is killed
  mid-work. IN FLIGHT: `ag-watchdog-restores`.
- <!-- status: done --> **ML-4 — `/health` `connected` is fail-open** — implementation and independent ACCEPT landed at `fd8ac29`; live computed
  `transportConnected && alive`; ours reports `activeServer !== null`, so it reads
  connected with a dead socket. *trivial*
- <!-- status: done --> **ML-5 — preflight auth depth** — expanded fail-closed preflight landed at `0cc5215`; live banned 9 env vars incl.
  `CLAUDE_CODE_USE_BEDROCK`/`USE_VERTEX`/`GEMINI_API_KEY` and grepped
  `~/.codex/auth.json` for an embedded key; ours checks 3. A metered-billing leak
  through the Human's "subscriptions only" rule. IN FLIGHT: `ag-watchdog-restores`.
- <!-- status: open --> **ML-6 — vendor quota display**: candidate commits and reports exist only on unlanded lane refs; no implementation SHA is an ancestor of current `HEAD`. Codex 5h/7d, Claude weekly/credits, and the
  "session expired — re-login" warning. Local `.jsonl` parsing, no browser. *lane*
- <!-- status: open --> **ML-7 — alarm audience routing**: no matching implementation, test, review, or landing evidence was found; live split `internal` (orchestrator TUI) from
  `human` (Telegram) via an `x-bpa-alarm-audience` header; ours is single-audience,
  so all fleet telemetry pings the Human's phone. *lane*
- <!-- status: open --> **ML-8 — per-message unanswered ledger**: candidate implementation `c56435d` is not an ancestor of current `HEAD`, so it is not landed evidence; live tracked every inbound per chat and
  nudged the orchestrator at 60s/90s before escalating. Ours keeps
  `most-recent-inbound-wins`, so a burst of 5 messages collapses to 1. *project*
- <!-- status: done --> **ML-9 — `MISSION:` text parsing** — implementation and regression locks landed at `89fe5f9`; live parsed `MISSION: <text> | ttl=…` and
  `MISSION DONE/CLEAR` pre-dispatch. `grep parseHumanMissionCommand` → 0 hits
  here. Related dead seam: we still write `mission-inbox.log` and nothing reads
  it. *lane*
- <!-- status: done --> **ML-10 — delivery fallback + detach detection** — implementation and independent ACCEPT landed at `741e626`; `/reply`, `/ack`,
  `/mcp/rebind`, `/sendDocument`, `/sendPhoto` and `isMcpChannelDetached` all
  absent, so a dropped MCP channel has no alarm and no fallback. *lane*
- <!-- status: done --> **ML-11 — bidirectional history logging** — bounded redacted logging landed at `31a64ca` and retention correction at `081bff4`; the prior state had no outbound record, so
  post-incident forensics is impossible. *lane*
- <!-- status: done --> **ML-12 — watchdog escalation ladder** — implementation and regression locks landed at `3854864`; it had collapsed to a flat hourly repeat and lost
  stall-tick ladder, multi-signal progress signature, 6 alert classes with
  signature-keyed suppression, and `HAS_TASK` passivity. *lane*
- <!-- status: done --> **ML-13 — docker disk remediation** — bounded remediation and tests landed at `0cc5215`; ours previously detected and alerted only while live pruned
  at ≥80% and escalated at ≥88%, written after a real ENOSPC outage.
  IN FLIGHT: `ag-watchdog-restores`.
- <!-- status: done --> **ML-14 — restart context re-analysis** — bounded newest-wins reconciliation landed at `4fd8a61`; last ~12h of chat is injected on restart
  with newest-wins reconciliation; a restarted orchestrator now resumes stale
  intent. *lane*
- <!-- status: open --> **ML-15 — fleet/manager/lane visibility in `/status`**: candidate commits and terminal evidence exist only on unlanded lane refs; no implementation SHA is an ancestor of current `HEAD`. Manager tier, per-lane
  provider/model/branch/age, capacity gauge, spawn-failure signals. *project*
- <!-- status: open --> **ML-16 — small user-visible losses**: candidate commits exist only on unlanded lane refs; no implementation SHA is an ancestor of current `HEAD`. Required restorations: `модель` bare-word alias; `/model`
  applying to the RUNNING session via `tmuxSend` (ours pins for next launch only);
  `/start_claude <plan>` argument; Codex updater-prompt skip; `Notification` hook
  → loud ping. *trivial each*

- <!-- status: open --> **ML-GOV — no capability may leave the tree unrecorded**: no enforceable gate implementation, test, review, or landing evidence was found; none of ML-1..16 was
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
- <!-- status: open --> **NI-1 — team personas**: phase-1 implementation landed, but the row explicitly requires three-way finalization and the adaptive/RFC scope remains unresolved, so the row is not closed; give "characters"/personas to the whole 10-agent
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
- <!-- status: done --> **NI-2 — Google Drive debug access**: CLOSED 2026-07-31 by the operator, who stated the connection is already made: «Google Drive для дебагу - ьак ми вже все підключили, це ти якісь старі повідомлення витягнув». The row had been carried as blocked-on-him on the basis of a stale message; that was an orchestrator error, not an outstanding operator action.
- <!-- status: open --> **NI-3 — local Whisper voice transcription — ORCHESTRATOR CONSUMER DONE
  2026-07-31; product consumer still open.** Live-proven on Vova's real voice
  (uk verbatim, incl. technical vocabulary: бранчі/рефактор/мерж/пул/пуш/рісет).
  Engine suite green on this box: `bun test daemon/transcribe.test.ts` = 8 pass /
  0 fail with all three REAL-engine tests executed (English `.oga` opus — the
  Telegram wire format, Ukrainian → Cyrillic, and garbage audio failing closed
  with the ffmpeg reason rather than inventing a transcript). Source provenance
  closed the same day: the box's binary predated the pinning fix and carried the
  tag-only marker `v1.9.1`, so it was never verified against the pinned commit —
  re-ran `tools/whisper/install.sh`, marker is now
  `v1.9.1@f049fff95a089aa9969deb009cdd4892b3e74916` and the re-pinned binary
  reproduces a byte-identical transcript on the same audio. RAM measurement and
  the PRODUCT-side consumer (voice button in the framework) remain open.
  Original row: local Whisper (STT only) on this
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

- <!-- status: blocked --> **P-01 — VM migration to the 64 GB machine** (`instance/migration-day.md`)
  — parked by HR-11570 («Поки роби лише 1») until Vova's go.
- <!-- status: blocked --> **P-02 — stack Phase-0 spike with go/no-go numbers**
  (`migration-prep/STACK_CONSILIUM_FINAL.md`) — parked by HR-11570.
- <!-- status: blocked --> **P-03 — daemon cutover to this repo's daemon/** (flips
  `capture.mode: manual → daemon` in `instance/params.yaml`; inbox ledger
  check then fail-closes) — needs the migration/cutover moment.

- <!-- status: blocked --> **W-19 — rotate every credential transported through Telegram** (requires the Human's external provider-console rotation; candidate runbook commit `9d4f129` is not an ancestor of current `HEAD` and is not completion evidence). Opened
- <!-- status: open --> **W-20 — lane merge conflicts are wasting a third of fleet output** (found 2026-08-01). Lanes are dispatched in waves from one base and several touch the same paths, so later merges conflict and the work is redone from scratch. Observed cost in a single cycle: 4 of 8 completed lanes conflicted (entries, counterparties, period-close, settings), each a full re-run. Rule 8 already says coder lanes touch only ASSIGNED paths; dispatch does not enforce it. Two candidate fixes: declare and check disjoint path ownership at dispatch, and land each lane as it finishes instead of batching so bases stay fresh. Not a correctness defect — a throughput one, which matters because the operator bought hardware specifically for parallelism.
  2026-07-31). During the live integration setup the operator sent, over
  Telegram: the QuickBooks client id + secret, the Google OAuth client secret,
  and two GCP service-account JSON keys. Each was moved to a mode-0600 file
  outside the repo, and each was purged from the four places the daemon mirrors
  inbound messages (`instance/decisions/inbox.jsonl`, the daemon mission log,
  Claude history, the session transcript) with a whole-box sweep confirming
  containment. None reached git.
  BUT a Telegram-transported secret must be treated as EXPOSED regardless: it
  existed in Telegram's infrastructure and may survive "delete for everyone".
  Action: rotate all of them in the Google and Intuit consoles once the
  integrations are proven working, then replace the local files. One click each.
  Also worth deciding: a non-Telegram path for future secrets (the operator
  pastes into a file over SSH, or a one-time secret link), so this row does not
  recur every time a provider is added.
