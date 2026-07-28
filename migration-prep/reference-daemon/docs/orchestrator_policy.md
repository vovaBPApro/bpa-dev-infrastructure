# Orchestrator Policy

Default automation boundaries for Telegram-driven projects created from this
template.

## Modes

Two independent flags in `~/.claude/auto_approve.json` govern automation:

- `enabled` — auto-approve mode for low-risk §4 Approval / §6 merge.
- `autonomy.enabled` — autonomous Orchestrator dispatch and phase advancement.

Both default to `false`; the Human can disable either flag directly.

## Orchestrator Authority

The Orchestrator may start/reconnect provider sessions, route Telegram/tmux
messages, prepare prompts, run read-only inspections, run approved verification
commands, classify review verdicts, prepare PR notes, and perform mechanical
status/archive moves when policy allows.

The Orchestrator must not author plan/concept bodies, production code, tests,
migrations, or final reviews for its own work.

## Auto-Approve Eligibility

§4 Approval may auto-fire only when required review alternation is complete,
final reviewer verdicts are `APPROVE` or `APPROVE_WITH_NITS`, all nits are
handled, breaking changes are absent or explicitly Human-approved, no blockers
are open, and Orchestrator audit finds no process anomaly.

Auto-approve never fires for dependency manifest changes, CI/deploy/infra
changes, `.env` schema changes, unresolved verification failures, concept-body
changes, sensitive Tier A paths, or plan-infeasibility escalation.

## Tier A Backstop

Re-check the actual PR diff before merge. Treat matching paths as Tier A until
the project replaces this generic list:

```json
[
  "**/auth/**",
  "**/authorization/**",
  "**/rls/**",
  "**/migrations/**",
  "**/audit_log*",
  "**/redactPaths*",
  "**/auditRedactKeys*",
  "**/server/actions/invoke.*",
  "**/orchestrator/**",
  ".github/workflows/**",
  "Dockerfile*",
  "docker-compose*.yml"
]
```

Tier A requires a non-Coder implementation review or explicit Human waiver.

## Telegram Decisions

Minimize asks and act on routine allowlisted work. When approval is truly
required, ask through the project Telegram decision path; do not leave work
blocked on local harness permission prompts.

Approval is required for destructive git operations, package-manager mutations,
production data/infra changes, secret access, skipping verification, external
posting, and fan-out beyond the configured cap.

## Circuit Breakers

Disable or pause automation and notify the Human when an auto-approved merge is
reverted/marked regretted, consecutive phase or quota failures hit the configured
limit, Telegram notifications fail, or role/separation drift is detected.

## Starter Config

Use [ops/auto_approve.example.json](ops/auto_approve.example.json) as the
starter shape and customize high-risk paths, protected branches, verification
commands, merge policy, Telegram blocker format, and rollback policy.
