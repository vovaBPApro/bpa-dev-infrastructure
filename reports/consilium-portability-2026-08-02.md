# Portability / source inventory consilium opinion

## Consumption check

- `review-policy` `sha256:6537ef28ad14` — **Review Policy**
- `verification-and-locks` `sha256:07e760358365` — **Verification and Regression Locks**
- `roles` `sha256:cd4c40c4e640` — **Roles**
- `instruction-layers` `sha256:cd21f4ce0990` — **Instruction Layers**
- `tool-permissions` `sha256:955630cc416e` — **Tool Permissions**
- `reproducible-from-git` `sha256:822d9efe694b` — **Reproducible From Git**

## Verdict

1. Yes, attempt #1 failed the instructed portability goal: it began at `a5e6d06` as a new scaffold and rebuilt major product surfaces instead of demonstrating old-product parity.
2. Do not restart empty and do not continue indiscriminately: use a hybrid—retain proven exact ports (Gmail, Google Drive, QBO core) and redo shell/chrome, chat journey, onboarding, and missing runtime orchestration as donor-led parity slices.
3. Freeze new feature work; inventory donor capability/test pairs, assign one bounded subsystem per lane, require fail-before donor-parity locks and live journey evidence, then integrate serially behind one gated trunk.
4. Use the ~10 lanes for independent subsystem ports plus review lenses, never overlapping “union” merges; cap integration WIP and make every lane emit timed heartbeats and terminal evidence.
5. Overnight runs must be resumable queues with leases, per-command deadlines, durable progress, watchdog restart, and a bounded no-progress abort—not a single unobserved seven-hour process.

## Evidence and source inventory

Reviewed target `/srv/projects/agentic-bpa` at `b1310e004b5e65737ab66b30cefb09f85fb5ed3a`; donor `dev` refs were `bpa-master` `877ce807142804d68f1b845714743d16bda87785`, `agent-bill` `92f7ec479c4de6fe839cb37884fa8d5255a2c62c`, and `agent-mila` `edc5a4c623cae03c88e39655653d67a15900f614`. The local donor checkouts expose these as `origin/dev`; no local `dev` branch exists, so all inventory commands explicitly used `origin/dev` and made no donor mutation.

### What attempt #1 actually did

- Git history is decisive: the first commit is `a5e6d06 [CODER] Scaffold single-app pnpm monorepo`, followed by separately named ports (`6666b9c` Gmail, `e90f793` shell/chat core, `9b85136` QBO, `d32512d` design). This is a fresh reconstruction seeded with selected donor code, not a migration of the working tree.
- The resulting target is only 787 tracked files after 451 commits. Its selected surface inventory is small: `apps/shell` 48 TS/TSX/CSS files, 17 tests, 1,382 LOC; `apps/bill` 34 files, 6 tests, 797 LOC. By contrast, donor shell selected source/e2e has 320 files, 171 tests, 63,266 LOC. Counts are scope indicators, not proof by themselves; exact blobs and missing behavior below establish the classification.
- Across all target files, content-hash intersection found 43 blobs shared with `bpa-master dev`, 106 with `agent-bill dev`, and zero with `agent-mila dev`. Relevant exact mappings were concentrated in Gmail and Google Drive. The scoped shell/chrome/chat/onboarding mapping returned no exact relevant blob pair.

### Parity matrix

| Subsystem | Target reality | Classification |
|---|---|---|
| Shell chrome / agent switcher | Target has new `apps/shell/src/components/karkas/KarkasAgentSwitcher.tsx`, registry and tests, but donor has `apps/shell/src/lib/agent-switcher.ts`, extensive `components/karkas/`, visual snapshots and live e2e. No relevant exact blob mapping was found. | Reimplemented ad hoc; no donor parity proof. |
| Chat | Target has `apps/shell/server/chat.ts`, `scripts/chat-*.mjs`, and UI-action code. Donor has API route/stream/upload contracts plus 14 files/3,129 LOC in `apps/shell/src/lib/chat`, 8 files/4,319 LOC in API chat, and live e2e. Target's own `reports/port-shell-evidence.md` says iframe/proxy/postMessage paths were excluded by architecture. | Selective rewrite/port of concepts; working journey and boundary parity not preserved. |
| QuickBooks import | `9b85136` states wholesale QBO directory port. Current `packages/integrations/src/qbo/` has 45 files, 22 tests, 7,775 LOC including transaction import and one-to-one reconciliation. Its report explicitly deferred queues/workers, historical import orchestration, UI, and live Intuit consent. Donor shell additionally contains full-import routes, entity mappers/upserts, sync registry/status, worker jobs and UI. | Core is salvageable port; end-to-end import product is partial/missing. |
| Gmail import | Donor `packages/integrations/src/gmail/` has 44 files, 23 tests, 7,129 TS LOC. Target relocated it to `packages/gmail/` (53 files, 27 tests, 7,920 LOC); exact hashes include scanner, sync-history, encryption, OAuth/error tests and other core files. Target report says all 44 were ported but queue/backfill/watch orchestration and live consent were stubbed/deferred. | Genuine core port with adaptations; runtime ingestion journey incomplete. |
| Onboarding | Target has a compact `apps/bill/src/pages/onboarding-client.tsx` plus shell test/design preview. Donor contains tested cards, progress rail, router/org guards, connection status, recovery evidence and live render artifacts. Selected donor onboarding/karkas code is thousands of LOC; no relevant exact target mapping was found. | Reimplemented visual/state subset; operational onboarding parity missing. |
| Mila | Target registry deliberately labels Mila as a stub (`apps/shell/src/lib/agents/registry.test.ts`); blob intersection with donor Mila was zero. | Missing as a port (acceptable only if explicitly parked, not called parity). |

