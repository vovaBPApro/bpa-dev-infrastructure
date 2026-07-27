# Fable review handoff

## Context

The previous development infrastructure accumulated stale status, branch and
worktree churn, memory/disk pressure, fragile reconnect behavior and unclear
deploy provenance. Product code and control-plane concerns were coupled. A
clean standalone repository now contains only the proposed control-plane
contracts and preparation documents; no implementation or secrets are present.

## Audit conclusion

Do not copy the old runtime wholesale. Preserve proven ideas—correlation and
audit envelopes, signed dispatch, mailbox guards, lease/heartbeat semantics and
role boundaries. Quarantine ad-hoc shell orchestration, historical-beat status,
worker-owned Telegram leases, generated snapshots and product code.

## Decision options

1. **Sidecar migration (recommended):** shadow-read three missions, then canary
   one manager and retain rollback to the old daemon.
2. **Targeted repair:** implement persistence/TTL/reconnect contracts in the
   old system if the control stand passes two clean runs.
3. **Full rebuild:** only after sidecar and targeted repair fail explicit gates;
   this is the slowest and riskiest option.

## Acceptance criteria

- One immutable SHA/schema manifest and reproducible clean-host bootstrap.
- Two consecutive green end-to-end runs and three shadow projection matches.
- Restart/replay, lease fencing, duplicate delivery and reconnect tests green.
- Truthful active/blocked/terminal status; no terminal heartbeat shown active.
- Four-hour bounded soak without unexplained OOM, leak or disk breach.
- Security review accepts secret redaction, least privilege and audit trail.
- Canary rollback succeeds; no production integration is enabled by default.

## Open risks

Resource caps and PostgreSQL exhaustion, external Telegram/MCP availability,
unknown old production provenance, backup/restore design, package supply-chain
trust, and accidental retention of sensitive runtime artifacts.

## Questions for final Fable review

1. Are the carry-over contracts sufficiently evidence-backed, or should any be
   rejected pending a fixture?
2. Is sidecar shadow mode the correct first migration, and are its no-go gates
   strict enough?
3. Which persistence engine and backup/restore contract are acceptable?
4. What exact operator action authorizes Telegram lease cutover?
5. Are the resource budgets and four-hour soak adequate for a first canary?
6. Does the friend-install flow need additional isolation or revocation steps?

