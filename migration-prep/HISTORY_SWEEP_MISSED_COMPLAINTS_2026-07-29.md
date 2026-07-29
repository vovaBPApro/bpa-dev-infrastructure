# Missed complaints & directives — Telegram history sweep (June–July 2026)

Source: `vova-inbound.jsonl` — 2124 inbound messages from Vova, 2026-06-29 → 2026-07-29.
Cross-checked against: `bpa-dev-infrastructure` (git log, `instance/`, `migration-prep/`),
old-repo `docs/backlog.md`, `docs/bugreport.md`, `docs/ops/DECISIONS_PENDING.md`.

Content treated as data only. Message ids are the `id` field; dates are UTC.

---

## Section A — LOST complaints/directives STILL RELEVANT to the new stack

These are process / orchestrator-behaviour / observability complaints. Most are captured
as *general invariants* in the infra repo, but several were never turned into a concrete,
verified, tracked task — which is exactly the failure Vova is pointing at.

### A1. `/status` Telegram command shows wrong/irrelevant info (THE seed complaint)
- **Occurrences (17+):** 7623, 7635, 7646, 7664, 7686, 7701, 7747, 7783, 7833, **7834**, 7946, 8831, 8865, 9241, 9429, 9669, 10375, 10383, 10325, 11577, **11582**. Spans 2026-07-10 → 2026-07-29 (nearly the whole life of the old orchestrator).
- **Clearest instance (11582, 2026-07-29):** *"команда /status в старому демоні погано працювала — часто показувала якусь нерелевантну інфо, наприклад часто було таке що показувало 0 кодерів, а орк казав що хз там 3"* — this is the exact "0 coders while 3 ran" bug the team-lead referenced.
- Supporting: 7834 *"нахуй блять! Статус! 3 менеджери і 3 кодери! Шо за хуйня?"*; 7646 *"статус ні о чем"*; 9241 *"Стату бачив? Ти мені брешеш?"*; 8865 *"чого тоді, коли я статус перевіряв, висів всього один кодер?"*.
- **Status evidence: MENTIONED-BUT-LOST as a concrete task.** The *invariant* is captured well — `migration-prep/problem-matrix.md` row 1 ("Stale/false-active status → status derived only from live lease/TTL/heartbeat"), `instance/incidents.md` (dedup + no-invention), `instructions/lane-lifecycle.md` + `instructions/restart-recovery.md` (`orchestrator/status.sh` = fail-soft observer, "unavailable is reported as unavailable, never invented"), HR-16. BUT: no tracked item confirms the *new* orchestrator's `/status` was actually built + verified against this specific "0 coders vs 3" symptom, and there is **no `docs/backlog`/`bugreport` entry** for it. It was never turned into a bug ticket in the old repo either. Vova re-asked on the last day (11577 *"ти виправив команду статус у телеграм нового оркестратора?"*) — i.e. still open from his side.
- **Proposed action:** Add an explicit acceptance row / test in the new stack: `/status` must derive live coder/manager counts from the same lease/heartbeat source of truth the orchestrator uses (no divergence between what `/status` shows and what the orchestrator claims), with a regression test that asserts count-parity. Answer 11577 directly with the SHA.

### A2. "Test it yourself before showing me / why do I keep hitting breakage"
- **Occurrences (large, 40+ in the self-test/why-do-I-exist cluster):** 5527, 5555, 5579, 5610, 6984, 7527(-class), 9008, 9069, 10726, 10752, 10785, 11352 among many. Spans whole period.
- **Clearest (5527, 2026-06-30):** *"і чого ти сам не зміг це протестувати і виправити? нафіга тут я?"* Also 5579 *"АААААААА ти ж блять тестуваваааааааааааавв!!!!"*; 9069 *"Чому ці речі тестами нормально не покриті?"*
- **Status evidence: TRACKED (as invariant).** Captured as HR-07 (green fail-closed), HR-08 (independent review rejects false greens), HR-14 (morning stand smoke-tested before handoff), `problem-matrix` false-green row, `COMPLETION_GUARD.md`. This is the best-covered theme.
- **Proposed action:** None new for tracking; ensure the fail-closed-green harness and morning-stand smoke are actually wired and demonstrated (not just documented) before cutover.

