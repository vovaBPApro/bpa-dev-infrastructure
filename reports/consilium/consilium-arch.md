# ARCH — 2-hour port plan
1. 0–10m: freeze the seam already present in `/srv/projects/agentic-bpa/apps/shell/src/App.tsx`: one SPA routing tree (`/bill/*`, `/mila/*`), one origin, one deployable.
2. Keep `/srv/projects/agentic-bpa/pnpm-lock.yaml` and `pnpm-workspace.yaml` as the only dependency graph; extend root CI, never add per-agent lockfiles or deploys.
3. 10–25m: PORT shell behavior from `/srv/archive/bpa-shell/apps/shell/src/components/karkas/KarkasAgentSwitcher.tsx` and chat contract from `/srv/archive/bpa-shell/apps/shell/src/app/api/chat/stream/route.ts` into the single shell/BFF.
4. Do NOT port `KarkasAgentSurface.tsx`, `use-surface-url-sync.ts`, `lib/agent-proxy.ts`, iframe URL/postMessage/cookie protocols, or persistent hidden agent DOMs.
5. Preserve switching speed with React Router navigation plus hover/focus/idle route prefetch; add bounded state cache only after latency is measured.
6. Keep `/srv/projects/agentic-bpa/apps/mila/src/index.tsx` a literal stub; port no Mila routers, registry, auth, or deploy machinery.
7. 25–70m: PORT narrow tested adapters from `/srv/archive/agent-bill/packages/integrations/src/{qbo,gmail,google-drive}/`, beginning with `qbo/read-only-port.ts`, `gmail/oauth.ts`, and `google-drive/read-only-port.ts`.
8. Co-locate their server endpoints behind the shell's single BFF/session/origin; OAuth callbacks are top-level routes, never framed or second-origin redirects.
9. PORT adjacent adapter tests (`qbo/__tests__/read-only-port.test.ts`, `gmail/__tests__/oauth.test.ts`, `google-drive/__tests__/read-only-port.test.ts`) before wiring credentials.
10. 70–100m: write thin target-owned module boundaries: `integrations/qbo`, `integrations/email`, `integrations/drive`, each exposing explicit commands/queries and typed results.
11. Do NOT port `packages/actions/src/index.ts`, surface registries, giant routers, cross-repo workspace links, legacy Compose/proxy topology, migrations, workers, reports, or UI components.
12. Add a module contract: `{id, basePath, routes, navLabel, preload}`; compile-time uniqueness of `id/basePath` lets 10 agents register without runtime barrel discovery.
13. Ten-agent scaling means lazy route chunks, isolated vertical slices, no agent-to-agent imports, shared auth/BFF only, and one assembled-app smoke at the landing SHA.
14. 100–120m: prove root `pnpm run ci`; smoke switch Bill↔Mila; test QBO/email/Drive OAuth URL/callback and read-only adapter boundaries with mocks.
15. Live credential connection/import is UNVERIFIED until secrets and provider callbacks are available; never claim “connected” from unit mocks.
16. Biggest risk: legacy adapters reach through hidden DB/env/queue/barrel dependencies, turning a file copy into resurrection of the old distributed topology.
17. Cut to hit 2h: all UI implementation pending Impeccable/operator approval, reports/reconciliation, durable workers/checkpoints, write APIs, migrations, and production Docker.
18. Two-hour deliverable: one-app architectural lock plus three compiled/tested read-only integration seams; live imports only if dependency inventory proves them self-contained.
