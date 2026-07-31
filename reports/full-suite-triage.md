# Full-suite failure triage

Date: 2026-07-31
Baseline: `6e2f43f20cd2751cbe6b2425f195ec3e661d5439`
Command: `bun test`
Result: `470 pass, 3 fail, 0 skip` across 473 tests in 45 files (372.49 s).

## Evidence limitation

The dispatch reported `45 passed, 50 failed, 4 skipped`, but neither the
individual failure output nor a durable log containing those 50 failures is
present in this checkout. The current baseline therefore cannot honestly assign
names to all 50 historical rows. The rerun disproves the old aggregate as a
description of the current checkout: 47 of the 50 reported failures are no
longer reproducible, but their individual disposition remains **unverifiable
from missing historical evidence**, not "fixed". The three reproducible rows
below are the complete current failure set.

This missing per-failure evidence is itself a gate defect: a full-suite result
must retain the failing test names and output at a durable evidence path before
it can be handed to another lane for per-row triage.

## Current per-failure disposition

| Failure | Category | Evidence and disposition |
| --- | --- | --- |
| `transcribes a Ukrainian sample to Cyrillic text (forced -l uk; see fixture note)` | broken-by-environment | The real local Whisper invocation returned `{ ok: false }` after 180.412 s. The preceding English real-engine case passed after 142.571 s. The Ukrainian case reaches the configured 180 s transcription timeout on this host; the assertion hides the returned reason. Keep red until the isolated suite supplies an explicit tested resource/timeout contract and reports the failure reason. |
| `CLI reports FLEET-IDLE not applicable without positive orchestrator runtime evidence` | obsolete check | The expected `NOT-APPLICABLE FLEET-IDLE` line is emitted. The test incorrectly requires the entire repository state-contract CLI to exit 0, so five unrelated, legitimate contract failures make this focused assertion fail. It must assert the FLEET-IDLE finding without weakening or hiding the other CLI failures. |
| `this repository passes its own state contract` | real defect | The repository self-sweep reports five undeclared or ownership-mismatched durable artifacts. Keep red; register/fix each contract separately as listed below. |

## State-contract defect disposition

| Finding | Category | Required disposition |
| --- | --- | --- |
| `unit-drift-exemptions.tsv` referenced by `bootstrap/check-unit-drift.sh`, `bootstrap/install.sh` | real defect | Declare its durable path, writer, and readers in the registry, then retain the self-sweep lock. |
| `messages-VAR.jsonl` referenced by `daemon/history-logger.ts` | real defect | Correct interpolation normalization so dated history files map to their declared artifact, or correct the registry if the dated files are a distinct contract. |
| `record.json` referenced by `preview/preview.ts` | real defect | Declare the preview record's ownership and retention contract. |
| `state.db` referenced by `orchestrator/full-suite.sh` | real defect | Declare the full-suite runner as a writer of its isolated scratch state DB; do not classify it as live runtime state. |
| `inbox.jsonl` referenced by `daemon/server.ts` | real defect | Reconcile the server reader with the existing inbox artifact declaration. |

## Historical category reconciliation

The dispatch grouped the old failures into baseline/runtime-state checks,
missing isolated daemon dependencies, soak disk delta, and state-contract
checks. On the current SHA:

- baseline/runtime-state and missing isolated daemon dependency failures do not
  reproduce in the TypeScript suite;
- no soak disk-delta failure reproduces in the TypeScript suite;
- state-contract checks reproduce as the two test rows and five concrete
  findings above;
- the Ukrainian real-engine failure is a current environment/resource-boundary
  failure not called out in the old aggregate.

No row is skipped, weakened, or relabelled green by this report.

## After remediation

Verified at `af78f866ab1a40554332979475337c5f62a876dc`:

- `bun test`: `473 pass, 0 fail, 0 skip` across 45 files (83.62 s);
- `bash orchestrator/full-suite.test.sh`: PASS;
- `bash orchestrator/full-suite-envrobust.test.sh`: PASS;
- `bash orchestrator/full-suite-freshness.test.sh`: PASS.

The state-contract registry now declares all five observed accesses and its
self-sweep passes. The FLEET-IDLE test asserts its focused NOT-APPLICABLE result
without treating unrelated CLI failures as a failure of that result. The
Ukrainian real-engine test retains the real model and Cyrillic assertions, but
uses an explicit 300 s test-only resource budget; the production 180 s timeout
is unchanged. Its fail-before duration was 180.412 s and its focused pass-after
duration was 47.60 s, consistent with transient full-suite resource contention
rather than a missing dependency.

## Context pack consumption check

- `lane-lifecycle` `sha256:84d3db25d785` — Lane Lifecycle
- `verification-and-locks` `sha256:b13ed13070c1` — Verification and Regression Locks
- `tool-permissions` `sha256:955630cc416e` — Tool Permissions
- `repository-hygiene` `sha256:02acdffe2a56` — Repository Hygiene
- `isolated-test-environments` `sha256:6ffd35d7c9f1` — Isolated Test Environments
- `operator-feedback` `sha256:f2af762572ae` — Operator Feedback
- `instruction-layers` `sha256:cd21f4ce0990` — Instruction Layers
- `branching-policy` `sha256:98cd92116325` — Branching Policy
- `reproducible-from-git` `sha256:822d9efe694b` — Reproducible From Git