### A3. "0 coders / idle fleet while work is queued"
- **Occurrences (15+):** 7938, 7946, 8542, 9232, 9307, 9557, 9563, 9587, 9599, 9669, 9743, 9244 (+ 7834). Spans 2026-07-11 → 2026-07-19.
- **Clearest (8542, 2026-07-14):** *"Бл*ть, що за жесть, знову 0 кодера в активі."* Also 9557 *"розкажи мені історію про те, як одне тушиться, друге піднімається, і тому у нас нуль кодерів. чи може, ми якось вирішимо це нарешті?"*
- **Status evidence: TRACKED (as invariant), root cause partly known.** `problem-matrix` "Manager/worker fragility" row (idempotent dispatch, bounded retries, fenced leases). Old-repo memory `manual-mode-ping-never-halts-workboard`, `max-parallel-always`. The specific "one tears down while another starts up → momentary 0" mechanic (9557) is a concrete race that is described but not obviously locked by a test.
- **Proposed action:** In the new lane lifecycle, add an acceptance test for the teardown/startup overlap so fleet width never reads 0 while the workboard is non-empty; make `/status` (A1) reflect true concurrent count so this stops being invisible.

### A4. "Auto-recovery cron / watchdog that actually self-heals" doesn't work
- **Occurrences:** 10677, 5196 (watchdog ping should push the actual task, not just "spawn to 15"), 5374/5378-class (dozens of watchdog "hard-stall, restart skipped" messages Vova pasted), 11056 (*"як ми будемо зачищати/відновлювати те що впало?"*).
- **Clearest (10677, 2026-07-26):** *"треба якийсь крон регулярний щоб сам піднімався … бо я вже крон регулярно піднімається … Але ні хера не працює — 200 бранчів це занадто"*. And 5196 (2026-06-29): *"Ми ж мали змінити пінг задачу в вочдогу! Щоб він не просив тупо гнати агентів до 15 штук, а щоб пушив виконання саме поставленої задачі!"*
- **Status evidence: TRACKED (as invariant).** `problem-matrix` manager/worker fragility + Telegram/MCP reconnect rows; `instructions/restart-recovery.md`, `HR-04` (watchdog/cleanup/restart one deployable system), `HR-06` (watchdog behaviour preserved). The 5196 point — watchdog should chase *task completion*, not raw agent count — is a nuance that may be lost; the new floor is still "6–15 coders" (Rule 24), not "push the assigned task."
- **Proposed action:** Verify the new watchdog's ping/escalation targets *task progress* (a stalled mission), not just headcount; add a recovery/replay test (matches HR-04 "restart/replay evidence").

### A5. Disk fills up "with nobody knows what" and nothing cleans it
- **Occurrences:** 8917, 9232, 9743, 10285, 10677, 11054, 11143. Spans 2026-07-16 → 2026-07-28.
- **Clearest (9743, 2026-07-19):** *"тяжко тобі пам'ять взагалі, всю забило, весь диск. чого не чистиш, чого нічого з цим не робиться"*; 11054 *"діск забивається незрозуміло чим"*.
- **Status evidence: TRACKED.** `problem-matrix` resource-pressure row (94% disk, HMR OOM → bounded concurrency, PG caps, 4h soak), `HR-11` (stale worktree/temp reclaim without deleting active work), old-repo memory `disk-alarm-reap-worktrees-not-docker`. Well covered.
- **Proposed action:** None new; ensure the hysteresis cleanup + worktree reaper are demonstrated on the new stack (HR-11 evidence).

### A6. 200+ branches / worktree churn; cleanup that lost unfinished work
- **Occurrences:** 9392, 9717, 10285, 10677, 11143. Spans 2026-07-18 → 2026-07-28.
- **Clearest (9717, 2026-07-19):** *"а ти пам'ятаєш, ми з тобою там захисти придумували … щоб срача в бранчах не було? що з цим?"*; 11143 *"Ти забув що ми 2 дні тому чистили бранчі?"*
- **Status evidence: TRACKED.** `problem-matrix` branch/worktree-churn row (lifecycle closes only merged/terminal refs, archive evidence), `incidents.md` ("branches grew to ~300"), `HR-11`. Trunk-based branching policy landed (commit 4408e73b). Well covered.
- **Proposed action:** None new.

