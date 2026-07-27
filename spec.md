# Control-plane specification (draft)

The control plane persists append-only mission events and snapshots. A lease has
an owner, expiry and fencing token. A dispatch is signed and idempotent. Active
status requires a fresh heartbeat, an unexpired lease and a running report;
terminal reports are never active. Telegram/MCP uses one poll lease, durable
offsets, message-ID deduplication and bounded retry/backoff.

See `migration-prep/contracts.md` for the P0 contract detail and
`migration-prep/test-plan.md` for acceptance gates.

Universal deployment adds a clean-host bootstrap contract: pinned prerequisites,
unprivileged service identity, redacted self-check, idempotent initialization,
explicit Telegram pairing, and an operator-approved readiness transition.
Access roles, audit events, secret redaction, cache quotas, branch retention,
and friend-install export/uninstall are part of the contract surface.
