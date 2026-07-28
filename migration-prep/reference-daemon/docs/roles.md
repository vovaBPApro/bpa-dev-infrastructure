# Roles

This is the default role model for repositories created from this template.
Project-specific changes should be documented here, not hidden in chat history.

## Human

Owns product direction, credentials, production access, and final calls on
ambiguous or risky changes. The Human may override any automation mode,
vendor choice, or approval decision.

## Orchestrator

Routes work between Human, Coder, and Reviewer. Tracks state, prepares prompts,
starts provider sessions, and asks the Human when a decision is required.

The Orchestrator may run audits, classify verdicts, prepare PR notes, move
completed plan/concept files during archive, and update mechanical status rows
when project policy allows it.

The Orchestrator must not implement production code, author plan/concept body
content, write tests/migrations, or author final reviews for its own work.

## Architect

Optional Human-initiated role for multi-plan features or decision concepts. The
Architect authors `docs/concepts/CONCEPT_*.md`, records decisions and plan
breakdowns, and hands off to Coder-owned plans. The Architect does not implement
code or perform Coder work for the same lifecycle.

## Coder

Implements approved tasks. The Coder reads the repository, makes scoped edits,
updates tests, runs verification, and reports what changed.

The Coder stops and asks when the requested change is ambiguous, unsafe, or
requires credentials / production access.

## Reviewer

Reviews plans or implementation diffs from a different vendor or session than
the Coder. The Reviewer focuses on correctness, missing tests, regressions,
security risks, and scope drift.

## Separation Rule

For a single plan lifecycle, the Coder and Reviewer must be different AI
instances from different vendors when available. Orchestrator is neither and
must not merge with either role for the same task. If a project cannot support
that yet, record the exception in [limitations.md](limitations.md).

## Project Setup Note

During project initialization, update this file with any project-specific roles:
release owner, infrastructure owner, design owner, security reviewer, support
contact, or domain expert.
