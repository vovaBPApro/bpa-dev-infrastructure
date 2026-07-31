# Stack post-mortem: why the legacy product kept breaking

## Scope and evidence

This report answers HR-330's stack question from read-only archaeology of all refs in three archive repositories cloned on 2026-07-31: `bpa-master` (2,978 commits, 155 heads), `agent-bill` (13,761 commits, 112 heads), and `agent-mila` (865 commits, 8 heads). The archives were not modified or pushed.

Churn below is `git log --all --numstat`, so it includes parallel/repeated lane work as well as landed history. That is useful for measuring engineering cost, but it is not a count of distinct production defects. Commit subjects and source inspection are used to establish the failure mechanism. Generated evidence, bundles, database snapshots, lockfiles, and backlog files were excluded when ranking product code.

## Finding in one sentence

The main problem was not TypeScript, React, or Next.js in isolation. It was an over-distributed architecture: three independently built Next applications were recomposed at runtime through persistent iframes, shared workspace packages, proxies, cookies, postMessage protocols, and coordinated Compose stands. That turned ordinary navigation, authentication, dependency, and form changes into cross-repository integration work; a branch-heavy delivery process then multiplied the cost and made the true integrated state hard to establish.

## Ranked recurring failure themes

### 1. The iframe composition seam repeatedly broke navigation, state, auth, and tests

**Classification: ARCHITECTURE (primary), process (secondary).**

This is the strongest finding. The shell's `KarkasAgentSurface` deliberately kept every agent iframe mounted and hid inactive frames; that implementation explains the fast, smooth switching the operator valued. But the same component also maintained per-agent frame URLs and load state and mirrored frame location into shell history. The Bill repository documented the resulting obligations explicitly: scroll, focus, deep links, prefill, history, width notifications, message validation, and cookie trust.

Evidence:

- Shell product churn concentrates in `KarkasLayout.test.tsx` (98 commits / 6,243 changed lines), `KarkasLayout.tsx` (70 / 3,274), `agent-proxy.test.ts` (37 / 2,466), and chat streaming (`route.ts`, 17 / 1,506; its test, 32 / 1,970).
- `5404e875`, `df381d9b`, and several sibling commits all say “Fix active agent chat routing” / “Fix Bill onboarding routing stand”; `009b96fd` binds streamed tasks to shell session identity; `fb40fbdc` fixes a live selector; `d6818c63` diagnoses Mila signed proxy behavior.
- Bill's live journey notes record the concrete iframe failure: the shell rewrote iframe navigation without the URL hash, dropping the prefill token. Bill therefore added a query-token fallback (`use-prefill.ts`) and shell-aware frame polling. `5070becb7` fixes a Drive OAuth popup hang because Intuit refuses to authorize inside a frame.
- The test surface itself became frame-specific: Playwright repeatedly uses `frameLocator('iframe')`, while shell tests need `iframe[data-active=true]`, cross-frame URL observation, and proxy/setup emulation.

**Diagnosis against HR-330:** confirmed. Iframes bought instant switching by retaining mounted applications, but exported browser boundaries into product behavior. This was not merely a slow test runner; application flows had to work around the frame.

**New-build action:** remove agent iframes from the authenticated product shell. Preserve perceived speed with one SPA document, client-side routing, persistent shell/chrome, route-level code prefetching, and a small keep-alive cache only for expensive agent roots where measurement proves it useful.

### 2. Build/dependency topology drifted across repositories and environments

**Classification: ARCHITECTURE + STACK.**

The system expected independent repositories to behave like one workspace at build time. Shared `@bpa/*` packages, pnpm importers, Next server externalization, symlinks, Docker build contexts, and staging hydration all had to agree. That agreement repeatedly failed.

Evidence:

- Lockfiles are the top mutable source artifact in every archive: shell 51 commits / 98,896 changed lines; Bill 142 / 71,299; Mila 35 / 12,515.
- Shell commits `9381fe47`, `677a1131`, `56ac2a87`, `5fa8dfb9`, and `f47daeef` repeatedly repair merge-gate hydration/relinking; `4b33efb4` records esbuild binary repair; `1f1d8c68` says staging was blocked by a stale Mila lockfile.
- Bill commits `4f2c5d7e`, `99d3411a`, `42e70d03`, and `0028ad0b` successively repair surface dependency declarations, local type resolution, route exports, and workspace-link resolution. `1543dd323`/`80cdab9b3` repair PDF runtime externalization.
- Mila commits `ba8bf2f` (shared paths in isolated builds), `6441de5` (Drizzle resolution in umbrella Docker), `1c199b1` (shared-package path depth), `014b72f` (404/500 pages for build stability), and `54b6cef` (lockfile importer drift) show the same class independently.

**Diagnosis against HR-330:** confirmed. “Builds slowly/badly” came from independently versioned apps still requiring source-level and runtime composition. Next.js was made to cross boundaries it does not make cheap.

