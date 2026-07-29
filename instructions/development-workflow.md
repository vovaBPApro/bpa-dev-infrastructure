---
id: development-workflow
layer: L1
status: binding
audience: all
tags: [workflow, verification]
summary: Lifecycle, scope control, verification, and documentation truth.
---

# Development Workflow

Use this lifecycle for every change:

`Discussion -> Plan -> Review -> Approval -> Implementation -> Verification -> Doc Update -> Archive`

## Control Rules

- Start in Discussion. Explore the repository, clarify intent, and record
  uncertainty; do not implement during Discussion without explicit Human
  approval.
- Treat concepts as Human-initiated containers for multi-plan or unresolved
  direction. Record their decisions, boundaries, plan breakdown, dependencies,
  and closeout state. A concept is not executable.
- Treat breaking change as the default. Do not add compatibility or migration
  behavior unless the approved plan explicitly requires it.
- Implement only approved scope. Put unrelated findings in the relevant
  backlog or defect artifact; do not fold them into the current change.
- If a plan becomes infeasible or materially changes, stop and return it to
  Discussion. Do not improvise around an approved decision.
- Obtain Human approval before changing dependencies, manifests, or lockfiles.
- Verify implementation before updating explanatory or operational docs. State
  intended doc changes, then update and archive the completed plan or concept.

## Truth Triangle

Keep code, intended behavior documentation, and known limitations consistent.
Code describes what runs; documentation describes what should run; limitations
describe conscious deviations. Flag any undocumented disagreement as drift and
route it to the Human or a tracked defect. When intent is ambiguous, preserve
documented intent rather than silently inventing behavior.

## Evidence

Record the approved artifact, verification commands and results, and archive
location. A failed, missing, stale, or unverifiable check is `NO-GO`; follow the
repository evidence and landing gates in `gate/`.
