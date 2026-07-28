# Review Policy

Default §3 Review policy for projects created from this template.

## Review Goal

Reviewers check plans before implementation and, for high-risk diffs, check the
actual implementation before merge. A review is a technical risk pass over
correctness, completeness, and quality.

## Plan Review Levels

- **Correctness** — consistent with the codebase, [definition.md](definition.md),
  [architektur.md](architektur.md), [limitations.md](limitations.md), and the
  plan's breaking-change posture.
- **Completeness** — implementable by a fresh AI instance with only the repo and
  docs; required sections from [development_workflow.md](development_workflow.md)
  §4, dependencies, and `BREAK` markers are clear.
- **Quality** — simpler or safer approach available; security, isolation,
  durability, auditability, and regression coverage fit the scope.

Every remark must have a technical justification.

## Required Alternation

For every formal plan lifecycle:

- Minimum: **two** review rounds.
- Maximum: **four** review rounds before Human escalation.
- Reviewer pool: `{Anthropic, OpenAI, Google} - {Coder vendor}`.
- The first two rounds should use both eligible non-Coder vendors when the CLIs
  are available.
- The Coder must incorporate each remark or justify why it is not being applied.

If a project temporarily has only two installed vendors, record that limitation
in [limitations.md](limitations.md) and preserve Coder/Reviewer separation.

## Packet Naming

Review scripts write working packets under `docs/review_packets/`. Treat that
directory as a local/generated artifact area. The durable record belongs in the
plan's Reviewer Section: verdicts, accepted changes, and any justified
non-actions.

```text
docs/review_packets/REVIEW_<plan-id>.R1.md
docs/review_packets/REVIEW_<plan-id>.R2.md
docs/review_packets/REVIEW_IMPL_<plan-or-branch>.R1.md
```

Do not create a parallel `docs/REVIEWS`, `docs/review_packets_archive`, or
ad-hoc review folder.

## Required Checks

- The plan matches [definition.md](definition.md).
- The plan matches [architektur.md](architektur.md).
- Known limits in [limitations.md](limitations.md) are respected.
- Referenced files, APIs, tables, commands, and scripts exist on disk.
- The implementation path is specific enough for a fresh Coder.
- Tests cover happy paths, edge cases, and error paths.
- Breaking changes and migration steps are explicit.
- Open questions are either answered or routed to the Human.

## Implementation Review

After the verification gate and before doc update, classify the PR:

- **Tier A** — schema/migrations, auth, authorization, tenant isolation,
  audit/PII/redaction, money, production infrastructure, or orchestration
  framework surfaces. Run one non-Coder implementation review.
- **Tier B** — docs-only, tests-only, small bug fixes, UI-only changes without
  action-layer impact, or copy/config changes without runtime semantics.

## Verdicts

Use exactly one: `APPROVE`, `APPROVE_WITH_NITS`, `REVISE`, or `BLOCK`.