**New-build action:** begin with one pnpm/Bun-compatible monorepo and one web application/deployable. Put domain modules behind TypeScript package boundaries, not deployment boundaries. Use a single lockfile, React version, auth implementation, routing tree, and CI graph. Split a service only after an operational boundary is demonstrated (different scaling, security, or failure domain), not merely because it is named Bill or Mila.

### 3. Authentication, origin, proxy, and redirect behavior was environment-sensitive

**Classification: ARCHITECTURE (primary), STACK (Next middleware behavior), process (insufficient early assembled-stack locks).**

Evidence:

- A dense shell sequence repeatedly repaired redirect semantics: `f1922b99` restores absolute middleware redirects; `260c8d18` and `1e62c002` preserve public origin; `db421797` bypasses loopback normalization; `c795c59f`, `1c93e4d7`, and `df2005f2` repair login redirects and post-login origin. The recorded failure was cookie loss when middleware changed `127.0.0.1` to `localhost`.
- Bill commits `c4f533a52`/`f5e9de424` align live auth with seeded-user behavior, `8c12f1355` authorizes master chat with the browser session, and `30520a1e` aligns route shape with the `/bill` base path.
- Mila needed credentials forwarded in the embedded client (`fbae999`), trusted signed shell identity (`fa30108`), org-scoped auth/RLS fixes (`5ecb229`, `48d242a`), and a special RSC-prefetch redirect response (`ee1e71f`).

**New-build action:** one browser origin and one BFF/session boundary. Route `/bill/*` and `/mila/*` inside the same application; do not mint a second browser identity or proxy browser auth between agents. Test the exact public-origin topology in Playwright and Compose before adding product breadth. Keep OAuth callbacks as top-level routes, never framed flows.

### 4. Bill accumulated broad, high-churn modules and unstable cross-layer contracts

**Classification: ARCHITECTURE + PROCESS, not an inherent language failure.**

Bill's `packages/actions/src/index.ts` changed in 740 commits (6,298 lines churn), the new-entry page in 93 (7,971), `LineItemsSection` in 40 (6,145), ledger router in 47 (5,866), transaction form in 39 (4,929), and orchestration pipeline in 33 (8,225; tests 34 / 6,379). These are integration magnets: UI, accounting, intake, policy, and orchestration changed through a few broad seams.

Evidence includes `427e525f` (React hook-order crash on zero-line entries), `e5df4431` (unknown transaction type), repeated hydration/date fixes `56cc8a46`, `46749354`, and `0e08cb04`, plus the Gmail cluster `7164b6c6`, `c7b0d0e6`, `c50dbce7`, `4e6450cb`, and `e7ad8b2b` around transaction scope, history checkpoints, replay, cancellation, and worker normalization.

**New-build action:** organize Bill by vertical domain slices: `transactions`, `documents`, `matching`, `ledger`, `integrations/qbo`, `integrations/email`, and later `reports`. Each owns schema adapters, application service, API contract, UI, and tests. Replace barrel-style action registries and giant routers with explicit commands/queries. Keep double-entry posting in a small deterministic domain core with invariant/property tests. Make imports idempotent jobs with durable checkpoints and source provenance.

### 5. Database migration and background-worker contracts were fragile

**Classification: ARCHITECTURE + PROCESS.**

Evidence:

- Bill's migration journal changed in 249 commits; commits `f1cad415`, `78e3092b`, `ee406121`, and `6be1fa2e` repair journal presence, numbering, and ordering. Gmail fixes repeatedly address nested transaction/RLS scope (`dd7dbbee`, `7164b6c6`, `c7b0d0e6`) and replay/FK order (`8eda291f`, `c50dbce7`).
- Mila similarly repaired migration journals and schema expectations (`91ccb18`, `123a426`, `0dd364e`) plus shared Drizzle typing/build resolution (`32bf987`, `6441de5`).

**New-build action:** one migration owner and one forward-only chain per database; migration verification against an empty database and a production-shaped snapshot in CI. Workers receive IDs, open their own transaction, set tenant context inside it, and commit checkpoints atomically with side effects. The QBO and email imports must be resumable and idempotent by external source ID/content hash.

### 6. Branch and evidence proliferation obscured the integrated product

**Classification: PROCESS.**

At capture time, 154 of 155 shell heads, 111 of 112 Bill heads, and 7 of 8 Mila heads were not merged into each repository's `main`. Some are intentional review/proof refs, but there are also `rescue/stash-*`, `backup/*`, repeated `r2`–`r20` verification branches, and many same-SHA candidate/reviewer heads. Examples include six shell closure failures (`r12` through `r20`) before a green stand, and four separate Bill gate targets for one hydration issue. This is direct evidence that “what is the product?” was expensive to answer.

**New-build action:** trunk-based short-lived lanes, a serialized landing gate, and automatic branch/worktree reaping after acceptance. Evidence belongs in durable reports attached to one mission, not permanent refs. A feature is incomplete until the assembled application test passes at the landing SHA.

## Composition choice for the rebuild

