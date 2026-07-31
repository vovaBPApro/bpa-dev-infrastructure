# Product migration documentation inventory

Date of inventory: 2026-07-31
Directive: `instance/decisions/HR-330.md` at `origin/main` commit `7925e9c`

This is an index, not a new product plan. The status labels below compare each
artifact with the binding direction in HR-330: rebuild in new repositories,
leave the three legacy repositories untouched, build the shell first, keep Mila
as an empty stub for now, and make Bill's first product slice import all QBO
transactions and enrich them with matched email documents.

## READ THESE FIRST

1. **`migration-prep/STACK_CONSILIUM_FINAL.md`** — 2026-07-29. The closest
   thing found to the prepared **product migration plan**. It specifies the new
   repo topology, Vite/Hono/Bun/Postgres/Drizzle stack, shell composition without
   iframes, module boundaries, test strategy, and phased delivery (rails, then a
   Bill vertical slice, then harvest). **RELEVANT**, but HR-330 changes its
   product ordering/details: Mila is now only a stub and Bill's immediate slice
   is QBO transaction import plus email-document matching, not the older generic
   ledger slice. Treat the architecture as a strong proposal and re-baseline the
   delivery phases against HR-330.
2. **`migration-prep/STACK_DECISION.md`** — 2026-07-29. Preserves the Human's
   stack complaint and the resulting hard constraints: keep a separate shell,
   remove iframes, avoid coupled long builds, use separate repos, and compose
   agent UI as modules. **RELEVANT** and directly explains why the rebuild is
   happening. HR-330 reinforces its no-iframe diagnosis.
3. **`migration-prep/problem-matrix.md`** — 2026-07-27. Compact record of the
   failure classes the new system was intended to prevent: resource pressure,
   coupled builds, shared mutable environments, runtime drift, and weak
   verification. **RELEVANT** as a risk checklist; it is infrastructure-heavy,
   not a complete product open-question register.
4. **`migration-prep/HISTORY_SWEEP_MISSED_COMPLAINTS_2026-07-29.md`** —
   2026-07-29. Audit of 2,124 inbound messages, including product requirements
   easily lost during the reset (QBO/Drive/email matching, shell settings and
   chrome, access scoping). **RELEVANT** as recovered requirements evidence;
   individual rows still need reconciliation with HR-330.
5. **`bpa-master` commit `35583841`,
   `docs/concepts/CONCEPT_spa_agent_modules.md`** — authored 2026-06-18,
   reconciled 2026-06-24. The clearest old target architecture: one shell SPA,
   build-time agent UI modules, one router/chrome/session, separate agent APIs.
   **RELEVANT DESIGN INPUT, NOT CURRENT PLAN**. Its own status says stale/not
   implemented, but it closely matches the new no-iframe direction.
6. **`bpa-master` commit `35583841`,
   `docs/concepts/CONCEPT_shell_owns_chrome.md`** and
   **`docs/concepts/CONCEPT_agent_karkas_protocol.md`** — authored
   2026-06-16/20, reconciled 2026-06-24. These document shell ownership and the
   missing uniform install/conformance contract for Bill/Mila. **RELEVANT
   PROBLEM/CONTRACT INPUT**; implementation checklists describe the abandoned
   legacy tree and must not be copied as current state.
7. **`agent-bill` current/history docs:**
   `docs/plans/PLAN_F_gangsta_qbo_books_parity.md`,
   `docs/plans/PLAN_F_gangsta_email_scanner.md`,
   `docs/plans/PLAN_email_intake_extraction_and_matching.md`,
   `docs/plans/PLAN_ws6_matching_core.md`, and
   `docs/plans/PLAN_bill_qbo_full_initialization.md`. Mostly May–July 2026.
   Together these are the closest detailed specifications for HR-330's first
   Bill slice: QBO parity, email intake, extraction, matching, and initial
   import. **RELEVANT DONOR MATERIAL ONLY**. Their statuses and assumptions are
   inconsistent across active/archive copies, so requirements must be harvested
   and tested rather than treating any one plan as approved wholesale.

## Product migration and restart plans found

