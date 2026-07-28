# Incident Traceability

| Rule | Incident that created it |
|---|---|
| Report requires SHA + runnable command; no SHA means not done. | The prior chain substituted complex explanations, repeated promises, and percentages for finished artifacts; the requirements matrix says progress without repo evidence is `NO-GO`. |
| Artifacts beat explanations. | The Human killed the previous orchestrator partly because it talked around work instead of landing files after nearly a day of weak progress. |
| Zero secrets in git and mandatory `secret-scan: clean`. | The clean repo was seeded with 2682 old commits, including plaintext secrets. |
| Clean history only; import narrow reviewed files, not legacy history. | The same 2682-commit import polluted the reset with old project state and secrets. |
| Bun/TypeScript-only target runtime. | A Python contour was built for a Bun/TS daemon migration even though the stable runtime inventory points to Bun/TypeScript. |
| No provider-specific prompt files beyond `CLAUDE.md` and symlinked `AGENTS.md`. | A provider file for an unused provider was copied in as boilerplate; the cleanup review accepted removing that competing authority. |
| Orchestrator dispatches, lands, reports; it does not author risky/runtime code. | Old hard rule 13 came from orchestrator hand-coding failures and the new operating model keeps the orchestrator as control plane, not implementer. |
| Coder lanes produce assigned artifacts, tests, secret scan, commit, and terminal report. | Prior lanes stalled or left incomplete reports; the operating model requires terminal worker evidence. |
| Independent review for risky diffs, cross-vendor when available. | Human requirements HR-08 and old rule 18 require review that catches false greens, not narrative approval. |
| Green is fail-closed. | The Human explicitly demanded that forged green be made impossible; migration docs require absent, stale, forged, or contradictory evidence to be `NO-GO`. |
| Docker/runtime claims need live runtime evidence. | Independent review rejected migration completion because Docker/auth/soak/rollback and parallel stand evidence were missing. |
| Branches die after merge and terminal worktrees are reaped. | Branches grew to roughly 300 and worktrees to roughly 100; the problem matrix records branch/worktree churn as a failure. |
| One visible mission chain; no repeated audit promises. | The predecessor repeatedly promised the same audit and switched narrative instead of closing the current artifact. |
| Ask the Human almost never. | The previous system asked the Human to do tasks the agent could do itself; hard rules 14/15/22 reserve asks for irreversible decisions. |
| Do not outsource agent work to the Human. | The predecessor asked the Human for inspections/actions that the agent could run directly. |
| Preserve verbatim Human requirements in mission artifacts. | Human requirements matrix HR-12 and old rule 21 came from details being dropped or reinterpreted across sessions. |
| English for code/docs/reports; Ukrainian for Human chat. | Root communication rules and HR-16 require plain Ukrainian progress to the Human while keeping repository artifacts in English. |
| Telegram admin is not product chat; status must be deduped and evidence-backed. | The operating model separates Telegram as operator channel and records reconnect/dedup/status invention risks. |
| Leases, TTL, fencing, and stale-status handling are runtime invariants. | The problem matrix records stale/false-active status and Telegram/MCP reconnect risk. |
| Resource limits, bounded concurrency, and soak gates are infrastructure defaults. | The problem matrix records repeated disk pressure around 94% and HMR OOM evidence. |
| Fresh Ubuntu bootstrap must not depend on `/home/bpa-shell`. | HR-18 requires clean-VM rehearsal independent of legacy host state. |
| Morning stand reports must use concrete evidence, not jargon. | HR-14/HR-16 require timestamped stand health and concise plain-language “what changed / what to test” reports. |
