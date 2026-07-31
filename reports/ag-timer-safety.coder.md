# Nightly timer safety coder report

commit: 719941ebdbb3f4c705cb4a0f8bbeb4a1f597eb03 [CODER] isolate nightly suite from live state
verify: bash orchestrator/full-suite.test.sh && bash bootstrap/bootstrap.test.sh && systemd-analyze verify /etc/systemd/system/bpa-full-suite.service /etc/systemd/system/orch-morning-report.service
result: NO-GO
blocker: the timer-equivalent host full suite returned 1; the fix is not landed in the canonical install root, so bpa-full-suite.timer remains DISABLED
secret-scan: clean
remaining: independent risky-path review, landing with ag-orch-unit-drift coordination, canonical install-root update, then a green timer-equivalent suite before re-enabling

## Isolation evidence

The regression lock starts the runner with live-looking `ORCH_HEARTBEAT_FILE`,
`ORCH_STATE_DB`, and an unknown future `ORCH_FUTURE_STATE_POINTER`. The fixed
runner executes every suite under `env -i` in a disposable copy with scratch
HOME, TMPDIR, runtime, state DB, and install root. This is a complete namespace
boundary rather than a hand-maintained subset. The lock failed with the
`origin/main` runner (exit 1) and passed with the implementation (exit 0).

The timer-equivalent host run captured MD5 before and checked it afterward.
These required live files were byte-identical:

- `runtime/state.db`
- `runtime/orchestrator.singleton.lock`
- `orchestrator/runtime/orchestrator.lease`
- `orchestrator/runtime/orchestrator.heartbeat`
- `orchestrator/runtime/launch.lock`

The additional `orchestrator.liveness` probe changed while the live
orchestrator's independent pulse was running, so it is not claimed as an MD5
proof. Its suite-side path is nevertheless isolated by the empty inherited
environment and scratch checkout. The host suite itself returned 1, so this is
not green runtime evidence and the full-suite timer was not re-enabled.

## Units and morning audit

Both tracked service templates now use optional `EnvironmentFile=-$ENV_FILE`.
Only these two deployed units were rendered, systemd reloaded, and
`systemd-analyze verify` passed. The full-suite timer is `disabled`; the morning
timer is `enabled`.

`morning.sh` does not launch or supervise the orchestrator. It reads mission and
suite readiness, performs a namespaced stand smoke, and atomically publishes
only its report outbox/watermark after all checks pass. Its live service reached
the readiness checks without the missing env file and then exited 1 rather than
publishing a false-green report. Leaving this timer enabled is the correct
fail-closed judgement.

The `ag-orch-unit-drift` branch was inspected. This lane did not edit
`bootstrap/check-unit-drift.sh` or its reconciliation paths, avoiding the named
clobber; landing must serialize the two branches.

## Manifest consumption

```text
lane-lifecycle 84d3db25d785 — Lane Lifecycle
verification-and-locks b13ed13070c1 — Verification and Regression Locks
tool-permissions 955630cc416e — Tool Permissions
repository-hygiene 02acdffe2a56 — Repository Hygiene
isolated-test-environments 6ffd35d7c9f1 — Isolated Test Environments
operator-feedback f2af762572ae — Operator Feedback
instruction-layers cd21f4ce0990 — Instruction Layers
branching-policy 98cd92116325 — Branching Policy
reproducible-from-git 822d9efe694b — Reproducible From Git
```
