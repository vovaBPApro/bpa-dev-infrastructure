# Watchdog recovery round 2 — coder report

Implementation commit: `d4aface4621fb7018ed84d45d8dfe2ec9bc4ccdb`

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

## Disposition

All ten round-2 findings are implemented. Positively proven live displacement
stops only the configured stale session while preserving the current holder.
Unreadable, contradictory, expired-self, dead-holder, and unverifiable-holder
cases remain no-kill. Lease renewal tests use an injected logical clock across
four exact ticks.

Fresh bootstrap renders the real system units inert, explicitly retires or
refuses an unverifiable armed legacy user timer, proves enabled/active/future
system state, runs one immediate tick, and rolls back a failed arm. Explicit
disarm disables both timer generations while retaining rendered units.

The shared finite-trigger parser accepts only a strict future UTC timestamp
from the explicit `NextElapseUSecRealtime` property. Backoff doubles from the
timer cadence to a cap, alerts once, serializes concurrent ticks, atomically
writes state, resets corrupt/future state, and clears every escalation field
after success. Production launcher and watchdog identity resolvers are executed
against one EnvironmentFile. A separate Bun consumer drains the exact watchdog
outbox and routes the loud alert while the orchestrator session is absent.
`instructions/restart-recovery.md` records the simultaneous daemon-failure
boundary.

## Red-before

The four original red-before locks remain named and executable. The prior
independent review recorded their behavior on the pre-fix base: failed recovery
did not retry, live displacement killed/preserved the wrong actor, empty next
trigger was accepted, and config identity was only statically checked.

The round-2 tests were overlaid onto candidate
`2b7ce843665b2045a9ccc0294f3ab34275c7f922` without production changes:

```text
watchdog-supervision.test.sh: exit 1 — fourth immediate restart exceeded bounded schedule
watchdog-lease-guard.test.sh: exit 1 — genuine displacement did not stop stale session
knob-bounds.test.sh: exit 1 — infinity accepted as a finite trigger
cadence-knob.test.sh: exit 2 — production launcher lacked behavioral identity resolution
bootstrap/bootstrap.test.sh: exit 1 — canonical system arm/migration/rollback contract absent
```

Each reached its production boundary; none was a missing-module or permissive
fake result.

## Green-after

```sh
bash orchestrator/watchdog.test.sh &&
bash orchestrator/watchdog-supervision.test.sh &&
bash orchestrator/watchdog-lease-guard.test.sh &&
bash orchestrator/knob-bounds.test.sh &&
bash orchestrator/cadence-knob.test.sh &&
bash orchestrator/heartbeat-liveness.test.sh &&
bash bootstrap/bootstrap.test.sh &&
bash bootstrap/deployed-drift.test.sh &&
bun test core/state.test.ts &&
bash -n orchestrator/watchdog.sh orchestrator/install-watchdog.sh orchestrator/launch.sh orchestrator/knobs.sh bootstrap/install.sh bootstrap/bootstrap.test.sh &&
git diff --check
```

Exit 0 at the implementation commit. Canonical secret scan: clean.

An extra execution of the pre-existing `orchestrator/singleton-failclosed.test.sh`
is red because its second fixture session reaches `can't find pane` instead of
the expected singleton refusal. This is outside the round-2 changed behavior
but is retained as visible evidence rather than relabelled green.

## Terminal contract

commit: d4aface4621fb7018ed84d45d8dfe2ec9bc4ccdb [CODER] harden watchdog recovery and system arming
verify: command under Green-after
result: NO-GO
blocker: Tier A independent operations/runtime and regression reviews remain required; the unrelated singleton fixture is also red as recorded above
secret-scan: clean
remaining: dual Tier A review, then landing gate
