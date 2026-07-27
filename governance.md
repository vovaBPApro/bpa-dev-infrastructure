# Governance

- Orchestrator routes missions and never edits product code.
- Managers own one mission and a bounded worker set; one mission has one rollup.
- Coders edit product repositories; reviewers are independent vendor/session.
- Every state transition carries a correlation ID and durable evidence link.
- No secrets, production deploys, or live data are stored here.
- Branches are short-lived `mission/<id>` refs; archive evidence before closure.

## Universal-project boundaries

The repository is a control-plane product, not a worker/product monorepo. All
bootstrap scripts, installers and hygiene jobs must be idempotent, least
privilege, observable and reversible. A clean host is never modified until the
operator reviews the redacted self-check. Security, persistence and lifecycle
contracts are versioned before implementation.

Production implementation is explicitly not complete. Readiness requires the
staged tests, security review, shadow run and rollback drill in the migration
plan.
