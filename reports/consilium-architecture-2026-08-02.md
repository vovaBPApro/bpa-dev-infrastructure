# Architecture consilium — attempt #2

## Consumption check

- review-policy sha256:6537ef28ad14 (baseline) # Review Policy
- verification-and-locks sha256:07e760358365 (baseline) # Verification and Regression Locks
- roles sha256:cd4c40c4e640 (baseline) # Roles
- instruction-layers sha256:cd21f4ce0990 (baseline) # Instruction Layers
- tool-permissions sha256:955630cc416e (baseline) # Tool Permissions
- reproducible-from-git sha256:822d9efe694b (baseline) # Reproducible From Git

## Verdict

1. Так, attempt #1 провалився як керована поставка: `main` має 451 commit за ~16.5 годин, але workboard досі каже PR-2/3/4/5/9 `open` / no landing evidence, а canonical verify падає (46/953 tests).
2. Не починати з порожнього дерева: **частково випатрати** поточний `agentic-bpa`.
3. Зберегти: monorepo/lockfile, єдиний React/Router shell, agent registry/switcher, Mila stub, QBO/Gmail/Drive ingestion та їх чисті domain tests.
4. Випатрати/заморозити: client portal, payroll, sales, reports-first UI, auth expansion і product-side `master-orchestrator` до завершення Bill source-document vertical slice.
5. Перебудувати chat як окремий core acceptance stream: UI control, DB query, cited knowledge, safe rule proposal/confirm/reversal, live end-to-end locks.
6. Plan shape: один інтеграційний trunk; ≤3 залежні streams (shell/chat, QBO ledger, Gmail document match), решта lane capacity — review/test; WIP limit 1 per stream.
7. Кожен slice має dependency graph, allowlist, red-before lock, disposable live stand, exact-QBO fixture reconciliation, review і merge-before-next; overnight run лише з heartbeat, timeout, checkpoint/resume й owner.

## Evidence

### Base architecture worth retaining

- `/srv/projects/agentic-bpa/package.json`, `pnpm-workspace.yaml`, and `pnpm-lock.yaml` establish one workspace and one lockfile. All three product apps pin React `18.3.1`; shell alone owns `BrowserRouter` (`apps/shell/src/main.tsx`) and the routing tree (`apps/shell/src/App.tsx`).
- `apps/shell/src/App.tsx` mounts agent routes as React components under persistent `KarkasLayout`; no iframe reference exists in runtime app code. `apps/shell/src/lib/agents/registry.ts` discovers agent entrypoints into one module graph. `KarkasAgentSwitcher.tsx` changes client-side paths, retaining instant-switch behavior without browser boundaries.
- `apps/mila/src/index.tsx` renders only “Mila is not implemented yet.” This correctly implements PR-4.
- QBO, Gmail, document import/matching, reconciliation, and fail-closed write guards have substantial focused tests. The 2026-08-02 run executed 150 files: 145 passed, 4 failed, 1 skipped; 897 tests passed, 46 failed, 10 skipped. This is useful salvage, not a releasable green base.

### Evidence that attempt #1 failed

- Current product SHA is `b1310e004b5e65737ab66b30cefb09f85fb5ed3a` (`main`, also `origin/main`). History contains 451 commits from `a5e6d06` at 2026-07-31 14:08+02 to `b1310e0` at 2026-08-01 06:35+02: extreme integration churn over ~16.5 hours rather than staged acceptance.
- The authoritative `instance/workboard.md` still labels PR-2, PR-3, PR-4, PR-5 and PR-9 open and says no implementation/landing evidence exists, despite corresponding code now being present. Architecture, execution record, and acceptance state disagree.
- `./scripts/verify.sh` at product SHA `b1310e0` failed: typecheck, lint, install and build passed, but tests reported `VERIFY_SUMMARY result=fail steps_passed=4 steps_failed=1 tests_passed=897 tests_failed=46`. Failures span `serve.test.mjs` (33), `auth-routes.test.mjs` (9), `dashboard-data.test.mjs` (3), and `dev-smoke.test.ts` (1), mainly server-connect timeouts. The suite is therefore neither hermetic nor green on the powerful host.
- A direct `pnpm ci` is not executable (`pnpm: command not found`); the tracked canonical route is `./scripts/verify.sh`, which bootstraps through `scripts/pnpm.sh`. This is documented, but it makes the package script itself a misleading operator entrypoint.
- The tree already totals 39,472 TypeScript/TSX/MJS lines and includes 13 workspace projects. `apps/client-portal`, payroll, sales/catalog/recurring, reports, broad auth, and `packages/master-orchestrator` expanded before the Human's Bill-first source-document slice was accepted. This is scope inversion, not evidence that those components are intrinsically unusable.
- Git refs contain many post-`main` coder and rejected-review commits (for example `788c307` rejects undeployed chat UI control, `afcf2c2` rejects matching safety, `dc43fed` rejects a false screen/API lock). They are not ancestors of `main` and cannot support a claim about the current base.

