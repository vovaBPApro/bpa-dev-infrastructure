1. Freeze the demo contract: one origin, one SPA, no iframe; UI remains unimplemented until Impeccable/operator approval.
2. Treat `/srv/projects/agentic-bpa` as the only target; preserve archives read-only and inspect source, never copy `.env`/tokens.
3. PORT shell behavior from `/srv/archive/bpa-shell/apps/shell/src/components/karkas/KarkasAgentSwitcher.tsx` and `KarkasLayout.tsx` into `apps/shell`; retain client routing/prefetch, not iframe code.
4. PORT chat contract/streaming from `/srv/archive/bpa-shell/apps/shell/src/app/api/chat/chat-contract.ts` and `api/chat/stream/route.ts`; prove one Bill-directed turn.
5. Keep `apps/mila` a routeable empty stub; prove Bill↔Mila switching without reload and registry shape scalable to 10 agents.
6. PORT only integration seams already evidenced: QBO webhook handler at `/srv/archive/agent-bill/apps/web/app/api/webhooks/qbo/notifications/qbo-webhook-handler.ts`.
7. PORT Gmail backfill route at `/srv/archive/agent-bill/apps/web/app/api/integrations/gmail/backfill/route.ts` and its test; defer Pub/Sub/history workers.
8. PORT Drive connect route at `/srv/archive/agent-bill/apps/web/app/api/integrations/google-drive/connect/route.ts` and its test; defer archive/refile/custom skills.
9. Write monorepo adapters/BFF wiring and env schema only; one lockfile/React/router/CI, callbacks top-level on one origin.
10. Run narrow unit tests, build, then one live browser smoke: shell loads, switch agents, chat turn, integration status pages/callback URLs.
11. HONEST 2h demo: shell+chat+fast switching, Mila stub, and three integration cards showing configuration/status; one live OAuth connection only if credentials/callbacks already work.
12. “QuickBooks + email + Drive connected” is NOT presently credible: required credentials/redirect registration are UNVERIFIED, and no live provider probe exists.
13. Docker evidence: `release-2026-06-25` fails frozen install because root lockfile drifts from `apps/bill-cli-sidecar/package.json`; not runnable as-is.
14. `v0.2.0` passed frozen install but Bill `next build` was still running when checked; HTTP/runtime/provider verdict is UNVERIFIED.
15. Biggest risk: mistaking abundant legacy code/tests for a portable working slice; OAuth, DB migrations, queues, tenant/RLS and callbacks are coupled.
16. Likely demo disappointment: “Connected” UI backed by no successful OAuth/import, or a build that consumes the entire window before first HTTP response.
17. CUT reports/reconciliation, full transaction import, workers/webhooks, DB migration, Drive archival, Gmail Pub/Sub, QBO writes, auth hardening, and visual polish.
18. Stop rule at 45 minutes: if target has no live shell+chat, abandon integration port and demo the verified legacy candidate plus architecture plan—never mock “connected”.
