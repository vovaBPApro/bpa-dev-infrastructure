# Planning and Specifications

Write each plan or specification so a fresh agent can implement it using only
the repository and the artifact. Keep one component or feature per artifact;
put future work in a separate backlog or concept.

## Required Content

- **Context and goal:** state the problem, outcome, system stage, and strict
  scope boundaries.
- **Breaking changes:** state `Yes` or `No`. For `Yes`, name affected users or
  interfaces, required actions, migration or recovery, and rollback posture.
- **Interfaces first:** define inputs, outputs, data shapes, ownership, and
  integration boundaries before implementation steps. Include concrete examples
  where a contract is non-obvious.
- **Configuration and dependencies:** name required and optional configuration,
  defaults, validation, external services/APIs, authentication boundaries, and
  failure behavior. Do not assume unavailable dependencies.
- **Steps and risks:** give ordered, bounded implementation steps, reference
  existing patterns when useful, and name assumptions, non-obvious edge cases,
  errors, constraints, and stop points.
- **Acceptance and verification:** express observable acceptance criteria that
  map to automated tests; include happy paths, edge/error cases, integration
  boundaries, exact commands, and expected outcomes.
- **Review record:** reserve a durable section for findings, resolutions, and
  explicit non-actions.

Prefer clear English and testable statements over prose about routine patterns.
Describe what must hold, then only the implementation detail an agent cannot
infer. Do not smuggle speculative features into an implementation plan.
