# Watchdog recovery round 4 — coder terminal report

candidate: `dbd4c56d3fa26f4cfdba4d064f952508000f082a`

result: `NO-GO`

## Human requirement (verbatim)

> ти міг би так стояти ще пів дня, поки я б не помітив, що ти лежиш.
>
> це ні— неприпустимо у нас.

## Delivered

- Restart state is one locked, versioned, exact four-field schema. Missing,
  duplicate, malformed, truncated, extra, inconsistent, future, and
  incompatible records reset as a whole and recover immediately.
- Launcher restart failure now propagates non-zero while preserving bounded
  retry state, durable alerting, deduplication, and later-tick recovery.
- Explicit disarm disables and strictly proves both timer generations.
- Arm/migration, finite-trigger validation, immediate recovery, rollback, and
  restoration of a previously armed legacy generation are one fail-closed
  transaction.
- Timer fakes reject unknown commands and model terminal enabled/active state.

## Evidence

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

`orchestrator/watchdog-supervision.test.sh` passed every shell behavioral row,
including all new strict-state cases and recovery-failure propagation, before
reaching its final real daemon transport subtest.

Blocking evidence:

```text
bun orchestrator/watchdog-transport-boundary.test.ts
```

On installed Bun `1.2.22`, the spawned daemon opened MCP/health listeners but
made no Bot API request and timed out after eight seconds
(`methods=`). The repository installer declares Bun `1.3.14`; the earlier
independent review passed this same unchanged transport lock on its compatible
host.

```text
cd daemon && bun test watchdog-turnend-a1.test.ts
```

The first two cases repeated the same daemon-startup failure
(`watchdog placeholder suppression log`, then `watchdog auto-relay` timeout);
the run was terminated after the repeated environmental signature rather than
spending the full multi-minute suite budget.

No live service, session, timer, system unit, or credential was read or changed.

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
commit: dbd4c56d3fa26f4cfdba4d064f952508000f082a [CODER] make watchdog recovery transactions strict
verify: bash bootstrap/bootstrap.test.sh && bash orchestrator/watchdog-supervision.test.sh && bun orchestrator/watchdog-transport-boundary.test.ts && (cd daemon && bun test watchdog-turnend-a1.test.ts)
result: NO-GO
blocker: installed Bun 1.2.22 cannot start the real daemon transport/turn-end boundary; declared Bun 1.3.14 rerun and dual Tier-A rereview remain required
secret-scan: clean
remaining: rerun the two daemon boundaries on Bun 1.3.14, then obtain dual Tier-A rereview
```
