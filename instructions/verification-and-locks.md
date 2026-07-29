---
id: verification-and-locks
layer: L1
status: binding
audience: all
tags: [verification, regression-lock, testing]
summary: Test, regression-lock, visual-lock, and false-green rules for features and bug fixes.
floor: true
floor-line: Green is fail-closed — never relabel a failure as a warning; missing evidence is `NO-GO`.
---

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

## Decidable report contract — what `result: clean` means

`result: clean` is the binding claim of a completed, verified change. It is
allowed ONLY when every one of these holds:

- the reported SHA is current (`git rev-parse HEAD` matches the reported commit);
- the verification command was actually run at that SHA and exited 0 — not a
  prior run, not a partial run, not inferred;
- every required review/landing evidence artifact for the change's risk tier
  exists (see `review-policy`, `landing-and-merge`);
- `git status --short` shows no unexplained change relevant to the work;
- secret-scan evidence is present (see below).

Anything skipped, partial, stale, timed out, or inferred makes the result
`NO-GO` with a concrete `blocker: <reason>`. A percentage, explanation,
screenshot, heartbeat, or promise is never `clean`.

### Canonical secret-scan command

The secret-scan pattern has ONE home: the `secret_pattern` variable in the
`land_secret_scan()` function of `gate/land-lib.sh` (the same scan the landing
gate runs). Do not copy the pattern text into any other file — a copied literal
both drifts from the gate and trips the gate's own diff scan on itself. Extract
the pattern from the gate at run time and scan the diff against it:

```sh
pat=$(eval "$(sed -n 's/^[[:space:]]*secret_pattern=/REPLY=/p' gate/land-lib.sh)"; printf '%s' "$REPLY")
git diff origin/main...HEAD | LC_ALL=C grep -aE "$pat"   # any output = a hit
```

Any hit blocks the commit or landing until removed and reassessed. If
`gate/land-lib.sh` (or the extracted pattern) is absent or the scan fails to
run, report `secret-scan: NO-GO` (scanner missing) — never write
`secret-scan: clean` from manual inspection alone.

## Reject False Greens

Reject a lock review when it did not execute the lock; did not demonstrate red
before and green after; replaces the regression with a weaker assertion; relies
only on jsdom for a UI defect; ignores timeouts or partial output; tests a mock
instead of the affected boundary; or has stale, unverifiable evidence. Review
the exact change, not a narrative claim.
