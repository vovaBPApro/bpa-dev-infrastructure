# Watchdog recovery round 5 — coder terminal report

candidate: `94a1b4d4fa471c2404f852aa2abfd268640a04cc`

result: `NO-GO`

## Human requirement (verbatim)

> ти міг би так стояти ще пів дня, поки я б не помітив, що ти лежиш.
>
> це ні— неприпустимо у нас.

## Delivered

- Explicit disarm runs before Telegram token configuration checks.
- Canonical system and legacy user disables and all four state queries run
  independently. The exact resolved states are printed, and success requires
  both generations to be `disabled/inactive`.
- Restart-state decimals have pre-arithmetic length and semantic bounds:
  `last_restart=0..9999999999`, `consecutive_failures=0..31`, and
  `alerted=0..1`. Failure count saturates at its accepted bound.
- Missing, placeholder, disable-failure, query-failure, negative, boundary,
  future, and oversized-state behavioral locks are included.

## Evidence

Red-before, using the round-4 candidate source with the round-5 tests in a
disposable archive:

```text
bootstrap-red rc=1
ERROR: disarm omitted independent operation: --user disable --now orch-runtime-watchdog.timer
state-red rc=1
FAIL: [restart-state-malformed-14] start count 0, expected 1
```

Passed:

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
bash -n orchestrator/watchdog.sh orchestrator/install-watchdog.sh orchestrator/launch.sh orchestrator/knobs.sh bootstrap/install.sh bootstrap/bootstrap.test.sh orchestrator/watchdog-supervision.test.sh orchestrator/watchdog-lease-guard.test.sh orchestrator/cadence-knob.test.sh orchestrator/knob-bounds.test.sh
git diff --check
```

`orchestrator/watchdog-supervision.test.sh` passed all shell behavioral rows,
including the new disarm/state locks, then failed only in its final unchanged
real-daemon transport subtest.

Blocking evidence:

```text
bun orchestrator/watchdog-transport-boundary.test.ts
error: timeout waiting for successful send; methods=

cd daemon && bun test watchdog-turnend-a1.test.ts
error: timed out waiting for watchdog placeholder suppression log
error: timed out waiting for watchdog auto-relay
```

The installed Bun is `1.2.22`; the repository declares `1.3.14`. The daemon
opens its loopback health/MCP listener but makes no test Bot API request. The
turn-end run was stopped after the same environmental startup signature
repeated twice.

No live service, session, timer, system unit, credential, or runtime file was
read or changed.

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
commit: 94a1b4d4fa471c2404f852aa2abfd268640a04cc [CODER] make watchdog disarm and restart state bounded
verify: bash bootstrap/bootstrap.test.sh && bash orchestrator/watchdog-supervision.test.sh && bun orchestrator/watchdog-transport-boundary.test.ts && (cd daemon && bun test watchdog-turnend-a1.test.ts)
result: NO-GO
blocker: installed Bun 1.2.22 cannot complete the declared-Bun-1.3.14 real daemon transport/turn-end locks; fresh dual Tier-A review is also still required
secret-scan: clean
remaining: rerun daemon boundaries with Bun 1.3.14, then obtain fresh dual Tier-A review
```