### Ruling-by-ruling architecture assessment

- **PR-1:** materially satisfied in code: one repo, one lockfile, one React version, one shell routing tree. The extra `apps/client-portal` and unrelated product-side orchestration package broaden the agreed topology and should be quarantined, not used to discard the sound monorepo foundation.
- **PR-2:** mechanism is sound: one SPA document, persistent shell chrome, client routing, no iframes. Tests cover registry uniqueness, agent selection and FLIP switch behavior, but the full live surface is not green because canonical verification fails.
- **PR-3:** core QBO/Gmail/document primitives are the strongest salvage. However Bill navigation and `BillModule` expose reports, payroll, invoices, catalog, recurring, banking and other lateral surfaces before the source-document workflow has a single accepted, live, one-to-one reconciliation slice. Keep domain primitives; reset delivery order and UI exposure.
- **PR-4:** satisfied by the tiny Mila module; keep unchanged.
- **PR-9/PR-11 chat:** code now contains bounded UI actions, database resolvers, cited knowledge lookup, and audited categorization-rule proposals. Yet the canonical server tests for live chat fail, UI action review refs show deployment gaps, and evidence is mostly unit-level. Treat implementation as prototypes behind a disabled boundary until one live vertical acceptance suite proves all four Human-named capabilities and safety/reversal.

### Concrete attempt #2 shape

1. Tag `b1310e0` as the attempt-1 salvage baseline; create a new plan, not an empty product tree. Inventory every retained module by accepted requirement and remove/quarantine anything without a current Bill-first row.
2. Stabilize the shell spine first: one route registry, agent switch, persistent chat chrome, Mila stub, production server startup and a live browser switch lock. No feature lanes merge while `./scripts/verify.sh` is red.
3. Deliver one Bill vertical slice: QBO transaction import -> durable managerial/statutory-ready transaction model -> Gmail evidence materialization -> safe unique match/review -> exact fixture reconciliation. Only then reopen reports or adjacent accounting surfaces.
4. Deliver chat through four explicit acceptance rows matching HR-537, with read versus write capabilities separated. Rule mutations require preview, confirmation, audit and reversal; untrusted knowledge must remain data, not instruction.
5. Use the ten-lane capacity for bounded parallelism, not ten simultaneous feature branches: three coders maximum on independent dependency nodes, three independent reviewers, two integration/runtime lanes, one failure-diagnosis lane, one coordinator slot. Merge small slices continuously; discard stale competing branches.
6. Every overnight job gets a durable mission/checkpoint, heartbeat freshness threshold, hard timeout, automatic restart from checkpoint, retained logs, and a morning terminal verdict. A silent seven-hour process is a failed run, never progress.

## Commands and inspected evidence

```sh
git -C /srv/projects/agentic-bpa rev-parse HEAD
git -C /srv/projects/agentic-bpa status --short
git -C /srv/projects/agentic-bpa log --first-parent --oneline -35 main
git -C /srv/projects/agentic-bpa rev-list --count HEAD
rg --files /srv/projects/agentic-bpa
rg -n 'iframe|BrowserRouter|Routes|Route|Chat|chat|knowledge|matching|categor' /srv/projects/agentic-bpa/apps /srv/projects/agentic-bpa/scripts
sed -n '24,75p' instance/workboard.md
sed -n '1,240p' instance/decisions/HR-330.md
sed -n '1,220p' instance/decisions/HR-535.md
sed -n '1,220p' instance/decisions/HR-537.md
(cd /srv/projects/agentic-bpa && pnpm ci) # exit 127: pnpm absent
(cd /srv/projects/agentic-bpa && ./scripts/verify.sh) # exit 1: 897 pass, 46 fail, 10 skipped
```

Reviewed product SHA: `b1310e004b5e65737ab66b30cefb09f85fb5ed3a`.
Reviewer independence: `consilium-architecture`, read-only architecture lens; no product code authored.
Tier: A (architecture/core delivery and evidence-gate implications).
Verdict: **NO-GO** for continuing feature development on current `main`; **GO only for a controlled partial gut and staged salvage**.

commit: d7ca47c301419c6643cb78c92d6475a4dce6dfe0 consilium-architecture consilium opinion
verify: (cd /srv/projects/agentic-bpa && ./scripts/verify.sh); sed -n '24,75p' instance/workboard.md; git -C /srv/projects/agentic-bpa log --first-parent --oneline -35 main
result: NO-GO
secret-scan: clean
remaining: none
