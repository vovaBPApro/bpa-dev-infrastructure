# PORTABILITY — 2-hour port order
1. Freeze UI implementation; expose only headless routes/contracts until operator approves Impeccable design.
2. Scaffold one app boundary in `/srv/projects/agentic-bpa` with `/bill` and `/mila` routes; Mila stays a stub (written, not ported).
3. PORT shell agent model first: `/srv/archive/bpa-shell/apps/shell/src/lib/agents/` (7 TS files, 568 LOC, 36K) + switcher `/apps/shell/src/components/karkas/KarkasAgentSwitcher.tsx`.
4. REWRITE composition only: do not lift `KarkasAgentSurface.tsx`; it retains iframes/frame URL state. Register up to 10 client-routed agent modules instead.
5. PORT chat core: `/srv/archive/bpa-shell/packages/master-orchestrator/src/` (47 TS files, 6,961 LOC, 296K); adapt its `@bpa/db-base`/`@bpa/llm` imports to the single repo.
6. REWRITE thin chat transport: `/apps/shell/src/app/api/chat/stream/route.ts` is Next + shell-session coupled; preserve routing behavior/tests, place behind the new one-origin BFF.
7. PORT auth domain from `/srv/archive/bpa-shell/packages/auth/src/` (32 TS files, 4,189 LOC, 212K); do not copy old middleware/proxy/cookie topology.
8. PORT QBO core wholesale: `/srv/archive/agent-bill/packages/integrations/src/qbo/` (35 files, 6,596 LOC, 292K); adapters/parsers/parity/webhook guards are framework-neutral.
9. PORT Gmail core wholesale: `/srv/archive/agent-bill/packages/integrations/src/gmail/` (44 files, 7,129 LOC, 324K); `googleapis` provider/parsers/sync primitives have no iframe/Next dependency.
10. PORT Drive core wholesale: `/srv/archive/agent-bill/packages/integrations/src/google-drive/` (24 files, 5,785 LOC, 228K); OAuth/read/storage clients are framework-neutral.
11. PORT integration tests with each core; run their narrow package tests before wiring credentials, then prove real connection/import against disposable lane state.
12. ADAPT, do not lift, OAuth endpoints under `/srv/archive/agent-bill/apps/web/app/api/integrations/{qbo,gmail,google-drive}/`: they import `next/*`, `@agent-bill/auth`, actions, active-org, cookies.
13. ADAPT import orchestration from `/srv/archive/agent-bill/apps/worker/src/` (62 files, 13,164 LOC, 600K): take only QBO/Gmail/Drive jobs and rebind queue/DB/action contracts.
14. First vertical proof: connect QBO → import/store transactions; connect Gmail → import attachments; connect Drive → import/archive one document; return status through chat/BFF.
15. Keep the old shell visual chrome and Bill UI out of the first two hours; paths are verified but await approved Impeccable design.
16. Biggest risk: the portable providers are small islands; successful import depends on old `actions` + DB schema + queue contracts, not merely OAuth connectivity.
17. CUT: reports, statutory ledger, webhook/pubsub automation, historical backfill, matching UI, notifications, Mila functionality, iframe compatibility, and pixel parity.
18. Two-hour acceptance: three OAuth connections start/complete and one bounded read/import per provider is evidenced; full historical import is UNVERIFIED until DB/queue adaptation runs.
