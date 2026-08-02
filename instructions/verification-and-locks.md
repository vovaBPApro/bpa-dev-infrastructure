---
id: verification-and-locks
layer: L1
status: binding
audience: all
tags: [verification, regression-lock, testing]
summary: Test, regression-lock, visual-lock, and false-green rules for features and bug fixes.
floor: true
floor-line: Green is fail-closed — failure, missing evidence, and unmeasured subjects are never pass.
---

# Verification and Regression Locks

## Infrastructure verification is the highest bar

Infrastructure changes use the repository's highest available verification
level. The landing path must inventory every applicable suite from tracked
repository files; a coder-selected command list and files visible only in an
ignored worktree are not an authoritative inventory. Every change is reverified
at the landed integration boundary.

A missing, skipped, flaky, timed-out, partial, or unverifiable result is
`NO-GO`, never clean. Runtime is not authority to omit coverage: make slow
suites hermetic, isolated, parallel, or otherwise faster without weakening the
required behavior. Runtime-dependent suites use disposable stands and retain
teardown and rollback evidence.

## Unmeasured is failed

Source (`instance/decisions/HR-1439.md`, Human words verbatim):

> Може нам це правило, невиміряне равнопровал, розповсюдити і більш якось ширше використовувати?

Any automated gate, status surface, health ping, or claim that cannot externally
measure its subject must report that subject as `UNMEASURED` and fail closed.
Reporting pass or green for an unmeasured subject is a defect. Skips exist only
as tracked, reasoned, grep-able markers that name their arming condition; a skip
must remain visibly a skip and is never counted as a pass.

This rule originated on 2026-08-02 when meteorite-gate review 7b found a gate
reporting pass for subjects it had not measured.

Changes to the evidence gate require independent Tier-A review. Preserve
fail-before evidence for every regression class the gate previously omitted,
including launcher regressions, and prove the final mechanism from a clean
clone with exact pre-merge and post-merge verification evidence.

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

The landing scan also extracts bounded base64-like runs from each changed
file's added content, decodes valid candidates, and applies that same signature
pattern to the decoded text. This is a signature scan, not a generic secret
detector: secrets split across lines or assembled through string concatenation
remain outside its boundary. Generic Shannon-entropy scanning is deliberately
excluded because its gate-level false-positive rate is not acceptable.

## Reject False Greens

Reject a lock review when it did not execute the lock; did not demonstrate red
before and green after; replaces the regression with a weaker assertion; relies
only on jsdom for a UI defect; ignores timeouts or partial output; tests a mock
instead of the affected boundary; or has stale, unverifiable evidence. Review
the exact change, not a narrative claim.
