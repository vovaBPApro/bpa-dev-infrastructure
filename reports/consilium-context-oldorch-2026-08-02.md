# OLD orchestrator archive context addendum (HR-1453)

Reviewed source boundary: W-30's canonical inbound archive
`/root/orch-mailbox/vova-telegram-archive/vova-telegram-by-message-id.txt`, the
tracked old-orchestrator handoff, and plans/concepts/mission queues in
`/root/legacy-donors/bpa-master`. This is an evidence inventory, not a binding
instruction source. Quotes below preserve the Human's spelling verbatim.

## Recovery and measurement

- The canonical archive declares 876 unique message IDs from 2026-06-30 through
  2026-07-31. `iconv -f UTF-8 -t UTF-8` accepted the complete file.
- The reported Cyrillic damage was a viewer-decoding error, as W-30 already
  records. No bytes were rewritten.
- Unrecoverable spans: **0**. U+FFFD occurrences: 0; explicit hex-escape,
  `<decode...>`, `[unreadable]`, or replacement-character markers: 0.
- Therefore no archive text is `UNMEASURED` for encoding reasons. Semantic
  attribution remains bounded to the inbound Human-only projection; the
  two-sided archive was not needed to establish the rows below.

## Instructions and complaints absent from this repo's HR/W rows

The current ledger contains later analogues, but no HR/W row keyed to these old
message IDs and no row preserving these exact words.

1. **Make Telegram-history reconciliation and full live UI traversal recurring
   evidence, done by agents.** Proposed routing: L1 generic verification rule;
   product-specific defects discovered by it route to L2/L3.

   > Проскануй всі повідомлення в телеграм за останню добу. Створи список того що треба було реалізувати. Оціни що реалізовано, якість уоду та рішень. Скажи що щє не зроблено. Все зроби агентами.

   > Також підніми агента який чк слід проклацає все все все кожну сторінку та кнопку і підготує репорт що падає або не працює або не відповідає очікуваній поведінці

   Provenance: msg 5372. Msg 5378 adds that the click report is processed in
   parallel and that work gets a fuller plan and at least one Codex review.

2. **The fleet/status contract is hierarchical and externally measurable.**
   Proposed routing: split the generic hierarchy, fleet maintenance, status
   truth, and server-capacity measurements into L1; concrete provider/host
   values into `instance/params.yaml`. This predates and materially corroborates
   W-46, but the verbatim complaint itself is absent.

   > що за лажа? в нас має бути тмукс сессія це ти - фейбл підключений сюди до телеграма. В тебе в подчінєніі до 3х агентів оркестраторів/менеджерів піднімаєш і оркеструєш, а вони вже піднімають і оркеструють др 3х агентів кожен переважно на кодексі і вони вже роблять роботу! Ти що забув архітектуру? і чого її не видно в команді статус і не видно що зара- робиться, скільки агентві активно та яке на вантаження на хецнер

   Provenance: msg 7747. Repeated failures are evidenced by msgs 7783, 7946,
   9669, and 11582; msg 7686 explicitly asks `/status` to show RAM, CPU, disk,
   and `/tmp`. This is a regression family, not five independent preferences.

3. **End-user role isolation is absolute at the product surface.** Proposed
   routing: L2 family authorization contract, then L3 enforcement/tests per
   agent application.

   > барбери не мають доступа до інтерфейса агента! Вони мають доступ тільки до своєї апки, клієнти тільки до своїх сторінок, і все!

   Provenance: msg 5423. The current infrastructure review policy classifies
   authorization as Tier A, but it does not carry this product requirement.

4. **Connector settings must expose useful real state, not duplicated links.**
   Proposed routing: L2 design/integration contract with L3 connector fields.

   > тут обидві кнопки ведуть на ту саму сторінку. я гадаю бідбш юзер френдлті буде зробити однакову кнопку для кожного підключенгого ресурса типу Manage і там вже сторінкка налаштувань всяких. Також прям тут варто показати реальний статус - підключено чи ні. Для квікбукса показати назву компаніі підключеної

   Provenance: msg 5644; the same message specifies a Google Drive folder link.

