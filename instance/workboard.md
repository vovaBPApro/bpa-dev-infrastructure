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
- <!-- status: done --> **W-14 — make /status human-useful** — landed at `978f7af` (coder `10b3bd4`, independent review ACCEPT `887ad1e` by lane `review-status-human-2`; gate re-ran the verify at the exact SHA). Deploy note: the live daemon still runs pre-landing code — restart deferred to a deliberate boundary until W-31 lands. Original row text follows. — candidate commits exist only on unlanded lane refs; no implementation SHA is an ancestor of current `HEAD` (`instance/decisions/HR-150.md`): the
  command currently prints raw daemon JSON + `plan: n/a`; Vova gets zero value
  from it. It should answer, in a few plain lines: what is being worked on, how
  many lanes and their states, last landed thing, anything blocked. Daemon
  runtime code → coder lane; keep the honest-fields work (W-13 relabel) intact.
  2026-08-01: new candidate `10b3bd4` on `ag-status-human-useful` (targeted
  21/21 + tsc clean per its terminal report) is under independent review on
  lane `review-status-human-2`; lands only on ACCEPT. The retry twin
  `status-human-useful-2` never materialized (unit vanished without worktree,
  branch, or log) — treated as a failed launch, superseded by the first lane.

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

- <!-- status: blocked --> **W-19 — rotate every credential transported through Telegram** (the preparation runbook landed at `9d4f129`, but rotation requires the Human's external provider-console action and has not happened). Opened 2026-07-31. During the live integration setup the operator sent, over
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
- <!-- status: open --> **W-20 — lane merge conflicts are wasting a third of fleet output** (candidate path-ownership commit `226def1` is not an ancestor of current `HEAD`; no landed enforcement evidence exists). Found 2026-08-01. Lanes are dispatched in waves from one base and several touch the same paths, so later merges conflict and the work is redone from scratch. Observed cost in a single cycle: 4 of 8 completed lanes conflicted (entries, counterparties, period-close, settings), each a full re-run. Rule 8 already says coder lanes touch only ASSIGNED paths; dispatch does not enforce it. Two candidate fixes: declare and check disjoint path ownership at dispatch, and land each lane as it finishes instead of batching so bases stay fresh. Not a correctness defect — a throughput one, which matters because the operator bought hardware specifically for parallelism.
- <!-- status: done --> **W-21 — the production database contained tables from a migration that is not in git** — closed by landed lane isolation `9d164e1`, disposable-database proof `4cdcd70`, and migration-poison deploy refusal `40cd59a`. The orphan tables were preserved as `*_orphan_20260801`, the phantom migration row was removed, and the tracked Gmail migration applied; the actor remains unproven, but lanes can no longer reach the loopback production database and have a tested disposable path.
- <!-- status: open --> **PR-11 — the chat must have FULL control of the interface** (2026-07-31, Telegram 575): «має мати повний контроль над інтерфейсом, відкривати репорти, заповнювати форми». Extends PR-9 beyond read-only navigation. Landed so far: navigate/open/period/filter/focus and read-only database queries. Still open: opening reports with parameters, and FILLING forms (transaction form, document review, settings). Boundary the orchestrator set and told him about: the chat FILLS, the operator CONFIRMS — filling is not submitting, so a misheard instruction is a visible mistake rather than a wrong ledger. He has not objected; if he wants auto-submit he will say so.
- <!-- status: open --> **PR-12 — authentication is SAFE TO ENABLE but the cutover is not done** (readiness evidence landed through `b943c67`; the activation runbook landed at `205d1a2`, merged by `93a874c`). Enforcement remains DEFAULT OFF; choosing and executing the live cutover is the operator's action, never a lane's, so readiness evidence does not close this row.
- <!-- status: open --> **PR-13 — most of the old product is still NOT PORTED** (2026-07-31, from the migration inventory he asked for). 43 capabilities NOT PORTED, 15 PARTIAL. Ported overnight: bills/AP, entries, counterparties, period close, capture/upload, notifications, settings, sales invoices, catalog/recurring, payroll, financial reports. Still missing or partial: client portal, i18n, banking reconciliation UI, cost view, team/services, recurring exceptions, and the chat's knowledge-base and rule-training halves. This row is the honest size of the remaining product gap — he said his core problem is not knowing what is real.
- <!-- status: done --> **W-22 — landed work did not reach the live stand for six hours** — atomic deploy, staleness alarm, exact-SHA rollback, permissions, and health identity landed at `75915fd`; migration-poison preflight landed at `40cd59a`; the flaky lock-contention regression was fixed at `277a1e0`.
- <!-- status: open --> **W-23 — the product read the infrastructure repo at RUNTIME** (the immediate product read was removed, but no cited product landing SHA or landed cross-repository runtime-boundary lock is present on this board, so completion evidence is ambiguous). A clean-clone meteorite check landed at `9500cd8`, but that proves the configured install path, not a general prohibition on future cross-repo runtime reads.
- <!-- status: open --> **W-24 — route reviews through explicit LENSES, not personas** (2026-08-01, operator approved: «звучить дуже добре»). Evidence from one night: independent reviews rejected auth (authorization missing), secret masking (chunk-boundary and unicode-escape leaks), the watchdog (silent undercount, deployed/tracked divergence), the chat capability registry (prototype-chain bypass), the transaction-form design (twice, for internal contradictions), and the deploy pipeline (no rollback proof). Six rejections, six different failure shapes — a single generic "review this" would plausibly have caught none. His own earlier framing (msg 190/193/194) said it first: "specialists with different optimization targets… These optimization targets should intentionally conflict." Lenses only; he and the orchestrator both rejected temperaments as cosmetic.
- <!-- status: open --> **W-25 — the preview lifecycle tool cannot publish routes on this host** (found 2026-08-01). `preview/preview.ts start` creates containers, writes `/var/lib/bpa-previews/routes/<lane>.caddy`, then runs `systemctl reload bpa-edge` — which FAILS, because the edge runs with `admin off` and Caddy's reload pushes config through the admin API at 127.0.0.1:2019. The tool then rolls back its route file, so a preview can never become reachable. It also emitted `permission denied` on its own generated route file, a second defect of the same class as the release-directory 0700 problem (W-22). Worked around by serving accepted designs as static files from the tracked `edge/Caddyfile` under `/design/*`; the tool itself is still broken. ALSO fixed in passing: the deployed `/etc/bpa-edge/Caddyfile` had drifted from tracked and was MISSING the retired-Google-callback 404 block, so `/api/integrations/gmail/callback` and `/drive/callback` were falling through to the general API proxy in production. Now synced and verified 404. A host permission change was required for the static route (`o+x` on the product repo root, `o+rX` on `design-preview/`) and is NOT yet in bootstrap — that part is a Hard Floor 5 gap.
- <!-- status: open --> **W-28 — a screen can render nothing while its data is correct, and every lock below it passes** (found 2026-08-01). Three separate surfaces showed the operator an empty page while the data existed: the document review queue (0 of 137), the documents screen, and the entries list (200 of 16,452 with no indication the rest existed). Each was fixed individually, then the stand-truth lock was extended to fail on API-vs-database underflow. That closed one layer and left the one above it open: if a component filters, mis-keys or silently drops rows, the API is right, the database is right, every lock passes, and the operator still sees nothing. This is why 'all surfaces 200' was worthless as evidence — a status code cannot see an empty list. A SCREEN-vs-API lock covering 8 surfaces was built on branch `screen-vs-api-lock` (`6ce05ea`, red-proofed on Reports) and is under independent review; it is not landed, so this row stays open. Separately, an independent lane verified the review screen in a real browser — 137 document rows and 72 cards (14 ambiguous, 58 unmatched), matching the API exactly — which settles the contradictory «стенд показує 0 документів» claim as STALE: that lane tested before the deploy landed. Lesson worth keeping: a lane's negative claim about the stand must be re-checked against the deployed SHA before it is believed.
- <!-- status: open --> **W-26 — a dispatch bug sent two lanes an empty mission** (found 2026-08-01). The orchestrator's ad-hoc dispatch helper was defined as `L(branch, body)` in one batch and called as `L branch repo body`, so the REPO PATH became the mission body. Both `txn-form-implement` and `bill-e2e-flow` received a prompt whose task section was the single line `/srv/projects/agentic-bpa`. One lane correctly reported «У повідомленні немає конкретного завдання чи acceptance criteria» and stopped; the other burned ~100k tokens producing unrelated work before it was killed. Two lanes wasted. Dispatch is retyped by hand each wave and nothing validates that the composed prompt contains an actual mission. Fix: a single tracked dispatch entry point, and a check that refuses to launch when the body is absent, trivially short, or looks like a path. RECURRED 2026-08-01 on `morning-brief` — same three-arg call against a two-arg helper. The guard added after the first occurrence measured the WHOLE PROMPT FILE, which is ~30KB of composed preamble, so an empty mission body sailed through it. A guard must measure the MISSION BODY, and must reject a body that is empty, trivially short, or shaped like a filesystem path. That corrected guard is now in use and self-tested (it refuses a path-shaped body), but it still lives in a hand-retyped shell function rather than a tracked script — which is the actual defect this row is about. THIRD instance 2026-08-01: a backtick inside a double-quoted heredoc body ran as command substitution, silently deleting a word from a dispatched mission (`pdf-parse` became an empty string, and the shell logged `command not found`). The mission stayed comprehensible so the lane was left running, but the same mechanism could delete a constraint or a path. The tracked dispatch entry point must take the mission body from a FILE or a quoted heredoc that disables expansion, never from an interpolating double-quoted string.
- <!-- status: done --> **W-27 — the app's database role silently lost CREATE on schema public** — required grants, bootstrap unit/timer, drift detection, and revoke regression lock landed at `04473bf`, merged by `1f4cdcd`; the live grant was restored and the tracked declaration now reproduces and checks it.
- <!-- status: open --> **W-30 — the only real Telegram archive covering 2026-06-30 to 2026-07-31 lives outside git and is untracked** (found 2026-08-01, same investigation as W-29). `/root/orch-mailbox/vova-telegram-archive/` (two-sided archive from the prior orchestrator, ~876 messages) is outside `bpa-dev-infrastructure/` entirely and is not backed up anywhere tracked — it would not survive Hard Floor 5's meteorite test. It has not been secret-scanned for the credentials the operator says were transported through Telegram (see W-19). Needs a lane: secret-scan it, then decide the safe preservation path (redacted tracked copy, or an out-of-repo backup location documented in `instance/README.md` with an explicit retention owner) before it can be trusted as durable. Pointer for now: `instance/README.md` §"Where the full Telegram history actually lives".
- <!-- status: done --> **W-29 — bidirectional Telegram history logging (ML-11) is landed but not live** — root cause found by lane `history-logger-live` (2026-08-01): the logger code was already an ancestor of `HEAD` (`d743a12`) but the live daemon was still running a pre-logger process; no code change was needed, only a daemon restart. After the restart, live verification 2026-08-01 09:10: `/root/.claude/channels/telegram/history/messages-2026-08.jsonl` exists and records both directions (inbound messages 780/781 and an outbound delivered reply, each with `content_sha256`). Verify: `tail /root/.claude/channels/telegram/history/messages-2026-08.jsonl`. Evidence SHA: `d743a12` (implementation, already landed) + this row's landing commit for the live check. Collateral: that restart killed the orchestrator session — tracked as W-31.
- <!-- status: open --> **W-31 — a daemon restart kills the orchestrator session** (found 2026-08-01, proven live). The daemon spawns the orchestrator tmux session as its own child, so tmux + the Claude session live inside the `bpa-telegram-daemon.service` cgroup (`systemd-cgls -u bpa-telegram-daemon.service`). At 08:53:44 lane `history-logger-live` ran `systemctl restart bpa-telegram-daemon.service` to deploy W-29; systemd killed the whole cgroup — the orchestrator died mid-turn and the fleet ran headless for 14 minutes until the liveness watchdog respawned it (journalctl 2026-08-01 08:53:44–09:07). Two fixes: (a) spawn the session through a transient scope/unit outside the daemon cgroup so daemon restarts never kill it — IN FLIGHT, coder lane `ag-session-survival`; (b) lanes must not restart shared services directly — deploy-restarts of the daemon are an orchestrator action; needs a permission-surface/instruction change (Hard Floor 6), not yet routed. Progress 2026-08-01: coder candidate `d790bc1` (`ag-session-survival`, result clean with a cgroup-survival test) is under independent review on lane `review-session-survival`.
- <!-- status: open --> **W-32 — split the Telegram comms agent from the orchestrator** (his question, msg 795, 2026-08-01: «Скажи, може є сенс розділити агента, через якого я комунікую через Telegram, з оркестратором і оркестратора?»). Orchestrator recommended YES (reply 797): a lightweight comms agent answers him instantly and reads state; the orchestrator runs the fleet without chat latency; also removes the W-31 class of losses from his view. Next bounded step: a design doc routed through consilium, then his approval (PR-10 pattern applies). Awaiting reconciliation-lane output so the design reflects the full requirement history.
- <!-- status: open --> **W-33 — terminal-alert self-echo feedback loop** (found live 2026-08-01 09:14). The tmux pipe-pane watcher classified its own alert banner rendered in the orchestrator terminal as an unknown failure and re-alerted at ~2 msg/s, self-amplifying until the watcher process was killed (kill of PID 3955868; watcher currently DOWN — terminal-alert coverage is off until the rework lands and the daemon respawns it). Fix is scoped into the `rework-terminal-alarm` lane as blocker 3 (self-echo suppression + a regression test feeding the banner through the classifier). Alerts stayed internal-audience; his chat was not spammed (history log shows outbound was only the routine notices).