| Option | Switching feel | Build time | Testability | Isolation / independent deploy | Verdict |
|---|---|---|---|---|---|
| **SPA + client-side routing** | Instant after prefetch; shell never remounts | Best: one graph, cached incremental builds | Best: one DOM, normal locators and history | Module boundaries, one deploy | **Choose now** |
| **Module federation** | Near-SPA; remote can load on demand | Separate builds, but host/remote compatibility and shared singleton coordination add cost | Better than iframe, harder than monolith; runtime composition needs contract/E2E tests | Independent deploy, weaker failure isolation than iframe | Reconsider only when independent agent release trains are a measured need |
| **Web components** | Fast once loaded | Separate bundles possible; React wrappers/design-token/event contracts add work | Shadow DOM and custom-event testing are workable but more complex | Good UI encapsulation, weak data/runtime isolation | Use only for framework-neutral distributable widgets, not the main shell |
| **Server-driven UI** | Navigation can be fast with streaming, but interactions still need a client runtime | Centralizes rendering; schema/renderers become a second platform | Schema tests are easy; rich behavior/debugging becomes indirect | Strong server control, low frontend autonomy | Use selectively for chat cards/forms, not whole accounting screens |

Recommended shape:

1. One React/Next web app with a persistent shell layout and client router. `/bill/*` is the real product; `/mila` is a literal stub route until its acceptance scope exists.
2. Prefetch the next agent's route bundle on switcher hover/focus and after idle. Preserve recent route/client state in a bounded cache; keep durable state in URL/query cache, not hidden DOMs. Measure click-to-content and target sub-100 ms for cached switches.
3. One BFF, browser session, design system, navigation contract, and error boundary. Agent modules expose route entries and navigation metadata as compile-time TypeScript contracts—no iframe URL, postMessage, proxy, or duplicate chat protocol.
4. Bill starts with the thin vertical path HR-330 names: QBO transaction ingestion → immutable source record → email document ingestion → deterministic candidate matching → human finalization → double-entry posting. Reports come after the imported ledger reconciles one-to-one with QBO fixtures.
5. Add contract tests for the module API, unit/property tests for accounting and matching, real-Postgres integration tests for import/checkpoint/RLS behavior, and a small Playwright suite against the assembled app. Build and test only affected workspace packages plus the assembled smoke; run full reconciliation at the gate.

## What to keep and what to replace

Keep TypeScript, React, PostgreSQL, Playwright, the persistent shell UX, the agent switcher concept, route prefetching, Bill's accounting invariants/provenance ideas, and the intent to isolate domains. Keep iframe embedding only for genuinely external untrusted widgets or document viewers, not first-party agents.

Replace the three-browser-app composition with one app; runtime iframe registry with compile-time route/module registration; cross-app browser auth and signed proxy hops with one session/BFF; duplicated shared packages and lockfiles with one monorepo graph; giant action barrels with vertical slices; and branch/evidence accumulation with short-lived lanes and one landing SHA.

Do **not** adopt module federation at the start. It preserves the organizational premise that created much of the cost before there is evidence the new product needs independent frontend deploys. The monorepo is not a forever-monolith ruling: domain packages make a later extraction possible with observed boundaries.

## Confirmed, refuted, and unknown

- **Confirmed:** the shell was structurally complex; its core layout and tests dominate shell product churn.
- **Confirmed:** iframe retention delivered smooth switching, and iframe seams made auth, navigation, prefill, OAuth, and live tests materially harder.
- **Confirmed:** the selected stack/topology produced repeated dependency, isolated-build, Docker, and runtime-externalization repairs.
- **Refined:** “the stack was not ideal” is too broad if read as “React/Next/TypeScript were wrong.” Evidence points more strongly to runtime micro-application composition and repository/deploy topology than to those base technologies.
- **Unknown:** no timing telemetry was found that quantifies build duration or switch latency, so “slow” cannot be expressed numerically.
- **Unknown:** `/root/orch-mailbox` contained infrastructure handoff/daemon material but no attributable product Telegram transcript for the legacy period. HR-330 and commit/document history were available; conversational frequency could not be independently measured.
- **Unknown:** unmerged heads cannot all be called abandoned features without their mission dispositions. Their volume proves coordination cost; it does not prove every branch was intended to land.
- **Unknown:** no clean runtime resurrection of the old full stack was attempted in this instruction-mechanics lane. This report makes no claim that a particular archive SHA currently deploys successfully.
- **Unknown:** the archives show what was implemented and repaired, not current product priorities beyond HR-330. Mila should therefore remain a stub, as directed, rather than importing its large unvalidated feature surface.

## Reproducible archaeology commands

```sh
git --git-dir=/root/.cache/product-archaeology/bpa-master.git rev-list --all --count
git --git-dir=/root/.cache/product-archaeology/agent-bill.git rev-list --all --count
git --git-dir=/root/.cache/product-archaeology/agent-mila.git rev-list --all --count
git --git-dir=/root/.cache/product-archaeology/bpa-master.git log --all --numstat --format=
git --git-dir=/root/.cache/product-archaeology/agent-bill.git log --all --numstat --format=
git --git-dir=/root/.cache/product-archaeology/agent-mila.git log --all --numstat --format=
```
