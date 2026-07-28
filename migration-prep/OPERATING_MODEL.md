# Universal operating model

This model is product-neutral. It describes the control plane, not any worker's
domain behavior.

## Roles and contracts

- **Operator:** owns priorities and irreversible decisions; receives concise
  evidence and can pause dispatch.
- **Orchestrator:** turns approved intent into missions, routes managers and
  never edits product code or claims unverified success.
- **Manager:** owns one mission, a bounded worker set, dependency ordering and a
  single rollup. It must report evidence, blockers and next action.
- **Coder/worker:** changes only the assigned repository and supplies tests and
  artifacts; it cannot self-approve its own risky result.
- **Reviewer:** independent vendor/session for high-risk work; verifies the
  regression lock and evidence, not merely the narrative.
- **Observer:** read-only status and audit projection.

## Mission and manager/worker contract

Input is one immutable mission record with scope, acceptance tests, risk tier,
vendor policy and correlation ID. A manager returns one terminal rollup with
landed SHA(s), test evidence, unresolved blockers and disposition. Workers may
retry idempotently, but cannot silently widen scope or mutate another mission.

## Review and consortium policy

Risk determines review depth: authentication, authorization, migrations, money,
orchestration and production infrastructure require independent review. Lower
risk changes still require a lock test. When a normal cross-vendor reviewer is
unavailable, an emergency consortium uses independent role passes (diagnosis,
security, tests) and leaves a durable evidence trail; it does not waive later
required review.

## Telegram/MCP adapter

Telegram is an operator channel, not a product chat. One process owns the poll
lease. Messages are acknowledged by durable ID, replies are deduplicated, and
reconnect resumes from a persisted offset. MCP calls use bounded timeout and
backoff; stale leases are fenced. The adapter must never invent mission status
when evidence is missing.

## Evidence and communication

Every report uses the same compact shape: **done**, **evidence**, **remaining**,
**blocker**, **next action**. Human words that define a mission are preserved
verbatim in its artifact; generated summaries are separate and labelled.

The mandatory anti-distraction and completion protocol is defined in
[`COMPLETION_GUARD.md`](COMPLETION_GUARD.md). It is a hard gate: an explanation,
percentage, or new topic never substitutes for the current artifact's SHA,
tests, and runtime evidence.