| Artifact | Date | Covers | Disposition |
|---|---:|---|---|
| `migration-prep/STACK_CONSILIUM_FINAL.md` | 2026-07-29 | Proposed rebuild architecture, stack, repo topology, phases, donor strategy | **RELEVANT**, closest recovered migration plan; update phases for HR-330 |
| `migration-prep/INSTRUCTIONS_CONSILIUM_FINAL.md` §§ legacy harvest | 2026-07-29 | Read-only donor rules and what to harvest into future framework/Bill/Mila repos | **RELEVANT**; aligns with leaving archives untouched |
| `migration-prep/UNIVERSAL_PROJECT_PLAN.md` | 2026-07-27 | Generic project/orchestration migration program | **PARTLY RELEVANT** to execution mechanics, not a product plan |
| `bpa-master:docs/plans/archive/PLAN_bpa_shell_migration.md` at `13ef4d63` | 2026-06-24; archived 2026-06-25 | Cutover from `/home/agent-bill` to `/home/bpa-shell`, daemon/cron/runtime state | **SUPERSEDED / WRONG MIGRATION FOR THIS ASK**; host cutover completed, not product rebuild |
| `bpa-master:docs/ops/PRODUCT_LESSONS_PRE_WIPE_2026-07-28.md` at `5c8206be` | 2026-07-28 | Product-specific failure lessons preserved before VM wipe | **RELEVANT** as migration hazards; not itself a plan |

## Open questions, unresolved decisions, and known problems

| Artifact | Date | Covers | Disposition |
|---|---:|---|---|
| `bpa-master:docs/ops/DECISIONS_PENDING.md` | last changed 2026-07-28 | Human decisions open in the old operating cycle | **MOSTLY SUPERSEDED**; useful evidence, but includes host/security/queue questions unrelated to the rebuild |
| `bpa-master:docs/ops/REASSESS_2026-07-23.md` and `CORE_BILL_2026-07-23.md` | 2026-07-23 | Verified old backlog and a pruned Bill core | **PARTLY RELEVANT**; HR-330 supersedes its freeze/order, but its intake→registry→matching→review gap remains useful |
| `bpa-master:docs/ops/REPLAN_2026-07-21.md` | 2026-07-21 | Branch inventory, open defects, stale plans, onboarding and Gmail gaps | **STALE operationally**, valuable as a catalog of known defects and abandoned work |
| `bpa-master:backlog.md`, `docs/backlog.md`, `docs/bugreport.md` | accumulated through July 2026 | Shell/integration defect ledgers | **DONOR EVIDENCE**; not a current backlog until deduplicated and reproduced |
| `agent-bill:docs/backlog.md`, `docs/bugreport.md`, `docs/bugreports/*.md` | accumulated through July 2026 | Bill feature gaps and named defects | **DONOR EVIDENCE**; large and internally inconsistent, require repro/acceptance triage |
| `agent-bill:docs/CONCEPT_bank_reconciliation.md` and `CONCEPT_gmail_intake_configuration.md` | May–July 2026 history | Reconciliation and Gmail intake design questions | **RELEVANT** to the first Bill slice, subject to HR-330 re-baseline |
| `migration-prep/problem-matrix.md` | 2026-07-27 | Cross-cutting technical failure classes and proposed controls | **RELEVANT** |
| `migration-prep/HISTORY_SWEEP_MISSED_COMPLAINTS_2026-07-29.md` | 2026-07-29 | Requirements/complaints missed by earlier migration prep | **RELEVANT**, recovered evidence rather than settled decisions |

The most important unresolved architectural conflict is visible in the old
concepts themselves: `CONCEPT_shell_owns_chrome.md` proposed proxied agent
surfaces with a contribution contract, while `CONCEPT_spa_agent_modules.md`
proposed build-time UI packages and explicitly marked the proxy model wrong.
The July 29 stack consilium chooses module composition/no iframes. HR-330 keeps
the desired smooth switching but rejects the iframe mechanism, so the rebuild
must make that choice explicit and lock it with integration/build-time tests.

## Other architecture/spec/RFC material

### Shell (`bpa-master`)

- `docs/architektur.md`, `docs/definition.md`, `docs/limitations.md` — baseline
  system description. **STALE BASELINE**, useful for inventory only.
- `docs/concepts/CONCEPT_spa_agent_modules.md` — single-SPA/build-time modules.
  **RELEVANT proposal; never implemented**.
- `docs/concepts/CONCEPT_shell_owns_chrome.md` — chrome/auth/chat/settings
  ownership and migration seams. **RELEVANT proposal; partial legacy state**.
- `docs/concepts/CONCEPT_agent_karkas_protocol.md` — mandatory agent install
  contract and conformance suite. **RELEVANT requirements source**.
