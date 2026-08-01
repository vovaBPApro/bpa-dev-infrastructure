# Handover — 2026-08-01 morning (orchestrator restart at operator's request)

## Operator state
He is awake, frustrated, and right to be: nothing product-facing was deployed
overnight, branches bred, and designs were never sent for approval until asked.

## Rulings captured this session
- **HR-681** (`instance/decisions/HR-681.md`) — "в старих репо дивись бранчі дев!
  Тільки дев!!!!" Donor `main` is stale; `bpa-master origin/dev` is **134 commits
  ahead** and its tip is his filed product complaints from 2026-07-29, which HR-535
  explicitly asked for. Read `origin/dev`, never `main`.

## What is TRUE on the stand right now (verified, not claimed)
- deployed: `b1310e0`, healthz carries build.commit, == product origin/main
- **documents match: 13** — visible live, `/api/bill/documents` returns
  matched=13 unmatched=124, identical to the database; the screen renders the
  status column (verified by rendering the page, not by trusting the API)
- reconciliation holds: 79/79 months, debit=credit=9,163,667.8500, net 0.0000
- entries paginated: total 16452, 330 pages
- live truth gate passes honestly: Bills 488/488, Documents 137/137,
  Entries 16452/16452, Periods 35/35, Dashboard 35/35; one real mismatch —
  Document review renders 72 vs 137 in table (likely correct filtering of 65
  non-accounting docs, NOT yet settled)

## Open blockers, in priority order
1. **Landing gate redesign is UNSAFE as written.** `review-report-contract`
   returned: "report-only child may overwrite any single tracked file". A
   report-only landing path that can overwrite arbitrary tracked files is a hole in
   the most safety-critical path in the repo. Do not land `report-contract-redesign`
   until this is closed. Note the original contract was logically impossible (report
   must name the branch tip, but committing the report changes the tip) — that
   diagnosis stands and `stand-verify-role` did land through the fix (`e95df6d`).
2. **237 reconciliation proofs all diverge** from a fresh computation. Systemic, not
   a data change. Suspect volatile input again (previously hashed QBO Header.Time).
   Must not be "fixed" by regenerating proofs or relaxing comparison.
3. **False-green logic still in the lock**: screen N rows vs database 0 rows scored
   as a match. Root cause of the live instance was a wrong org id in the stand config
   (fixed, `c19933a`), but the logic that turns "compared nothing" into WORKS remains.
4. **Reconciliation guard passes a month with no data** as a balanced zero month.
   Data disappearing for a period reads as healthy.
5. Chat UI control: safety fixed (registry lookup, no model backend capture), blocked
   on deploy to claim live acceptance. Rejected twice on substance, third time only
   on "stand still serves old build".
6. Branch hygiene: 121 infra + 163 product branches, 338 worktrees. `branch-hygiene-reap`
   running; merged refs are reapable, unmerged must be retained with evidence
   because landing was mechanically broken all night.

## Designs — sent to him this morning
- `https://agentic.bpa.pro/design/transaction-form.html` (passed 5th consilium;
  four earlier attempts rejected for internal contradictions)
- `https://agentic.bpa.pro/design/index.html`
- Awaiting HIS approval before implementation (PR-8 sequence:
  gather -> design with Impeccable -> consilium -> his approval -> implement)

## Lanes running at handover
branch-hygiene-reap legacy-dev-plans 

## Immediate next actions
1. Close the report-only overwrite hole, then land the queue (several ACCEPTed
   branches are waiting only on this).
2. Deploy, so chat/matching code and the lock can be verified live.
3. `legacy-dev-plans` mines donor `origin/dev` for his transaction-form complaints.
4. Keep 10 lanes (HR-281); notify him unprompted below 3.