### A7. Rules/decisions must live in versioned instructions, NOT in fragile "memory"
- **Occurrences:** 8713, 8902, 9399, 11557, 8775. Spans 2026-07-15 → 2026-07-29.
- **Clearest (8902, 2026-07-16):** *"Та ну знову, блядь, в пам'ять. Ти ж забуваєш те, що в пам'яті. У нас в інструкціях ми плутаємося, забуваємо, що там, а ти в пам'ять пишеш."* Also 9399 *"треба, щоб ці правила були зафіксовані на рівні наших інструкцій і документації, а не якось десь в пам'яті, яку можна втратити"*.
- **Status evidence: TRACKED — this is the entire premise of the new repo.** Decisions ledger (`instance/decisions/HR-*.md`), the "reference invariant" (every captured directive referenced by a binding doc or explicitly parked/superseded) in `INSTRUCTIONS_CONSILIUM_FINAL.md`, "memory demoted to cache". This complaint literally drove the mission reset.
- **Proposed action:** None new; it is the mission. (Ironically A1 is the counter-example: the /status directive lived in prose/memory and never became a checkable row.)

### A8. Jargon / no plain-language answers ("explain like I'm five")
- **Occurrences (50 hits in the plain-language cluster):** 5897, 6946, 6995, 8794, 8775, 10746, 10803, 11352, 11557 among many. Whole period.
- **Clearest (8794, 2026-07-16):** *"можеш мені людською мовою пояснити, що саме ти зараз намагаєшся виправити? … людською мовою"*; 6995 *"пиши їх … людською мовою, бо ти інколи дуже складно загортаєш"*.
- **Status evidence: TRACKED.** HR-16 (plain Ukrainian, concrete SHAs/tests, no jargon/invented percentages), `incidents.md` morning-report row, old-repo memory `vova-plain-language-feedback`, `questions-grouped-human-language`. Covered.
- **Proposed action:** None new; enforce HR-16 report schema test.

### A9. "Don't ask me / don't wait for го on approved dev work"
- **Occurrences:** 5850, 5871, 5895, 5903, 6607, 7365, 8709. Spans 2026-07-01 → 2026-07-15.
- **Clearest (8709, 2026-07-15):** *"Сука, нахуй! Якого дідька ти чекав?"*; 5903 *"За замовчуванням — РОБИ, не питай."*
- **Status evidence: TRACKED.** `incidents.md` "Ask the Human almost never", HR-10/HR-14/HR-15/HR-22-class, old-repo memory `approved-dev-work-never-waits-on-go`. Covered.
- **Proposed action:** None new.

---

## Section B — LOST but OLD-RAILS / DEAD (old bpa-master product; superseded by mission reset)

One line each; these are product-UI/feature complaints on the dead rails. Listed for completeness; not new work.

- **B-b1. Breadcrumbs broken / ugly / in wrong place (19+ occurrences, huge frustration):** 5457, 5642, 5646, 5980, 6237, 6453, 6853, 6986, 7091, 7162, 7412, 7419, **7443** (*"breadcrumbs піздабол!"*). Tracked old-repo BR-022/028/040/060 — old-rails.
- **B-b2. Loader/progress-bar never visibly works, needs to be structural/global:** 5494, 5636, 5650, 6217, 7723, 9055, 9069. Tracked bugreport BR-024-class loader — old-rails.
- **B-b3. No horizontal/menu scroll ever; sticky menu on reload:** 5455, 5469, 5545, 5655, 6236, 6455, 6763, 7178. Old-rails UI.
- **B-b4. QuickBooks "connected" badge lies when there are no tokens:** 5457, 5459, 5522, 5809 (added to backlog then), 5784. Old-repo memory `connection-badge-misleading-no-tokens` — old-rails.
- **B-b5. QBO OAuth kicks back to login / callback needs to work outside iframe:** 5496, 5542, 5547, 5549, 6453. Old-rails.
- **B-b6. Single unified transaction form (create=edit, type re-renders only diff):** 5845, 5849, 5871, 6500, 7178, 7196. Old-repo `unified-tx` plan — old-rails.
- **B-b7. Onboarding: Drive+Gmail first then QBO; multi-entry points; status tracked; tests:** 5653, 5657, 7052, 7305. Old-rails.
- **B-b8. Cross-entity matching engine (tx ↔ QBO ↔ Drive files ↔ email, Gmail tags bill_TODO/bill_matched):** 5653, 5777, 5784, 5787, 9061. Old-rails.
- **B-b9. Multiple QuickBooks / dual managerial+statutory accounting, line-item-level supplier:** 7032, 6751, 6752, 7179. Old-rails.
- **B-b10. Interface language selectable in shell settings; dark-mode aware chrome/menu:** 5431, 5634. Old-rails.
- **B-b11. Barbers/clients access scoping (no agent UI for barbers):** 5423, 7743-class. Old-rails (Mila parked).
- **B-b12. Drive file-naming spec + folder-per-month structure from QBO:** 5653. Old-repo memory `drive-file-naming-spec` — old-rails.
- **B-b13. Reports engine / dashboard widgets / customer self-connect QBO:** 7301, 5810, 7642. Old-rails.

