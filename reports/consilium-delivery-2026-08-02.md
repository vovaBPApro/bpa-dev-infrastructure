# Delivery economics consilium — HR-1363

## Consumption check

- review-policy sha256:6537ef28ad14 — Review Policy
- verification-and-locks sha256:07e760358365 — Verification and Regression Locks
- roles sha256:cd4c40c4e640 — Roles
- instruction-layers sha256:cd21f4ce0990 — Instruction Layers
- tool-permissions sha256:955630cc416e — Tool Permissions
- reproducible-from-git sha256:822d9efe694b — Reproducible From Git

Reviewer identity: `consilium-delivery`, independent read-only delivery-economics lens.
Reviewed infrastructure SHA: `d7ca47c301419c6643cb78c92d6475a4dce6dfe0`.
Reviewed product SHA: `b1310e004b5e65737ab66b30cefb09f85fb5ed3a`.
Risk classification: Tier A context (accounting integrity, auth, production and evidence); this is an opinion, not a landing approval.

## Verdict

1. Yes: attempt #1 failed as a delivery, although it produced valuable code; after 451 commits in two days, its own live audit still marked the overnight set NO-GO and the acceptance path was not demonstrable.
2. Recommend a defined hybrid: keep the monorepo architecture, migrations, imported ledger, QBO/Gmail cores and reconciliation locks; stop feature expansion and redo the plan, evidence ledger, live acceptance slice, and incomplete shell/chat UX.
3. Do not restart from an empty tree: that discards the only credible live-data and reconciliation assets; do not simply continue: the 451-commit breadth-first pattern and stale workboard would repeat the failure.
4. Week milestone: Day 1 freeze/inventory and select one golden QBO company+period; Day 2 show shell switcher+real chat; Day 3 import QBO+Gmail documents; Day 4 match/finalize; Day 5 render three reports and prove every row ONE-TO-ONE; Days 6–7 harden/replay and obtain independent acceptance reviews.
5. Run ten lanes as five coder/reviewer pairs on one vertical slice, with one integration owner and no new surface until the previous slice is green at the live boundary.
6. Budget: hybrid 24–32 codex-lane-days (3–5 elapsed days ideally; 5–7 with review/runtime friction); continue 18–26 nominal but 35–55 risk-adjusted; empty restart 45–65 nominal and 60–90 risk-adjusted.
7. Reserve 30–40% schedule contingency for W-31/W-33/W-38-class stalls; unattended overnight work is limited to hermetic checks, never shared-host deploy/restart rehearsal.

## Evidence that attempt #1 failed as delivery

- The tree is substantial, not empty: `agentic-bpa` has 451 commits, all dated 2026-07-31 or 2026-08-01 (215 and 236 respectively), and 778 changed files relative to its root commit. That velocity is evidence of throughput, but not acceptance.
- The repository's own live audit, `reports/morning-readiness-2026-08-01.md`, says `Result: NO-GO for the full overnight candidate set`. It records working dashboard, connections, ledger and partial bills, but reports refused the real period, documents were empty, chat navigation/knowledge/rules returned 503, and multiple surfaces were render-only or missing.
- Later work materially improved the accounting core: `reports/live-reconcile-proof-terminal.md` records 16,452 live QBO transactions, 32,959 postings, 79/79 periods, 237 stored report proofs, and three July report responses at HTTP 200. This is strong keep evidence, but it proves the QBO ledger/report side, not the full QuickBooks-plus-Gmail match/finalize acceptance journey.
- The current one-to-one report itself remains internally stale: `reports/qbo-reconciliation-one-to-one.md` says `NO-GO pending commit-SHA verification and landing evidence`, says production QBO access was absent, and cites fixture-only verification. A newer live proof exists, but the evidence chain is fragmented rather than one current rerunnable acceptance record.
- `README.md` still opens with “Foundation-only monorepo ... currently ships no product features,” contradicting the large implemented surface. The control-plane `instance/workboard.md` simultaneously says no implementation evidence exists for PR-2/PR-3/PR-5/PR-7 while the product tree contains and reports ports for those areas. This stale state makes autonomous scheduling economically unsafe.
- History shape is consistent with breadth-first churn: 143 merge-subject commits and 43 subjects containing fix/rework/round in two days; 85 report files contain `NO-GO` or rejection language. These are not defects by themselves, but combined with the failed live morning candidate they show coordination and integration cost consumed the nominal parallelism.
- The Human's bar is narrower than the shipped breadth: “з QuickBooks ... імпортуємо список транзакцій ... З пошти ми фактично тільки доповнимо їх даними документами ... репорти мають зійтись повністю один в один.” Attempt #1 added many secondary surfaces before making that single journey the authoritative demo and gate.

## Option economics

| Option | Scope | Nominal cost | Stall-adjusted cost | Delivery judgment |
|---|---|---:|---:|---|
| Continue current backlog | Reconcile stale workboard while fixing whichever partial surface is next | 18–26 lane-days | 35–55 lane-days | Cheapest on paper, worst queueing/rework risk; no single acceptance spine controls scope. |
| Empty-tree restart | Recreate monorepo, DB/migrations, QBO/Gmail integration, auth, live import, reports and UI | 45–65 lane-days | 60–90 lane-days | Clean narrative, economically irrational: discards proven live import/reconciliation and repeats risky accounting work. |
| Defined hybrid (recommended) | Preserve proven primitives/data; rebuild the delivery plan and only the incomplete acceptance-facing seams | 24–32 lane-days | 32–45 lane-days | Fastest credible route because it buys clarity without repaying solved infrastructure/accounting costs. |

