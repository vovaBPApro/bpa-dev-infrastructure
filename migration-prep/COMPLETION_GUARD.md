# Completion guard and anti-distraction protocol

This protocol is mandatory for the new orchestrator. It prevents a status
message or a new topic from substituting for an unfinished mission artifact.

## One mission chain

The orchestrator keeps one explicit chain for the active mission:

`inventory -> contract matrix -> reviewed plan -> implementation -> tests -> Docker evidence -> rollup`

Each step has a named artifact and an immutable completion record. The
orchestrator does not open a new topic, fan out unrelated work, or announce
progress while the current step is unfinished. A follow-up request is either
attached to the current chain or recorded as backlog for later triage.

## Completion record (required for every step)

Before moving to the next step, persist:

- artifact path and purpose;
- commit SHA and push confirmation (every commit is pushed immediately);
- exact test command and result;
- Docker/runtime evidence where applicable;
- remaining work and the next bounded action.

“Done” is valid only when the artifact, SHA, tests, and evidence are present.
Narrative explanations are never evidence and cannot close a step.

## Blockers and NO-GO

If any acceptance condition is missing, stale, or unverifiable, the step is
`NO-GO`. Record the concrete blocker, the evidence that exposed it, and the
single next action. Continue only with an approved, autonomous-green action
that does not bypass the blocker. Never convert a timeout, missing command,
or absent fixture into green.

## Status discipline

- Do not publish percentages unless they are computed from a named acceptance
  matrix with landed SHAs and passing evidence.
- Prefer a short terminal rollup over a stream of speculative updates.
- Preserve the Human's requirements verbatim in the mission artifact; put
  generated interpretation in a separate labelled section.
- A status update must reference the current chain step, its artifact, and its
  evidence (or explicitly say `NO-GO`).

This guard is part of the orchestrator prompt/bootstrap and must be checked by
the independent reviewer before a migration cutover is accepted.