### Top salvageable assets

1. `packages/gmail/`: 53 source/test files, 7,920 LOC, 27 tests; direct content identity to donor core makes it the strongest port. Keep it, then port donor worker/watch/backfill wiring and prove live Gmail intake.
2. `packages/integrations/src/qbo/`: 45 files, 7,775 LOC, 22 tests, including `transaction-import.ts`, `reconcile-one-to-one.ts`, and named one-to-one locks. Keep the pure adapter/reconciliation core; connect the missing donor full-import orchestration and product routes.
3. `packages/integrations/src/google-drive/`: exact donor blobs across OAuth, provider, parser, clients, crypto and tests. Retain as a dependency where required, but do not confuse Drive with the Human-required Gmail source.
4. Target database migrations and reconciliation proof work may be retained only behind schema/data-integrity review; their existence does not establish donor UI or runtime parity.

### What attempt #2 must port rather than rewrite

1. Port donor shell chrome and agent switching with its e2e/visual locks from `bpa-master:apps/shell/src/components/karkas/`, `apps/shell/src/lib/agent-switcher*`, and `apps/shell/e2e/visual/`; adapt seams only after a behavior inventory.
2. Port the complete chat boundary: donor `apps/shell/src/app/api/chat/`, `apps/shell/src/lib/chat/`, upload/stream contracts, history, orchestration and live e2e. Preserve tests first; avoid inventing another transport.
3. Port the QBO full-import chain from donor routes, mappers/upserts, sync registry/status, worker initialize/webhook jobs and UI; retain target reconciliation primitives only where parity tests prove compatibility.
4. Port Gmail worker/backfill/history/watch/extraction orchestration around the already-ported core from donor `apps/worker/src/gmail*` and its integration tests. The target path rename is tolerable; the missing running pipeline is not.
5. Port onboarding as a recoverable stateful journey—cards, connection checks, org guards, retry/recovery, and live rendered locks—not as screenshots plus a compact replacement page.

### Repeat-prevention plan shape

- Wave 0: produce a machine-readable donor manifest keyed by capability, source paths, tests, runtime dependency, target disposition (`exact-port`, `adapt`, `park`) and acceptance journey. No implementation begins without a row.
- Waves 1–3: one lane per non-overlapping subsystem. First land a target parity lock derived from the donor behavior and demonstrate red; then port code; then demonstrate green at the exact SHA. UI locks run against a live surface. Integration/runtime lanes use disposable stands.
- Dedicate independent security, runtime/operations, and regression reviewers to the same integration SHA. Keep at least one lane for integration diagnosis instead of authoring overlapping fixes. Never mechanically union conflicting parallel branches.
- The orchestrator stores queue state, leases, heartbeat timestamps, command deadlines and artifacts durably. A watchdog requeues expired work; bounded retries park a row as `NO-GO`. Every overnight wave is restartable from the last landed SHA.
- Exit criterion is a small set of Human journeys, not commit volume: agent switch, chat/upload/stream, QBO import-to-one-to-one report, Gmail message-to-document-to-report, and onboarding/recovery. Each must have live evidence and teardown/rollback where applicable.

## Scope and limitations

This was a read-only source-inventory review; no product runtime was started and no claim is made that existing tests pass. Therefore `result: clean` below means the report artifact is complete and internally verified at its own worktree SHA, not that `agentic-bpa` is releasable. The product conclusion is `NO-GO` for continuing attempt #1 as though it had parity.

commit: d7ca47c301419c6643cb78c92d6475a4dce6dfe0 consilium-portability consilium opinion
verify: git diff --check HEAD^..HEAD && git cat-file -e d7ca47c301419c6643cb78c92d6475a4dce6dfe0^{commit} && git status --short && git -C /srv/projects/agentic-bpa rev-parse HEAD && git -C /root/legacy-donors/bpa-master rev-parse origin/dev && git -C /root/legacy-donors/agent-bill rev-parse origin/dev && git -C /root/legacy-donors/agent-mila rev-parse origin/dev
result: clean
secret-scan: clean
remaining: none
