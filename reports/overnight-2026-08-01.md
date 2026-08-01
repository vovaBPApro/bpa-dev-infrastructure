# Overnight session evidence — 2026-08-01

## Verdict

`NO-GO` for product completion. Accounting reconciliation and the eleven live
data surfaces are proven. Document matching remains 0/80, three surfaces remain
partial, live authentication is off, credentials still require rotation, and
the stand runs product `20080b7` while product `main` is `812a6f2`.

This record was rebuilt from Git history and fresh live checks. Lane verdicts
were not accepted as evidence where a later hands-on result contradicted them.

## What landed — meaning for the operator

### Product capability

- Eleven live, data-backed surfaces now work: Dashboard, Bills, Documents,
  Periods, Reports, Reconciliation, Payroll, Counterparties, Team, Settings,
  and Sales invoices. Catalog, Recurring, and Mila remain explicit partials.
- The overnight product history added the accounting workflows, evidence-backed
  reports, document review, reconciliation, organization isolation, and the
  tracked rebuild/configuration boundary needed to operate those surfaces.

### Correctness

- Read-only QuickBooks reconciliation is 79/79 months (`2020-01..2026-07`):
  debit = credit = `9,163,667.8500 PLN`, net `0.0000`, 16,452 transactions,
  32,959 postings. All 237 stored report proofs were fetched/re-derived and
  reproduced; stale mismatches = 0 (`c788144`, product
  `reports/proof-hash-stable-terminal.md`).
- Organization RLS gaps fell from 29 on the first clean-container rebuild to 0.
  The tracked migration and fresh-Git container proof are `403aa2f` and product
  `reports/rls-migrations-complete-terminal.md`.
- Fresh verification now reports 492/492 infrastructure tests and 933 product
  tests passed, 10 product real-PostgreSQL tests skipped without their disposable
  database. The requested 489 infra figure was true before the last three locks;
  current `HEAD` measures 492, so this record uses the newer number.

### Infrastructure safety

- Live deploy is atomic and fail-closed on migration preflight, exact build
  identity, health, rollback, and lock contention (`14dbeff..61df238`).
- Lanes cannot reach the loopback production database and have a disposable
  PostgreSQL path (`9d164e1`, `4cdcd70`).
- Database grants are declared in Git and checked for drift (`04473bf`, merged
  by `1f4cdcd`). The landing gate now independently parses source, executes
  Git-derived tests, and corroborates candidate package scripts.

## Five production/Git divergences that took the stand down

| Divergence | Evidence-backed cause | Status now |
| --- | --- | --- |
| W-21 orphan tables | Production recorded absent migration `002_gmail_import_storage.sql` and held incompatible Gmail tables. The actor is unproven; shared-production migration by a lane is the strongest hypothesis. | Orphans preserved as `*_orphan_20260801`, phantom migration row removed, tracked migration applied. Lane production-DB access is blocked and disposable DB checks exist. |
| Unscoped sales tables | Sales tables received a live RLS hand-patch with no reproducing migration in Git. | `013_sales_invoice_organization_rls.sql` plus a real-database coverage lock landed at product `c556d38`. |
| W-27 lost `CREATE` grant | Runtime role retained `USAGE` but lost `CREATE` on `public`; no GRANT/REVOKE in either repo identifies the actor. Rollback could not repair host-only grant drift. | Grant restored; declaration, bootstrap unit/timer, and drift test landed at infra `04473bf`. |
| 16,452 NULL organization IDs | Imported legacy transactions predated organization scoping; forced RLS hid every NULL-owned row. | Product `79f596b` backfills from required context, makes ownership non-NULL, and locks imports/writes. Current matching evidence sees 16,452 rows and zero NULL owners. |
| Missing `DATA_ORGANIZATION_ID` | Required source-organization configuration was absent from the live host and from the reproducible configuration contract. | Value restored; example landed at `29ddc72`; deploy preflight refuses missing/invalid values at `431fd09`. |

## Eight landing-gate bypasses

