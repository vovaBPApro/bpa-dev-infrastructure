# Watchdog recovery round 6 — coder terminal report

candidate: `446ca0776ac02a98ffe79b9b682a4994911dbd06`

result: `NO-GO`

## Human requirement (verbatim)

> ти міг би так стояти ще пів дня, поки я б не помітив, що ти лежиш.
>
> це ні— неприпустимо у нас.

## Delivered

- Exact, unique `TELEGRAM_BOT_TOKEN` parsing rejects missing, empty, whitespace,
  malformed, quoted/exported, duplicate, placeholder, and invalid token values.
- Explicit disarm remains ahead of the token gate; invalid-token arm attempts
  return non-zero without activation or immediate-service calls.
- All six disarm failure rows assert both disables, all four queries, the exact
  complete terminal tuple, non-zero status, and absence of false success.
- The executable `MUTATION-RED` loop corrupts each system/legacy tuple and proves
  the exact-line oracle rejects it.
- Restart-state locks cover accepted maxima, adjacent rejected values, and
  overflow-sized `consecutive_failures` and positive-failure `alerted` values.

## Evidence

Passed at candidate SHA:

```text
bash bootstrap/bootstrap.test.sh
ORCH_SKIP_TRUST_CHECK=1 bash orchestrator/singleton-failclosed.test.sh
bash orchestrator/watchdog.test.sh
bash orchestrator/watchdog-lease-guard.test.sh
bash orchestrator/knob-bounds.test.sh
bash orchestrator/cadence-knob.test.sh
bash orchestrator/heartbeat-liveness.test.sh
bash bootstrap/deployed-drift.test.sh
bun test core/state.test.ts
bash orchestrator/telegram-daemon-mcp.test.sh
bash -n bootstrap/install.sh bootstrap/bootstrap.test.sh orchestrator/watchdog.sh orchestrator/watchdog-supervision.test.sh
git diff --check
```

The full supervision suite passed its shell rows, then the unchanged real
transport boundary failed:

```text
bash orchestrator/watchdog-supervision.test.sh
error: timeout waiting for successful send; methods=
Bun v1.2.22 (Linux x64)
```

The repository declares Bun 1.3.14. No live service, session, timer, system
unit, credential, or runtime file was read or changed. Fresh dual Tier-A review
is not yet present and remains mandatory.

## Manifest consumption check

```text
lane-lifecycle sha256:84d3db25d785 # Lane Lifecycle
verification-and-locks sha256:b13ed13070c1 # Verification and Regression Locks
tool-permissions sha256:955630cc416e # Tool Permissions
repository-hygiene sha256:02acdffe2a56 # Repository Hygiene
isolated-test-environments sha256:6ffd35d7c9f1 # Isolated Test Environments
operator-feedback sha256:6dc6f5d4768f # Operator Feedback
instruction-layers sha256:cd21f4ce0990 # Instruction Layers
branching-policy sha256:98cd92116325 # Branching Policy
reproducible-from-git sha256:822d9efe694b # Reproducible From Git
```

## Terminal contract

```text
commit: 446ca0776ac02a98ffe79b9b682a4994911dbd06 [CODER] lock watchdog recovery exact boundaries
verify: bash bootstrap/bootstrap.test.sh && bash orchestrator/watchdog-supervision.test.sh && bun orchestrator/watchdog-transport-boundary.test.ts && (cd daemon && bun test watchdog-turnend-a1.test.ts)
result: NO-GO
blocker: installed Bun 1.2.22 times out in the required real daemon transport boundary; fresh dual Tier-A review is also absent
secret-scan: clean
remaining: rerun real transport and turn-end on declared Bun 1.3.14, then obtain fresh dual Tier-A review
```
