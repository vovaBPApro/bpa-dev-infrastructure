# Watchdog recovery fail-closed — coder report

Implementation commit: `683bff0dca63bb0375878093cb2ea5c950239144`

## Instruction consumption

- lane-lifecycle sha256:84d3db25d785 — Lane Lifecycle
- verification-and-locks sha256:b13ed13070c1 — Verification and Regression Locks
- tool-permissions sha256:955630cc416e — Tool Permissions
- repository-hygiene sha256:02acdffe2a56 — Repository Hygiene
- isolated-test-environments sha256:6ffd35d7c9f1 — Isolated Test Environments
- operator-feedback sha256:6dc6f5d4768f — Operator Feedback
- instruction-layers sha256:cd21f4ce0990 — Instruction Layers
- branching-policy sha256:98cd92116325 — Branching Policy
- reproducible-from-git sha256:822d9efe694b — Reproducible From Git

## Result

The canonical bootstrap system watchdog now consumes the launcher's exact
configuration path and is no longer excluded from installation. Arming fails
unless the timer is enabled, active, and reports a finite next trigger, then
starts one immediate recovery tick.

Restart cooldown is recorded only after a proven successful launch. Failed
launches retry on the next timer tick, retain an atomic consecutive-failure
count, and emit a distinct Human `ALERT` after the configured bound. A
configured live tmux session is preserved when lease records contradict it.

## Regression evidence

Red-before was run by extracting `683bff0^`, overlaying only the four changed
test files, and executing them there. All four failed:

- supervision: first failed restart did not retry;
- lease guard: contradictory bookkeeping killed the live session;
- knob bounds: arm accepted a timer with no next trigger;
- cadence/config: installed watchdog did not source the canonical config.

Green-after:

```sh
bash orchestrator/watchdog-supervision.test.sh &&
bash orchestrator/watchdog-lease-guard.test.sh &&
bash orchestrator/knob-bounds.test.sh &&
bash orchestrator/cadence-knob.test.sh &&
bash -n orchestrator/watchdog.sh orchestrator/install-watchdog.sh bootstrap/install.sh &&
git diff --check
```

Exit 0 at `683bff0dca63bb0375878093cb2ea5c950239144`.

Canonical secret scan over the working diff and `origin/main...HEAD`: clean.

## NO-GO boundary

No live daemon, orchestrator tmux session, shared watchdog, or system unit was
stopped or restarted. Shared-host runtime rehearsal remains `NO-GO` until W-37
lands and an announced maintenance boundary is ready. Tier A independent
operations/runtime and regression review is still required before landing.
