# Product documentation index (where the old product intent actually lives)

Source: the outgoing orchestrator, 2026-07-31, answering HR-330's instruction to
find the product migration plan and the open-questions documentation. Recorded
here because a pointer held only in a mailbox file is not durable (Hard Floor 5).

**Status: pointers, not verified content.** Lane `ag-product-docs-hunt` is
fetching and assessing these; treat relevance as unconfirmed until it reports.

## Repo names — measured, and it corrects the correction

The outgoing orchestrator warned that `bpa-master` might not exist and the repo
is really `bpa-shell`. Measured directly:

    git ls-remote git@github.com:vovaBPApro/bpa-master.git HEAD -> d0a99b84…
    git ls-remote git@github.com:vovaBPApro/bpa-shell.git  HEAD -> d0a99b84…
    both: 155 refs

**Both names resolve to the SAME repository** — GitHub is redirecting the old
name after a rename. So `bpa-master` is not dead, and lanes already cloning it
got the right code. `bpa-shell` is the canonical name and is what to use going
forward. Half of the warning was right (canonical name) and half was wrong (the
old name still works); saying which is which matters more than being polite.

The three product repos:

| repo | what it is |
| --- | --- |
| `vovaBPApro/bpa-shell` | operator shell (`apps/shell`), client-portal (`apps/client-portal`), master-orchestrator (`packages/master-orchestrator`), base packages (auth, db-base, notifications, ui-base) |
| `vovaBPApro/agent-bill` | finance worker — **the key product** |
| `vovaBPApro/agent-mila` | barber-booking worker — to be stubbed (HR-330) |

No fourth product repo was found referenced anywhere. `bpapro-agents`
(GCP project 628068962434) is a cloud project, not a git repo.

## There is NO discrete product migration plan

Stated plainly because HR-330 asked for one: no `PLAN_product_migration`
document exists. The `migration-prep/` package the outgoing orchestrator holds is
**infra control-plane only** (mission store, leases, heartbeat TTL, Telegram/MCP
reconnect, status projection) — effectively a P0 spec for THIS repo, not a
product cutover plan. Do not present it to the operator as the product plan.

The product intent is distributed across the docs below instead.

## Product intent — all on `origin/main` of `bpa-shell`

- `PRODUCT.md` — strategy / North Star ("The Control Desk": chat finds, UI shows
  the answer; Bill is the centre).
- `docs/definition.md` — full product scope (shell, client-portal, workers).
- `docs/architektur.md` — system shape.
- `docs/limitations.md` — known code-vs-spec deviations; a de-facto
  open-problems list.
- `docs/STATUS.md` — where things stood.
- `DESIGN.md` + `.impeccable/design.json` — visual system, tokens, WCAG AA.

### Concepts (`docs/concepts/`)

- **`CONCEPT_spa_agent_modules.md`** — the iframe→SPA agent-switching design.
  **This is the direct answer to HR-330's open question**: how to keep fast,
  smooth agent switching WITHOUT iframes. Read this before designing the new
  shell.
- `CONCEPT_shell_owns_chrome.md`
- `CONCEPT_chat_driven_minimal_dashboard.md`
- `CONCEPT_bpa_pro_box.md`
- `CONCEPT_orchestration_fleet_architecture.md`

## Open questions — the re-litigation risk

- `docs/ops/DECISIONS_PENDING.md` (main) — the live open-decisions ledger. Open
  at snapshot: `priorities_after_reassess`, `order_cleanup_policy_2026-07-23`,
  `forms_requirements_b464_2026-07-24` (5 product-design questions, including
  "Create parity = full legacy vs simplified unified-create").
- `docs/ops/FORMS_REQUIREMENTS_B464_2026-07-24.md` + `_ADDENDUM_2026-07-26` —
  29 verbatim Vova quotes + 12 MUST-requirements. **On `dev`, not `main`.**
- `docs/ops/REASSESS_2026-07-23.md` (main) — priorities table.
- `docs/ops/archive/DECISIONS_RESOLVED_2026-07-23_snapshot.md` — what was ALREADY
  decided. Read it to avoid reopening settled questions.
- `backlog.md`, `docs/bugreport.md`, `docs/limitations.md` — running open lists.

## Decisions reported as already firm

Relayed from the outgoing orchestrator's memory, flagged as **unverified** —
confirm against the docs before relying on any of them:

- single-org per user; entities are the multi-tenant axis (per-entity CoA now;
  consolidation + RLS deferred);
- Bill immediate scope = source documents: import all QuickBooks transactions,
  supplement from email, match and finalize, acceptance = reports reconcile 1:1
  with QuickBooks (this matches HR-330 independently, so confidence is high);
- Mila reduced to a stub;
- unified-tx migration mid-flight: Stage S shipped, Stage F cutover pending;
- Bill is chat-first with minimal UI;
- `impeccable` (impeccable.style) is the binding UI-quality bar for all UI work.

Related: [[HR-330]] (the product restart directive, verbatim).