All eight were found by independent reviewers; none was found by the author.
That is the strongest direct evidence from the session for the independent
review discipline the operator requested.

| Reviewer-found bypass | Lock covering it now |
| --- | --- |
| Batch landing could skip merged-tree verification and land a failing test. | Mandatory single/batch verification and failing-test/syntax fixtures (`016a70f`; `gate/land-batch.test.sh`). |
| Gate ignored declared `lint`/`test`; scripts set to `false` still landed. | Declared-script failure fixtures on both paths (`65796cc`, `gate/land*.test.sh`). |
| Caller set `BUN_BIN=/bin/true`, turning completion and manifest checks into no-ops. | Fixed Bun resolution plus single/batch override locks (`3970d42`). |
| Caller-controlled `PATH` replaced `node`/`pnpm` inside a failing declared check. | Sanitized verifier environment and PATH-shadow fixtures (`d006cbb`). |
| Candidate rewrote its failing package test as a successful repository wrapper. | Gate-owned direct framework corroboration using Git-derived tests (`381d10e`), with reviewer locks in `d0cf7bd`. |
| Direct corroboration collected zero tests and still returned green. | Positive collected-test count on single and batch paths (`ef189e2`, merged at `c96dfd9`). |
| A skipped-only suite collected tests but passed none and returned green. | Positive pass-count requirement and skipped-only fixtures (`3f9d5df`). |
| A candidate deleted tests, shrinking 3 tests to 1 while staying green. | Pre-merge baseline count comparison and count-collapse fixtures (`be116d2`). |

## Measurable truth now

- Reconciliation: 79/79 months; proofs 237/237 reproducible; mismatches 0.
- RLS clean-rebuild gap: 29 -> 0.
- Live stand: 11 WORKS / 3 PARTIAL; stand-truth exits 1 as designed.
- Tests: infra 492/492; product 933 passed / 10 skipped / 0 failed.
- Service: active; `/healthz` ready with reachable DB at product `20080b7`.

## Still open

- Accounting-document matching: **0 matched / 14 ambiguous / 66 unmatched**
  across 80 documents. Extraction is amount 55/80, date 70/80,
  counterparty 30/80, tax ID 30/80, document number 59/80.
- At least 26/80 documents have no corresponding transaction under the current
  exact amount/date comparison. The later first-blocker classification reports
  29 unmatched at that stage; it does not invalidate the proven minimum of 26.
- Catalog, Recurring, and Mila remain partial. Live product is behind main.

## Awaiting the operator's decision

1. Rotate Google and Intuit credentials transported through Telegram.
2. Choose the cutover moment for authentication enforcement; it remains off.
3. Approve the OCR direction for the practical first batch of about 14 files
   (product `reports/ocr-options-spike-terminal.md`).

## Reproduction commands

```sh
bun test
(cd /srv/projects/agentic-bpa && ./scripts/pnpm.sh test)
(cd /srv/projects/agentic-bpa && STAND_URL=https://agentic.bpa.pro STAND_REALM=9130357776566416 STAND_PERIOD=2026-07 STAND_ORGANIZATION=00000000-0000-4000-8000-000000000001 node scripts/stand-truth.mjs)
curl -fsS https://agentic.bpa.pro/healthz
```

The stand-truth command is expected to exit 1 while printing 11 WORKS and 3
PARTIAL; that nonzero result is the honest product-level `NO-GO`.

## Instruction consumption

```text
lane-lifecycle sha256:84d3db25d785 # Lane Lifecycle
verification-and-locks sha256:b13ed13070c1 # Verification and Regression Locks
tool-permissions sha256:955630cc416e # Tool Permissions
repository-hygiene sha256:02acdffe2a56 # Repository Hygiene
isolated-test-environments sha256:6ffd35d7c9f1 # Isolated Test Environments
operator-feedback sha256:fc36fafe4623 # Operator Feedback
instruction-layers sha256:cd21f4ce0990 # Instruction Layers
branching-policy sha256:98cd92116325 # Branching Policy
reproducible-from-git sha256:822d9efe694b # Reproducible From Git
```