- `docs/ops/PRODUCT_LESSONS_PRE_WIPE_2026-07-28.md` — basePath, RSC, build,
  DB, worker, QBO, e2e, and security failure classes. **RELEVANT hazards**.

### Bill (`agent-bill`)

- `docs/definition.md` and `docs/MASTER_ROADMAP_bill_as_agent_2026-05-18.md` —
  broad domain/product scope. **PARTLY RELEVANT**, much broader than HR-330's
  first slice.
- QBO: `PLAN_QBO_LIVE_ADAPTER.md`, `PLAN_qbo_comprehensive_readonly_sync.md`,
  `PLAN_bill_qbo_full_initialization.md`, `PLAN_b225_qbo_initialization_parity.md`,
  `PLAN_F_gangsta_qbo_books_parity.md`. **RELEVANT donor specs**, overlapping
  and sometimes archived.
- Email/documents: `PLAN_F_gangsta_email_scanner.md`,
  `PLAN_email_intake_extraction_and_matching.md`,
  `PLAN_drive_email_ingest_archival.md`, `PLAN_gmail_processed_label.md`,
  `PLAN_ws6_matching_core.md`. **RELEVANT donor specs**.
- Reconciliation: `CONCEPT_bank_reconciliation.md`,
  `PLAN_GENERAL_BANK_RECONCILIATION.md`, and the reconciliation plans under
  `docs/plans/`. **RELEVANT LATER/SELECTIVELY**; HR-330's immediate acceptance
  is report parity with QBO, not wholesale resurrection of every workbench.

### Mila (`agent-mila`)

- `docs/definition.md`, `docs/architektur.md`, `docs/design/DESIGN_mila_ui.md`,
  `docs/concepts/CONCEPT_mila_app_and_web.md`, and extensive booking/Booksy
  plans under `docs/plans/`. Mostly June 2026. **SUPERSEDED FOR CURRENT SCOPE**:
  HR-330 explicitly reduces Mila to an empty stub because the old product was
  not Human-tested. Keep only as historical/domain material for a later Mila
  mission.

## Where the hunt looked

- `bpa-master`, `agent-bill`, and `agent-mila`, fetched read-only into
  `/root/.cache/product-archaeology/`; searched all reachable refs and object
  names, not only default branches.
- Full commit histories, including explicit
  `git log --all --diff-filter=D --name-only -- '*.md'` deletion sweeps. The
  Bill history contains a large 2026-06-12 deletion of review/audit packets;
  those packets are recoverable but are mostly reviews of still-identifiable
  plans, not a single missing product-migration document. Shell's migration
  plan was moved to archive, not lost. No product migration plan was found in
  Mila's deleted history.
- This repository's complete `migration-prep/` tree.
- `/root/orch-mailbox/`, including both handoff directions. The new
  orchestrator asked the old orchestrator for the plan at
  `to-oldorch.md` around line 2737; **no answer containing or locating the plan
  was present** in `from-oldorch.md` at inventory time.
- `instance/decisions/`, plus `origin/main:instance/decisions/HR-330.md` because
  this lane's base predates commit `7925e9c`. Related architecture wording was
  found in HR-11555/HR-11557; no separate product plan was found in the ledger.

## Explicitly not found

1. **No single document titled or unambiguously identified as “the product
   migration plan” from the earlier planning period.** The July 29 stack
   consilium is the best recovered plan-like artifact; the June shell migration
   runbook is a completed host cutover and must not be substituted for it.
2. **No canonical, consolidated register containing only the then-open product
   design questions.** The questions are distributed across concept status
   blocks, `DECISIONS_PENDING`, backlog/bugreport files, plan review packets,
   and the July history sweep.
3. **No reply from the “other agent” naming an additional plan or repository.**
   The mailbox request exists, but no matching response was found.
4. **No additional product repository beyond the three named archives** was
   identified from the searched repo history, mailbox, migration prep, or HR
   ledger. If another agent held a private/unpushed repo or chat-only document,
   it must be supplied or reconstructed.
5. **No settled new-build decision for the exact QBO↔email matching lifecycle,
   conflict handling, provenance, or one-to-one report-parity dataset.** Old
   Bill plans supply candidate behavior, but HR-330's exact acceptance contract
   still needs a new mission/spec with fixtures and parity tests.

These five gaps are the bounded reconstruction list. The rebuild planner should
not silently fill them from the stale legacy backlog.