5. **Agent-created entities require visible provenance, review/approval, learned
   rules, confidence, and measurable automation impact.** Proposed routing: L2
   agent-framework/product contract, with Bill-specific presentation in L3.
   Msg 7358 is long and already preserved in the donor concept; its concise
   controlling fragment is:

   > Нехай створює все, чого не вистачає. Тільки створює тут у себе. Показує там в рів'ю.

   Source donor: `docs/concepts/CONCEPT_agent_autonomy_review_and_provenance_INTAKE.md`.

## OLD plans worth carrying to v3/product

These are source candidates, not automatic implementation approvals.

- `docs/plans/PLAN_b115_prompt_injection_hardening.md` and
  `docs/plans/PLAN_b115_addendum_pretx_hook.md`: untrusted document/email intake
  and action preflight; carry the threat model and executable boundaries.
- `docs/plans/PLAN_b245_financial_document_relevance.md`: relevance gate before
  Bill entity creation; aligns with the old complaint about irrelevant Gmail
  material and the product's review queue.
- `docs/plans/PLAN_gmail_s2_history_scan.md`: historical Gmail ingestion and
  evidence; reconcile with current connector/import work rather than re-dispatch.
- `docs/plans/DESIGN_onboarding_first_run.md`: the first-value onboarding flow;
  reconcile with connector initialization and approval/provenance UX.
- `docs/plans/PLAN_chat_upload_master_surface_prefill_contract.md`: explicitly
  PARTIAL; the flagship chat-upload-to-real-Bill-prefill boundary remained open.
- `docs/concepts/CONCEPT_agent_autonomy_review_and_provenance_INTAKE.md`: direct
  verbatim-backed donor for agent-created entities, review, rules, confidence,
  and visible automation provenance.
- `docs/concepts/CONCEPT_managerial_vat_settings_INTAKE.md` and
  `docs/concepts/CONCEPT_qbo_managerial_locations_classes_sync_INTAKE.md`:
  unresolved accounting semantics that belong in product planning.
- `docs/concepts/CONCEPT_chat_driven_minimal_dashboard.md`: master chat as the
  primary surface and a deliberately minimal dashboard; carry as a product
  direction to reconcile, not as settled implementation detail.
- `docs/concepts/CONCEPT_orchestration_fleet_architecture.md`,
  `docs/plans/PLAN_master_orchestrator_coordination.md`,
  `docs/plans/PLAN_master_coordination_impl.md`, and
  `docs/ops/staging-runs/MISSION_QUEUE_2026-07-13-night.md`: infrastructure donor
  set for queue ownership, three-level topology, status, and unfinished cutover.
  The implementation plan says shard 3 remained Human-gated.

## Decisions superseded or narrowed here

- **Fixed provider topology (Claude thin → Codex managers → Codex workers):**
  narrowed by `instance/params.yaml` and `instructions/vendor-routing.md`;
  provider health/quota are routing signals, while role/persona diversity now
  outranks vendor diversity (`review-policy`, HR-212). The hierarchy remains;
  provider identity is instance policy, not generic architecture.
- **“Review less, test more”:** superseded for Tier-A surfaces by the current
  `review-policy` and `verification-and-locks`: infrastructure/evidence-gate
  changes require independent review plus highest available executable evidence.
- **Old host as GitHub bridge and old orchestrator as operational backstop:**
  superseded as an acceptable durable design by `reproducible-from-git` and the
  meteorite test. Host-only mailbox/keys/services cannot be the control plane's
  reconstructible source of truth; W-30 itself remains open for off-host archive
  retention.
- **All pre-production agent data is disposable:** narrowed by current durable
  mission/evidence/restart rules. Product test data may be disposable, but
  mission state, review evidence, instruction provenance, and recovery state
  cannot be silently discarded.
- **Per-task “review once by Codex”:** superseded by risk routing. Tier A needs
  independent role/persona consilium on the exact SHA; Tier B needs an executable
  fail-before/pass-after lock. A provider name alone is not sufficient review.

## Consilium use

Treat the five novel rows as candidate requirements needing normal capture and
routing. Treat the donor paths as an inventory to reconcile against v3/product
scope and landed behavior. Do not import the old repository wholesale, and do
not infer completion from an archived plan's existence.