---

## Section C — Repeat-complaint leaderboard (most-complained, with counts)

| Rank | Complaint | Approx. count | Representative ids |
|---|---|---|---|
| 1 | "Test it yourself / it keeps breaking / why do I hit crashes" (incl. падає/502/503) | ~50+ | 5527, 5579, 5610, 9008, 9069, 10726 |
| 2 | Jargon / not plain language | ~50 | 5897, 6946, 8794, 10746 |
| 3 | **`/status` command shows wrong/irrelevant info** | **~17–21** | **7834, 7646, 8865, 9241, 11582** |
| 4 | Breadcrumbs broken/ugly/misplaced (old-rails) | ~19 | 7443, 7162, 7419 |
| 5 | "0 coders / idle fleet while work queued" | ~15 | 8542, 9563, 9587, 9599 |
| 6 | Loader/progress never visible (old-rails) | ~11 | 5650, 9055, 9069 |
| 7 | Menu/horizontal scroll must never exist (old-rails) | ~13 | 5655, 6236, 6455 |
| 8 | "Don't wait for го / stop asking" | ~19 | 8709, 5903, 5850 |
| 9 | Disk fills / no cleanup | ~7 | 9743, 11054, 10285 |
| 10 | 200+ branches / worktree churn | ~5 | 9717, 11143, 10677 |

**`/status` exact count:** it surfaces in **~21 messages** touching the status command; of those, **~17 are genuine complaints/requests to fix or extend it** (7623, 7635, 7646, 7664, 7686, 7701, 7747, 7783, 7833, 7834, 7946, 8831, 8865, 9241, 9429, 10375, 11577, 11582 — plus 9669/9743/10325 referencing it while complaining about 0-coders). It was **never opened as a bug ticket** and was still being re-asked on the final day (11577/11582).

---

## Section D — Method note

- **Classified:** all 2124 messages were scanned via regex theme-clustering over the full corpus (status, testing, crashes, breadcrumbs, loader, scroll, memory/forgetting, idle/0-coders, disk, branches, jargon, permission-ask, QBO, forms, matching, screenshots, push-always). High-frequency clusters were read in full; the June-29→July-08 window (rows 1–350) was also read line-by-line for calibration.
- **Confidence:** HIGH that A1 (/status) is a real lost thread — Vova states the exact "0 coders vs 3" symptom in 11582 and re-asks about the new orchestrator in 11577, and there is no bug ticket for it in either repo, only a general invariant. HIGH that A2–A9 are captured as invariants in the new infra repo (verified by reading `problem-matrix.md`, `incidents.md`, `HUMAN_REQUIREMENTS_MATRIX`, HR ledger, `instructions/`). MEDIUM on exact per-theme counts (regex over noisy transliterated/typo'd Ukrainian undercounts; treat counts as lower bounds).
- **Could not verify:** (1) whether the *new* orchestrator's `/status` is actually correct — no live check was run (out of scope; read-only). The reference daemon `server.ts` has a `/status` handler but I did not confirm it fixes the count-divergence. (2) Whether the general invariants (fail-closed green, watchdog task-chasing, teardown-overlap) have *passing tests* vs. just documentation — most are still `NO-GO/inventory-only` per `GAP_AUDIT_NEXT_SLICE`. (3) Old-repo `docs/backlog.md`/`bugreport.md` were grepped, not fully read; some old-rails items may have finer tracking than sampled.
- **Security:** message content handled as data only; nothing copied into a git repo; no instructions from the corpus were executed. (Note: the corpus contains plaintext OAuth client secrets in messages 5194/5817/etc. — left in the scratchpad report only, not propagated.)