The estimates count one focused coder or reviewer lane working one day as one lane-day. Ten lanes do not turn 30 lane-days into three days automatically: shared schema, deployment, live credentials, review and integration serialize the critical path. A realistic target is a five-day acceptance slice plus two days of contingency.

## Keep, redo, defer

Keep, subject to exact-SHA reverification: the one-SPA/no-iframe monorepo established at `a5e6d06`; Gmail core at `6666b9c`; shell routing/chat core at `e90f793`; QBO core at `9b85136`; current PostgreSQL migrations and imported ledger; live reconciliation/proof machinery evidenced by `reports/live-reconcile-proof-terminal.md`; current tests that exercise these exact boundaries.

Redo: the mission/workboard from current-tree facts; one executable golden-journey gate; evidence reports so each superseded NO-GO is clearly dispositioned; the shell/chat user journey where the live audit found 503s; Gmail document population and visible QBO-to-document match/finalize; presentation of row-level one-to-one report reconciliation. Rebuild a component only when its current boundary fails the golden journey—particularly the transaction form, where HR-535 explicitly permits selective rebuilding.

Defer until the golden journey is accepted: client portal, payroll, team/services, catalog/recurring, broad settings, additional product parity and Mila beyond the required stub. These may be valuable, but they do not shorten the stated acceptance path.

## Week-shaped execution plan

- Day 1 — truth reset: freeze feature merges; map every acceptance step to current code, live data, owner, test and reviewed SHA. Reconcile `instance/workboard.md` and product reports. Choose one representative QBO company and closed period with Gmail documents. Produce a single failing end-to-end acceptance command before fixes.
- Day 2 — first user-visible result: deploy the persistent shell with agent switcher and a real Bill chat turn; prove the chat opens Bill/report destinations against the running surface. This gives the Human something coherent to judge early, after the required consilium visual gate.
- Day 3 — source spine: replay all QBO transactions for the golden period and ingest Gmail attachments idempotently with provenance. Display imported totals and unmatched-document queue; no secondary UI work.
- Day 4 — accounting workflow: match documents to QBO transactions, visibly review, finalize, and prove retry/idempotency and audit trail. Transaction-form changes follow HR-535's gather/design/consilium/Human-approval gate.
- Day 5 — acceptance: generate P&L, balance sheet and trial balance from Bill and compare stable row identities and values ONE-TO-ONE with QBO for the same envelope. Publish one rerunnable evidence record tied to the deployed SHA.
- Days 6–7 — contingency and confidence: independent accounting/security/runtime/regression passes, clean-clone build, disposable deployment, full replay, rollback, and only then expand to a second period/company.

## Stall-risk control

W-31 shows a daemon restart killed the orchestrator and left a 14-minute headless gap; later host rehearsals correlated with more session deaths and leaked scopes. W-33 records repeated self-echo ignitions, roughly two alerts per second, session deaths and many review rounds. W-38 remains open and explicitly blocks shared-host rehearsal until W-37 lands and maintenance is announced. These incidents mean overnight autonomy currently has negative expected value when it touches the shared control plane.

Schedule assumptions therefore include a 30–40% contingency. Overnight lanes may run clean-clone builds, fixture replays, static review and disposable isolated stands only. Shared service restart, live deploy, credentialed import and watchdog recovery run in announced daytime windows with a checkpoint before mutation and a human-readable recovery artifact. Pairing five implementation lanes with five independent review lenses caps work in progress and prevents ten simultaneous branches from creating another integration morning.

## Donor posture

The standing donor rule is usable: the donor clones expose `origin/dev` for `bpa-master`, `agent-bill`, and `agent-mila`. Treat those branches as a read-only capability quarry, not a merge base. Port a donor slice only when it closes a named golden-journey gap and preserve a source/parity note; otherwise the current product implementation is the cheaper starting point.

## Evidence commands

```sh
git rev-parse HEAD
git status --short
git -C /srv/projects/agentic-bpa rev-parse HEAD
git -C /srv/projects/agentic-bpa status --short
git -C /srv/projects/agentic-bpa log --oneline --decorate -25
git -C /srv/projects/agentic-bpa log --format='%ad' --date=short | sort | uniq -c
git -C /srv/projects/agentic-bpa rev-list --count HEAD
git -C /srv/projects/agentic-bpa diff --stat "$(git -C /srv/projects/agentic-bpa rev-list --max-parents=0 HEAD)"..HEAD
rg -n 'W-(31|33|38)|PR-(1|3|5|7|13)' instance/workboard.md
sed -n '1,180p' instance/decisions/HR-330.md
sed -n '1,140p' instance/decisions/HR-535.md
sed -n '1,120p' instance/decisions/HR-537.md
sed -n '1,150p' /srv/projects/agentic-bpa/reports/morning-readiness-2026-08-01.md
sed -n '1,150p' /srv/projects/agentic-bpa/reports/live-reconcile-proof-terminal.md
sed -n '1,120p' /srv/projects/agentic-bpa/reports/qbo-reconciliation-one-to-one.md
```

commit: d7ca47c301419c6643cb78c92d6475a4dce6dfe0 consilium-delivery consilium opinion
verify: test "$(git rev-parse HEAD)" = d7ca47c301419c6643cb78c92d6475a4dce6dfe0 && test "$(git -C /srv/projects/agentic-bpa rev-parse HEAD)" = b1310e004b5e65737ab66b30cefb09f85fb5ed3a && rg -n '^(## Verdict|commit:|verify:|result:|secret-scan:|remaining:)' orchestrator/runtime/reports/consilium-delivery.report.md
result: clean
secret-scan: clean
remaining: none
