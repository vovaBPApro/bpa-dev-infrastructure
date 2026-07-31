1. 0–10m: port, do not redesign, the integration slice into `/srv/projects/agentic-bpa/apps/bill`; keep one app/origin/BFF and top-level OAuth callbacks.
2. QBO EXISTS: `packages/integrations/src/qbo/qbo-adapter.ts`, `read-only-port.ts`, token crypto/state, report/parity parsers and tests.
3. QBO import EXISTS: `packages/actions/src/historical-import/initialize-books-from-qbo.ts`, `import-qbo-month.ts`, `ingest-qbo-attachables.ts` plus integration tests.
4. QBO OAuth EXISTS: `packages/actions/src/external/qbo-oauth/{initiate,callback,refresh}.ts`; encrypted DB tokens and rotation are implemented/tested.
5. Historical evidence says live raw copy reached 63/63 accounts and 14,211/14,211 transactions; current credentials/live connectivity are UNVERIFIED.
6. 10–35m: copy QBO integration/OAuth/import modules and minimal schemas into Bill vertical slice; adapt imports only to the new package graph and one BFF routes.
7. HUMAN—QBO: provide/confirm Intuit app client ID+secret, environment/realm, register the new exact HTTPS callback, then complete the consent click.
8. Gmail EXISTS: `packages/integrations/src/gmail/{real-provider,oauth,sync-history,scan-transactions,materialize-evidence-attachment}.ts` with extensive tests.
9. Gmail actions/workers EXIST: `packages/actions/src/gmail/` and `apps/worker/test/gmail-history-scan-real-pg.integration.test.ts`; history checkpoints/replay are implemented.
10. Gmail tokens use `GMAIL_TOKEN_ENCRYPTION_KEY`; OAuth/env, refresh failures, CSRF, parsing, attachments and provider error scrubbing are tested.
11. 35–60m: port Gmail provider/OAuth/history scanner and document materialization; expose connect/callback/backfill endpoints through the same Bill BFF.
12. HUMAN—Gmail: confirm Google Cloud OAuth client, enable Gmail API, add exact callback/authorized origin, approve requested Gmail scopes and consent.
13. Drive EXISTS: `packages/integrations/src/google-drive/{read-client,write-client,storage-client,provider,oauth}.ts` with read/write/provider/OAuth tests.
14. Drive OAuth/actions EXIST: `packages/actions/src/external/google-drive-oauth/{initiate,callback,refresh,storage-location,set-archive-folder}.ts`; tokens encrypted/rotated.
15. Drive supports readonly/Sheets scopes, `drive.file`, full Drive/shared-drive handling and My Drive fallback; current shared-drive access is UNVERIFIED.
16. 60–85m: port Drive client/OAuth/folder selection and connect it to Gmail evidence-document storage/materialization; no old iframe popup bridge.
17. HUMAN—Drive: enable Drive + Sheets APIs, confirm OAuth client/redirect, consent scopes, select/grant the target folder/shared drive; admin approval may be required.
18. 85–105m: port only required DB tables/repos for external connections, Gmail cursors/messages/attachments, Drive archive records and QBO staging/provenance.
19. 105–115m: run existing narrow unit tests, then real per-lane Postgres OAuth-token-store/import/checkpoint tests; use stub OAuth for deterministic callbacks.
20. 115–120m: live smoke each connect redirect/callback and one QBO pull, one Gmail attachment, one Drive list/upload after HUMAN consent; otherwise report NO-GO.
21. Biggest risk: credentials/callback/domain consent, not missing code; without timely HUMAN OAuth clicks, “connected in 2h” is impossible despite the port.
22. CUT: UI beyond plain connect/status controls, QBO ledger posting/reports, webhooks/PubSub, background supervisors, shared-drive creation and historical full backfills.
23. CUT: MS Graph email (`packages/integrations/src/email/msgraph/`) unless the operator says “email” means Outlook; prioritize the proven Gmail path.
24. Acceptance at 2h: three stored encrypted connections plus one authenticated read/import smoke each; no claim of production readiness from archive tests alone.
