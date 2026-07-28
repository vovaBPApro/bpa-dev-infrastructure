# Verification and Regression Locks

- Ship every feature with automated tests for its required behavior, important
  edges, and error paths. Do not ship new production behavior without tests.
- Ship every bug fix with a named regression lock. Prove the lock fails against
  the pre-fix behavior and passes with the fix; a test that only passes after
  the change is not sufficient.
- Run the narrowest meaningful checks plus all applicable build, type, lint,
  integration, and runtime checks before documentation updates. Use the
  repository's declared commands and `gate/` landing mechanisms.
- Preserve the command, result, and fail-before/pass-after evidence in the
  change record. Missing or false evidence is `NO-GO`.

## UI and Visual Locks

For layout, theme, spacing, overflow, typography, interaction, render, or
other visible defects, use a live browser or visual-regression lock against a
running surface. Assert rendered output, post-interaction state, geometry, or
a reviewed visual snapshot as appropriate. A jsdom-only or behavioral-unit
assertion cannot lock a visual defect.

## Reject False Greens

Reject a lock review when it did not execute the lock; did not demonstrate red
before and green after; replaces the regression with a weaker assertion; relies
only on jsdom for a UI defect; ignores timeouts or partial output; tests a mock
instead of the affected boundary; or has stale, unverifiable evidence. Review
the exact change, not a narrative claim.
